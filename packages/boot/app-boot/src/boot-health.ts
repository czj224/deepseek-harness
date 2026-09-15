/**
 * Self-healing boot health guard.
 *
 * Every app bin boots through {@link boot}, so a durable ledger under the single
 * Harness home is the one global place to remember boot outcomes across every
 * project and session. A crashed process cannot observe its own exit, so
 * detection happens at the START of the next boot from the ledger the previous
 * boot left behind: enough consecutive failures marks a crash loop, and the
 * guard then decides a degraded but runnable recovery boot — disable the
 * entries the last failure implicated — while surfacing a diagnostic that tells
 * the agent what to repair. This runs before any project work, making it the
 * highest-priority self-repair path.
 *
 * @module @deepseek-ai/dsh-app-boot/boot-health
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** File name of the durable boot-health ledger under the Harness home. */
export const BOOT_HEALTH_FILE_NAME = 'boot-health.json'

/** Consecutive failed boots that trigger a recovery (degraded) boot. */
export const CRASH_LOOP_THRESHOLD = 2

/** One durable boot-health ledger record. */
export interface BootHealthLedger {
  /** Consecutive failed boot attempts since the last successful boot. */
  consecutiveFailures: number
  /** ISO timestamp of the most recent recorded attempt. */
  lastAttemptAt: string
  /** Message of the most recent failure; absent after a successful boot. */
  lastFailure?: string
  /** Loader entry ids the most recent failure implicated; absent after a success. */
  failedEntryIds?: string[]
}

/** What a boot should do given the current ledger. */
export interface BootHealthDecision {
  /** Whether this boot is a recovery (degraded) boot. */
  recovering: boolean
  /** Loader entry ids to disable during recovery, when determinable. */
  disableEntryIds: string[]
  /** Agent- and human-readable recovery summary; empty when not recovering. */
  summary: string
}

/** Absolute ledger path under the given (or ambient) Harness home. */
export function bootHealthPath(home: string = resolveDshHome()): string {
  return join(home, BOOT_HEALTH_FILE_NAME)
}

/**
 * Read and validate the ledger, or `undefined` when it is absent or unreadable.
 * A corrupt ledger is treated as absent: the guard must never strand a boot on
 * its own unreadable record, and the next recorded outcome overwrites it.
 * @param home - harness home; defaults to {@link resolveDshHome}.
 */
export function readBootHealth(home: string = resolveDshHome()): BootHealthLedger | undefined {
  let raw: string
  try {
    raw = readFileSync(bootHealthPath(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return undefined
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return isBootHealthLedger(parsed) ? parsed : undefined
}

/**
 * Decide whether the ledger mandates a recovery boot and what it disables.
 * @param ledger - the ledger read by {@link readBootHealth}, or `undefined`.
 * @param threshold - consecutive-failure floor; defaults to {@link CRASH_LOOP_THRESHOLD}.
 */
export function decideRecovery(
  ledger: BootHealthLedger | undefined,
  threshold: number = CRASH_LOOP_THRESHOLD,
): BootHealthDecision {
  if (ledger === undefined || ledger.consecutiveFailures < threshold) {
    return { recovering: false, disableEntryIds: [], summary: '' }
  }
  const disableEntryIds = ledger.failedEntryIds ?? []
  const disabled = disableEntryIds.length > 0
    ? `the following entry(ies) disabled: ${disableEntryIds.join(', ')}`
    : 'no specific entry could be determined, so none is disabled'
  const failure = ledger.lastFailure === undefined
    ? `The harness failed to boot ${ledger.consecutiveFailures} times in a row.`
    : `The harness failed to boot ${ledger.consecutiveFailures} times in a row; last failure: ${ledger.lastFailure}`
  return {
    recovering: true,
    disableEntryIds,
    summary: `${failure} It is now running in recovery mode with ${disabled}. `
      + 'This is the highest priority: the harness\'s own boot is broken. '
      + 'Inspect and fix the root cause in the harness source, then restart — '
      + 'a successful boot clears recovery mode and re-enables the disabled entries.',
  }
}

/**
 * Record one successful boot: clear the failure streak and the failure detail.
 * @param home - harness home; defaults to {@link resolveDshHome}.
 * @param now - attempt timestamp; injectable for tests.
 */
export function recordBootSuccess(home: string = resolveDshHome(), now: Date = new Date()): void {
  writeBootHealth(home, { consecutiveFailures: 0, lastAttemptAt: now.toISOString() })
}

/**
 * Record one failed boot, appending to the failure streak and remembering the
 * loader entry ids the failure implicated.
 * @param home - harness home; defaults to {@link resolveDshHome}.
 * @param reason - the failure message to surface on a later recovery boot.
 * @param failedEntryIds - loader entry ids implicated by the failure.
 * @param now - attempt timestamp; injectable for tests.
 */
export function recordBootFailure(
  home: string = resolveDshHome(),
  reason: string,
  failedEntryIds: readonly string[] = [],
  now: Date = new Date(),
): void {
  const previous = readBootHealth(home)
  writeBootHealth(home, {
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    lastAttemptAt: now.toISOString(),
    lastFailure: reason,
    ...failedEntryIds.length > 0 ? { failedEntryIds: [...failedEntryIds] } : {},
  })
}

function isBootHealthLedger(value: unknown): value is BootHealthLedger {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.consecutiveFailures === 'number'
    && Number.isSafeInteger(record.consecutiveFailures)
    && record.consecutiveFailures >= 0
    && typeof record.lastAttemptAt === 'string'
    && (record.lastFailure === undefined || typeof record.lastFailure === 'string')
    && (record.failedEntryIds === undefined || (
      Array.isArray(record.failedEntryIds)
      && record.failedEntryIds.every(id => typeof id === 'string')
    ))
}

/**
 * Persist the ledger, best-effort. A read-only or unwritable Harness home must
 * never break the harness's actual job, so filesystem failures are swallowed:
 * the guard degrades to a stale (or absent) ledger instead of failing boot. A
 * serialization failure (a programming error in the ledger value) still throws,
 * because it is not a filesystem condition.
 */
function writeBootHealth(home: string, ledger: BootHealthLedger): void {
  const serialized = JSON.stringify(ledger) + '\n'
  try {
    mkdirSync(home, { recursive: true })
    const target = bootHealthPath(home)
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, serialized)
    try {
      renameSync(tmp, target)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  } catch {
    // Fail-soft: a filesystem write failure leaves the ledger stale; the next
    // successful boot rewrites it.
  }
}
