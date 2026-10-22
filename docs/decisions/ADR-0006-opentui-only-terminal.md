---
id: ADR-0006
title: OpenTUI is the only terminal frontend
status: accepted
created: 2026-10-21
updated: 2026-10-21
supersedes: ADR-0004
---
# ADR-0006 — OpenTUI is the only terminal frontend

## Context and decision

Harness carried two terminal frontends: the owned Pi terminal and an OpenTUI/Solid frontend behind
`XINGULAR_HARNESS_TUI=opentui`. The split kept two launch paths, two input and rendering stacks, and
a fallback that let the terminal start without the OpenTUI build. The requested terminal is the
OpenTUI one, so the second frontend no longer earns its maintenance and test surface.

`Terminals.prepare()` now always returns Bun with `--conditions=browser` and
`dist/terminal-opentui.js`. The harness no longer reads `XINGULAR_HARNESS_TUI`, the CLI no longer
has the internal `terminal-frontend` command, and the legacy frontend modules are removed.
`TerminalAssets.openTui` is required. `XINGULAR_HARNESS_BUN` still selects the Bun executable.

Bun 1.3.14 or newer is required to build and run the terminal. `npm run build:tui` fails with a
clear error when Bun is unavailable instead of writing a placeholder or leaving the old frontend.
`HarnessOptions.piProgram` remains accepted for source compatibility but is ignored.

## Consequences

- There is one launch path, one frontend test surface, and no silent fallback to a different UI.
- A machine that installs the package must have Bun; Node remains the runtime for the CLI, server,
  accounts and Pi sessions.
- The OpenTUI page dialogs, composer, Bash mode and palette are the shipped presentation; the
  fullscreen layout in ADR-0004 is history.
- Embedders that construct `TerminalAssets` themselves must provide `openTui`.

## Alternatives considered

Keeping the legacy frontend as an unreachable fallback preserves dead code and two mental models
for input, rendering and exit behavior. Keeping OpenTUI opt-in preserves the split the change was
asked to remove. Both were rejected.

## Evidence

Unit and integration tests construct launches and exercise the shared runtime without a real
provider request. A PTY probe of the standalone command with `XINGULAR_HARNESS_TUI` unset renders
the OpenTUI home and exits 0; the capture and build hashes are in
[the console evidence](../evidence/terminal-2026-10-20-console-tui/default-opentui-probe.json).
