import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOT_HEALTH_FILE_NAME, CRASH_LOOP_THRESHOLD, bootHealthPath,
  decideRecovery, readBootHealth, recordBootFailure, recordBootSuccess,
} from '../src/boot-health.ts'

const homes: string[] = []

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-boot-health-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

describe('boot health ledger', () => {
  it('treats an absent ledger as no prior outcome', async () => {
    const home = await tempHome()
    expect(readBootHealth(home)).toBeUndefined()
  })

  it('treats a corrupt or shape-invalid ledger as absent', async () => {
    const home = await tempHome()
    await mkdir(home, { recursive: true })
    await writeFile(join(home, BOOT_HEALTH_FILE_NAME), 'not json')
    expect(readBootHealth(home)).toBeUndefined()
    await writeFile(join(home, BOOT_HEALTH_FILE_NAME), JSON.stringify({ consecutiveFailures: 'many' }))
    expect(readBootHealth(home)).toBeUndefined()
  })

  it('records a successful boot by clearing the streak', async () => {
    const home = await tempHome()
    const when = new Date('2026-01-01T00:00:00.000Z')
    recordBootSuccess(home, when)
    expect(readBootHealth(home)).toEqual({ consecutiveFailures: 0, lastAttemptAt: when.toISOString() })
  })

  it('records failures, accumulating the streak and the implicated ids', async () => {
    const home = await tempHome()
    const first = new Date('2026-01-01T00:00:00.000Z')
    const second = new Date('2026-01-01T00:01:00.000Z')
    recordBootFailure(home, 'boom a', ['a'], first)
    recordBootFailure(home, 'boom b', ['b'], second)
    expect(readBootHealth(home)).toEqual({
      consecutiveFailures: 2,
      lastAttemptAt: second.toISOString(),
      lastFailure: 'boom b',
      failedEntryIds: ['b'],
    })
  })

  it('resets the streak and detail on the next success', async () => {
    const home = await tempHome()
    recordBootFailure(home, 'boom', ['a'])
    const when = new Date('2026-01-01T00:02:00.000Z')
    recordBootSuccess(home, when)
    expect(readBootHealth(home)).toEqual({ consecutiveFailures: 0, lastAttemptAt: when.toISOString() })
  })

  it('never throws when the ledger cannot be written (fail-soft)', async () => {
    const home = await tempHome()
    const blocker = join(home, 'blocker')
    await writeFile(blocker, 'x') // a regular file: any subdirectory under it cannot be created
    const blockedHome = join(blocker, 'sub')
    expect(() => { recordBootSuccess(blockedHome) }).not.toThrow()
    expect(() => { recordBootFailure(blockedHome, 'boom', ['a']) }).not.toThrow()
  })
})

describe('recovery decision', () => {
  it('does not recover when the ledger is absent', () => {
    expect(decideRecovery(undefined)).toEqual({ recovering: false, disableEntryIds: [], summary: '' })
  })

  it('defaults to the documented crash-loop threshold', () => {
    expect(decideRecovery({ consecutiveFailures: CRASH_LOOP_THRESHOLD - 1, lastAttemptAt: 'x' }).recovering).toBe(false)
    expect(decideRecovery({ consecutiveFailures: CRASH_LOOP_THRESHOLD, lastAttemptAt: 'x' }).recovering).toBe(true)
  })

  it('honors a custom threshold', () => {
    const ledger = { consecutiveFailures: 1, lastAttemptAt: 'x' }
    expect(decideRecovery(ledger, 1).recovering).toBe(true)
    expect(decideRecovery(ledger, 2).recovering).toBe(false)
  })

  it('recovers at the threshold, disabling the implicated ids and quoting the failure', () => {
    const decision = decideRecovery({
      consecutiveFailures: 2,
      lastAttemptAt: 'x',
      lastFailure: 'plugin tree failed to load: a, b',
      failedEntryIds: ['a', 'b'],
    })
    expect(decision.recovering).toBe(true)
    expect(decision.disableEntryIds).toEqual(['a', 'b'])
    expect(decision.summary).toContain('2 times in a row')
    expect(decision.summary).toContain('a, b')
    expect(decision.summary).toContain('plugin tree failed to load: a, b')
    expect(decision.summary).toContain('recovery mode')
  })

  it('recovers without disabling anything when no ids were determined', () => {
    const decision = decideRecovery({ consecutiveFailures: 2, lastAttemptAt: 'x', lastFailure: 'boom' })
    expect(decision.recovering).toBe(true)
    expect(decision.disableEntryIds).toEqual([])
    expect(decision.summary).toContain('no specific entry could be determined')
  })
})

describe('bootHealthPath', () => {
  it('joins the ledger file under the home', () => {
    expect(bootHealthPath('/x/home')).toBe(join('/x/home', BOOT_HEALTH_FILE_NAME))
  })
})
