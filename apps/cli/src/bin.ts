#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseDshArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  case 'watch': {
    const { superviseCommand, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } = await import('./watch.ts')
    const script = process.argv[1]
    /* v8 ignore next -- a CLI always has a script path; this guards the type. */
    if (script === undefined) throw new Error('dsh watch: cannot determine the dsh script path to supervise')
    const heartbeatPath = join(resolveDshHome(), `dsh-heartbeat-${process.pid}`)
    const controller = new AbortController()
    const stop = (): void => { controller.abort() }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await superviseCommand(process.execPath, [...process.execArgv, script, ...invocation.args], {
      signal: controller.signal,
      heartbeat: { path: heartbeatPath, timeoutMs: HEARTBEAT_TIMEOUT_MS },
      env: {
        ...process.env,
        DSH_HEARTBEAT_PATH: heartbeatPath,
        DSH_HEARTBEAT_INTERVAL_MS: String(HEARTBEAT_INTERVAL_MS),
      },
    })
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
