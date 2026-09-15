import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHeartbeat } from '../src/heartbeat.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heartbeat-'))
  dirs.push(dir)
  return dir
}

describe('startHeartbeat', () => {
  it('writes immediately, refreshes on the interval, and stops on dispose', async () => {
    const dir = tempDir()
    const path = join(dir, 'beat')
    const dispose = startHeartbeat(path, 5)
    expect(readFileSync(path, 'utf8')).toMatch(/^\d+$/)
    const first = readFileSync(path, 'utf8')
    await vi.waitFor(() => { expect(readFileSync(path, 'utf8')).not.toBe(first) })
    dispose()
    const stopped = readFileSync(path, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(readFileSync(path, 'utf8')).toBe(stopped)
  })

  it('is fail-soft when the heartbeat path cannot be written', () => {
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x') // a file blocks any subdirectory under it
    const dispose = startHeartbeat(join(blocker, 'sub', 'beat'), 5)
    dispose()
  })
})
