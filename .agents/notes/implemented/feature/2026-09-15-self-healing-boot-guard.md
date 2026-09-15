# Agent Note: Self-healing boot guard

Status: implemented

English | [中文](2026-09-15-self-healing-boot-guard.zh.md)

## Problem

Every app bin boots through `dsh-app-boot`'s `boot()`, and a failure there — a plugin that throws at apply, an entry that waits on a missing service, or a config that names an unresolvable module — is fail-loud: the process writes one diagnostic and `exit(1)`. Relaunching under a supervisor just fails the same way, so a broken harness crash-loops forever with no way to degrade, and nothing tells the next agent session that the harness's own boot is broken.

## Decision

Add a self-healing boot guard to `dsh-app-boot`. A durable ledger at `$DSH_HOME/boot-health.json` records every boot's outcome: the consecutive-failure count, the last failure message, and the loader entry ids that failure implicated. `decideRecovery` marks a crash loop once consecutive failures reach `CRASH_LOOP_THRESHOLD` (2). On a recovery boot, `boot()` injects `{ id, disabled: true }` patches for the implicated ids, so the tree degrades to a runnable state instead of looping. `failedEntryIds` derives those ids structurally from entries with no fiber or a failed/pending fiber.

The recovery summary is written to stderr and, through `addBootHealthSection`, injected into the global system prompt at the highest priority, so the agent is aware that its own boot is broken and repairs it first. `boot()` records a success (clearing the streak) or a failure (with the detail) around the settled tree.

The guard is opt-in: `boot()` gains an optional `health` option, and omitting it preserves the existing zero-side-effect contract. The `dsh` CLI passes `{}` in `runProfile`, so every profile surface (headless, web, and any custom profile) is guarded through one shared boot path.

## Alternatives considered

**Restart the process from inside the guard.** Rejected because a crashed or exited process cannot observe its own exit or relaunch itself; restart belongs to an external supervisor (systemd, PM2). The guard's job is to make each relaunch degrade to a runnable tree rather than crash again.

**Record the ledger on every `boot()` unconditionally.** Rejected because writing `$DSH_HOME` on every boot would pollute tests that do not stub `DSH_HOME`. The opt-in `health` option keeps `boot()` zero-side-effect while the single CLI wiring enables the guard globally.

**Recover by parsing the loader failure message for the entry id.** Rejected because an import failure rolls back and removes the entry, leaving its id only inside a nested `failed to … loader entry <id>` message. Structural `failedEntryIds` covers the apply and pending cases; the diagnostic still names the module for import failures.

**Disable every entry (full safe mode) on a crash loop.** Rejected because no deployment-neutral minimal entry set exists. Surgical disable of the implicated entries is the recoverable common case and leaves the rest of the composition intact.

## Consequences

A crash loop now degrades: after two failed boots, the next boot disables the implicated entries and comes up runnable, clearing the ledger on success. Import failures are not surgically disabled because their entry is rolled back before `failedEntryIds` runs; the failure message still surfaces the module name for the agent. Boot-time failures are covered; a mid-run hang still needs an external heartbeat supervisor, which is outside this guard.

Unit and integration tests pin ledger round-trips, threshold behavior, recovery-patch injection, a real crash-loop recovery, opt-in zero-side-effect, and prompt-section surfacing. The guard is keyless and covers both Windows and POSIX through the shared boot path.
