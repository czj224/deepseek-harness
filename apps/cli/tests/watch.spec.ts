import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supervise, type ExitOutcome, type SupervisedProcess } from '../src/watch.ts'

/** A fake child whose exit the test resolves on demand, recording kill signals. */
interface FakeChild extends SupervisedProcess {
  resolve(outcome: ExitOutcome): void
  readonly killed: NodeJS.Signals[]
}

function makeChild(): FakeChild {
  let resolve!: (outcome: ExitOutcome) => void
  const exited = new Promise<ExitOutcome>((res) => { resolve = res })
  const killed: NodeJS.Signals[] = []
  return {
    exited,
    resolve,
    killed,
    kill: (signal = 'SIGTERM') => { killed.push(signal) },
  }
}

/** Launch a fresh fake child each time, recording every launch. */
function harness(): { children: FakeChild[]; launch: () => FakeChild } {
  const children: FakeChild[] = []
  const launch = (): FakeChild => {
    const child = makeChild()
    children.push(child)
    return child
  }
  return { children, launch }
}

describe('supervise', () => {
  it('relaunches a crashing child until it exits cleanly', async () => {
    const { children, launch } = harness()
    const run = supervise(launch, { restartDelayMs: 0 })
    children[0]!.resolve({ code: 1, signal: null })
    await vi.waitFor(() => { expect(children).toHaveLength(2) })
    children[1]!.resolve({ code: 0, signal: null })
    await run
  })

  it('stops on a graceful exit without relaunching', async () => {
    const { children, launch } = harness()
    const run = supervise(launch, { restartDelayMs: 0 })
    children[0]!.resolve({ code: 0, signal: null })
    await run
    expect(children).toHaveLength(1)
  })

  it('relaunches when the child is killed by a signal', async () => {
    const { children, launch } = harness()
    const run = supervise(launch, { restartDelayMs: 0 })
    children[0]!.resolve({ code: null, signal: 'SIGKILL' })
    await vi.waitFor(() => { expect(children).toHaveLength(2) })
    children[1]!.resolve({ code: 0, signal: null })
    await run
  })

  it('keeps relaunching while the child keeps crashing, until the stop signal aborts', async () => {
    const controller = new AbortController()
    const { children, launch } = harness()
    const run = supervise(launch, { restartDelayMs: 0, signal: controller.signal })
    children[0]!.resolve({ code: 1, signal: null })
    await vi.waitFor(() => { expect(children).toHaveLength(2) })
    children[1]!.resolve({ code: 1, signal: null })
    await vi.waitFor(() => { expect(children).toHaveLength(3) })
    controller.abort()
    await run
    expect(children).toHaveLength(3)
  })

  it('terminates the running child and stops when the stop signal aborts mid-run', async () => {
    const controller = new AbortController()
    const { children, launch } = harness()
    const run = supervise(launch, { signal: controller.signal })
    expect(children).toHaveLength(1)
    controller.abort()
    await run
    expect(children[0]!.killed).toEqual(['SIGTERM'])
  })

  it('kills and relaunches a child whose heartbeat goes stale', async () => {
    const controller = new AbortController()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-watch-'))
    const path = join(dir, 'beat')
    try {
      writeFileSync(path, 'x')
      const past = new Date(Date.now() - 60_000)
      await utimes(path, past, past)
      const { children, launch } = harness()
      const run = supervise(launch, { restartDelayMs: 0, heartbeat: { path, timeoutMs: 50 }, signal: controller.signal })
      await vi.waitFor(() => { expect(children[0]!.killed).toEqual(['SIGKILL']) })
      await vi.waitFor(() => { expect(children.length).toBeGreaterThanOrEqual(2) })
      controller.abort()
      await run
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
