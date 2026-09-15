/**
 * Crash-restart supervision for the harness process.
 *
 * `supervise` relaunches a child on a non-zero exit until it exits cleanly or
 * a stop signal fires. It is the external half of the self-healing story: the
 * boot health guard inside the child breaks a rapid crash loop by degrading to
 * a runnable tree, and this supervisor keeps relaunching so that degraded boot
 * actually happens — a process that already exited cannot restart itself.
 * @module @deepseek-ai/dsh/watch
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/** A crash (non-zero exit) with no signal. */
const EXIT_SIGNAL_NONE = null

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

/** Options for {@link supervise}. */
export interface SuperviseOptions {
  /** Delay between a crash and the next relaunch, in milliseconds. Defaults to 1000. */
  restartDelayMs?: number
  /** Stop signal: terminates the current child and ends supervision. */
  signal?: AbortSignal
}

/**
 * Relaunch `launch`'s child on a crash until it exits cleanly or `signal`
 * aborts. A zero exit code or a signal-killed child ends supervision; any other
 * non-zero exit is a crash and schedules a relaunch after `restartDelayMs`. The
 * delay spaces out a rapid crash loop, which the child's boot health guard then
 * breaks by degrading to a runnable tree.
 * @param launch - starts one child; called once per relaunch.
 * @param options - restart delay and stop signal.
 */
export async function supervise(
  launch: () => SupervisedProcess,
  options: SuperviseOptions = {},
): Promise<void> {
  const restartDelayMs = options.restartDelayMs ?? 1_000
  for (;;) {
    if (options.signal?.aborted) return
    const child = launch()
    const outcome = await waitForExit(child, options.signal)
    if (options.signal?.aborted) return
    if (outcome.code === 0 || outcome.code === EXIT_SIGNAL_NONE) return
    await wait(restartDelayMs, options.signal)
  }
}

/**
 * Run a command under {@link supervise}, forwarding the child's stdio. Used by
 * the `dsh watch` launcher to re-invoke `dsh` without the `watch` subcommand.
 * @param command - the executable to spawn.
 * @param args - arguments for the executable.
 * @param options - restart delay and stop signal.
 */
export function superviseCommand(
  command: string,
  args: readonly string[],
  options: SuperviseOptions = {},
): Promise<void> {
  return supervise(() => {
    const child = spawn(command, [...args], { stdio: 'inherit' })
    const exited = new Promise<ExitOutcome>((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    return { exited, kill: signal => child.kill(signal) }
  }, options)
}

/** Resolve the child's exit, or terminate it and resolve a signal-kill when the stop signal aborts first. */
function waitForExit(child: SupervisedProcess, signal: AbortSignal | undefined): Promise<ExitOutcome> {
  return new Promise<ExitOutcome>((resolve) => {
    const onAbort = (): void => {
      child.kill('SIGTERM')
      resolve({ code: EXIT_SIGNAL_NONE, signal: 'SIGTERM' })
    }
    if (signal === undefined) {
      void child.exited.then(resolve)
      return
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void child.exited.then((outcome) => {
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    })
  })
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
