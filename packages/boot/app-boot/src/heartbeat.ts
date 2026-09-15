/**
 * Liveness heartbeat for a supervised harness process.
 *
 * `startHeartbeat` rewrites a timestamp file on an interval. A supervisor that
 * watches the file's mtime can then detect a hung harness whose event loop has
 * stopped serving timers — the second half of the self-healing story, beside
 * the boot health guard's crash-loop recovery.
 * @module @deepseek-ai/dsh-app-boot/heartbeat
 */

import { writeFileSync } from 'node:fs'

/**
 * Write a timestamp heartbeat to `path` immediately and every `intervalMs`
 * milliseconds. The returned disposer stops the writes. The interval is unref'd
 * so it never keeps a completed one-shot process alive, while a hung event loop
 * stops updating the file and lets the supervisor notice.
 * @param path - absolute heartbeat file path.
 * @param intervalMs - milliseconds between heartbeats.
 * @returns a disposer that clears the interval.
 */
export function startHeartbeat(path: string, intervalMs: number): () => void {
  writeHeartbeat(path)
  const timer = setInterval(() => { writeHeartbeat(path) }, intervalMs)
  timer.unref()
  return () => { clearInterval(timer) }
}

function writeHeartbeat(path: string): void {
  try {
    writeFileSync(path, String(Date.now()))
  } catch {
    // Fail-soft: a read-only home disables hang detection, never the harness.
  }
}
