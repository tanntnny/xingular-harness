---
id: PROP-0043
title: Read-only Bash in plan mode, enforced by the OS sandbox
status: Accepted; implemented
created: 2026-10-26
updated: 2026-10-26
affects: [INV-RUN-8, INV-GATE-3, INV-GATE-8, 02-sessions-and-runs.md, 07-tools-and-gate.md, 11-terminal.md, terminal-tui.md, parity.md, ADR-0038]
---

# PROP-0043: Read-only Bash in plan mode, enforced by the OS sandbox

## Problem

Plan mode refuses Bash entirely: `planRefusal` (`src/sessions/planMode.ts`) did not list `bash`,
the terminal dropped it from the plan's active set (`planModeTools`), and a test pinned the refusal.
A plan therefore could not check its claims with read-only commands such as `git log`, `git diff`,
`rg` or `node --version`, although the plan instructions ask for evidence-grounded findings.

## Affected rules

- `INV-RUN-8`: "… it has no connectors, user questions, writes, commands or nested subagents." (about
  plan research children; unchanged) and the plan instruction "Do not change files or remote data, run
  commands, …".
- `INV-GATE-3` / `INV-GATE-8`: default Bash writes inside the workspace; `outside` scope and Full
  Permission can widen it.

## Proposal

A plan run (SDK sessions and the terminal) may call the model's `bash` tool. Every such call runs in
a new **read-only scope** of the existing workspace sandbox (`core/workspaceSandbox.ts`):

- Reads are as broad as default Bash. Writes are denied everywhere except `/dev/null`, `/dev/tty`,
  and a private temp folder made for the call; `TMPDIR` points to it and it is removed afterwards.
- No network. No signals outside the sandbox. On macOS no mach services at all, so a command cannot
  act through system daemons (preferences, Apple Events, Launch Services). On Linux, `bwrap` adds
  `--unshare-net --unshare-ipc` and a tmpfs over `/run`.
- Nothing widens the scope: the Full Permission bypass and `workspaceWriteScope: 'outside'` are never
  consulted. The gate refuses an `outside` request before approvals. The hard-link scan is skipped,
  because the scope permits no workspace writes.
- A missing sandbox fails closed, as for default Bash.
- As defence in depth, the gate also refuses a short list of system-acting commands
  (`PLAN_BASH_DENIED`: `sudo`, `osascript`, `open`, `launchctl`, `defaults`, `kill`, `ssh`, …) in any
  segment of the command. The OS sandbox is the boundary; the list is not.

The plan instruction says read-only shell inspection is allowed, writes and network fail, and the
model must not work around a failed write. Unchanged: plan research children still have no Bash, a
user `!` command still exits plan mode, and `!` is still refused while a plan request runs.

## Alternatives

- **Do nothing.** Plans stay unable to verify claims with commands.
- **A command allowlist without the sandbox.** Easy to get around (`find -exec`, `rg --pre`,
  `git -c core.pager=…`, `$(…)`, aliases), and every new tool needs a review. Rejected as the
  boundary; kept only as a small denylist.
- **Default workspace-scoped Bash in plan mode.** Would let a plan change the workspace.

## Consequences

Hosts need no change; plan mode reaches the runner through `Sessions`. The terminal keeps `bash` in
its plan active set. No protocol, stored data or prompt prefix changes: the SDK tool list is
unchanged and the instruction is the dynamic plan section. Builds and tests that write fail in plan
mode, which is intended.

## Migration

None. It can be undone by removing `bash` from the plan gate.

## Checks

`src/core/workspaceSandbox.test.ts` (real sandbox: reads succeed; workspace, home and link writes
fail; the temp folder works and is removed; a local TCP connection fails; widening callbacks are
never called; win32 fails closed), `src/sessions/planMode.test.ts`, `src/sessions/sessions.test.ts`,
`src/terminal/piExtension.lifecycle.test.ts`, `npm run prove`, and the App's checks. The Linux `bwrap`
path needs an Ubuntu CI run.
