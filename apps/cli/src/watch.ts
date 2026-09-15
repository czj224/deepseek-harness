/**
 * Crash-restart supervision for the harness process.
 *
 * `supervise` relaunches a child on a crash (non-zero exit or a signal kill)
 * until it exits cleanly, a stop signal fires, or a heartbeat goes stale — the
 * last case catches a hung child whose event loop stopped serving timers. It is
 * the external half of the self-healing story: the boot health guard inside the
 * child breaks a rapid crash loop by degrading to a runnable tree, and this
 * supervisor keeps relaunching so that degraded boot actually happens — a
 * process that already exited cannot restart itself.
 * @module @deepseek-ai/dsh/watch
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

/** Default heartbeat interval the child writes at, in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** Default stale threshold: three missed beats. */
export const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_INTERVAL_MS

/** The child handle `supervise` observes and terminates. */
export interface SupervisedProcess {
  /** Resolves once the child exits, with its exit code and signal. */
  readonly exited: Promise<ExitOutcome>
  /** Terminate the child; defaults to `SIGTERM`. */
  kill(signal?: NodeJS.Signals): void
}

/** One child exit, as `child_process`'s `exit` event reports it. */
export interface ExitOutcome {
  /** Exit code, or `null` when the child was killed by a signal. */
  code: number | null
  /** The terminating signal, or `null` for a normal exit. */
  signal: NodeJS.Signals | null
}

/** A liveness heartbeat: a file the child rewrites on an interval. */
export interface HeartbeatOptions {
  /** Absolute path of the heartbeat file the child updates. */
  path: string
  /** Milliseconds without a heartbeat before the child is considered hung. */
  timeoutMs: number
}

/** Options for {@link supervise}. */
export interface SuperviseOptions {
  /** Delay between a crash and the next relaunch, in milliseconds. Defaults to 1000. */
  restartDelayMs?: number
  /** Stop signal: terminates the current child and ends supervision. */
  signal?: AbortSignal
  /** Optional liveness heartbeat: a hung child is killed and relaunched. */
  heartbeat?: HeartbeatOptions
}

/**
 * Relaunch `launch`'s child on a crash until it exits cleanly, the stop signal
 * aborts, or the heartbeat goes stale. A zero exit code ends supervision; any
 * other exit — a non-zero crash, a signal kill, or a heartbeat-timeout kill —
 * schedules a relaunch after `restartDelayMs`. The delay spaces out a rapid
 * crash loop, which the child's boot health guard then breaks by degrading to a
 * runnable tree.
 * @param launch - starts one child; called once per relaunch.
 * @param options - restart delay, stop signal, and heartbeat.
 */
export async function supervise(
  launch: () => SupervisedProcess,
  options: SuperviseOptions = {},
): Promise<void> {
  const restartDelayMs = options.restartDelayMs ?? 1_000
  for (;;) {
    if (options.signal?.aborted) return
    const child = launch()
    const outcome = await waitForExit(child, options.signal, options.heartbeat)
    if (options.signal?.aborted) return
    if (outcome.code === 0) return
    await wait(restartDelayMs, options.signal)
  }
}

/** Options for {@link superviseCommand}. */
export interface SuperviseCommandOptions extends SuperviseOptions {
  /** Environment for the spawned child; defaults to the parent's environment. */
  env?: NodeJS.ProcessEnv
}

/**
 * Run a command under {@link supervise}, forwarding the child's stdio. Used by
 * the `dsh watch` launcher to re-invoke `dsh` without the `watch` subcommand.
 * @param command - the executable to spawn.
 * @param args - arguments for the executable.
 * @param options - restart delay, stop signal, heartbeat, and child environment.
 */
export function superviseCommand(
  command: string,
  args: readonly string[],
  options: SuperviseCommandOptions = {},
): Promise<void> {
  const { env, ...superviseOptions } = options
  return supervise(() => {
    const child = spawn(command, [...args], { stdio: 'inherit', env })
    const exited = new Promise<ExitOutcome>((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    return { exited, kill: signal => child.kill(signal) }
  }, superviseOptions)
}

/**
 * Resolve the child's exit; terminate it and resolve a signal-kill when the stop
 * signal aborts first; kill and resolve a crash when the heartbeat goes stale.
 */
function waitForExit(
  child: SupervisedProcess,
  signal: AbortSignal | undefined,
  heartbeat: HeartbeatOptions | undefined,
): Promise<ExitOutcome> {
  return new Promise<ExitOutcome>((resolve) => {
    let settled = false
    let heartbeatTimer: NodeJS.Timeout | undefined
    function settle(outcome: ExitOutcome): void {
      if (settled) return
      settled = true
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    function onAbort(): void {
      child.kill('SIGTERM')
      settle({ code: null, signal: 'SIGTERM' })
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (heartbeat !== undefined) {
      heartbeatTimer = setInterval(() => {
        void heartbeatStale(heartbeat.path, heartbeat.timeoutMs).then((stale) => {
          if (stale) {
            child.kill('SIGKILL')
            settle({ code: 1, signal: null })
          }
        })
      }, heartbeat.timeoutMs / 2)
      heartbeatTimer.unref()
    }
    void child.exited.then((outcome) => { settle(outcome) })
  })
}

/** Whether the heartbeat file's mtime is older than `timeoutMs`. */
async function heartbeatStale(path: string, timeoutMs: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return Date.now() - info.mtimeMs > timeoutMs
  } catch {
    // A missing heartbeat means the child is still starting or its home is
    // read-only; neither is a hang.
    return false
  }
}

/** Wait `ms`, returning early when the stop signal aborts. */
async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return
  try {
    await sleep(ms, undefined, { signal })
  } catch {
    // Aborted: return early; the loop observes the signal at its top.
  }
}
