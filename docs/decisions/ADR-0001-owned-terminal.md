---
id: ADR-0001
title: Own the terminal frontend and keep Pi as the session runtime
status: accepted
created: 2026-10-17
updated: 2026-10-17
related: []
supersedes: null
superseded_by: null
---

# ADR-0001 — Own the terminal frontend and keep Pi as the session runtime

## Context and decision drivers

The requested terminal must reproduce the supported Oh My Pi presentation using capabilities
Harness already has. An extension can replace a header, footer or editor, but Pi's
`InteractiveMode` still owns transcript layout, command routing, focus and screen lifecycle.
That arrangement cannot give Harness full control over those surfaces.

The existing terminal boundary already provides isolated accounts, a compiled prompt, trusted
resource selection, a session socket and controller, a final tool gate and one writer for run
records. Retaining that boundary avoids a second authority for authentication or run state.

## Decision

Own the terminal application in `src/terminal/tui/` and run a persistent Pi SDK
`AgentSessionRuntime` inside the prepared terminal child. Harness owns composition, editor and
input routing, dialogs, overlays and built-in command dispatch. Pi owns model/tool execution
and native history. The frontend binds the public extension UI contract in `tui` mode and may
reuse public rich content components.

Keep `TerminalAssets` and `Terminals.prepare/send/state/input/dispose` compatible. Preserve the
socket/controller bridge and its final gate. Keep the private control claim in process memory
across native session replacement, revalidate prepared resource trust before every load, and
scope native resume/import to the terminal's original working folder. Put unavoidable Pi
implementation imports in one adapter checked against the pinned Pi version.

Use the shipped OMP 18.11.3 artifacts as the visual reference, with Harness identity and existing
commands. [The living reference](../terminal-tui.md) records artifact digests, evidence and
verification limits. [NOTICE.md](../../NOTICE.md) preserves the upstream MIT license.

## Alternatives and rejection reasons

- **Only install a presentation extension:** leaves the default interactive frontend in control
  of transcript geometry, built-in commands and terminal lifecycle, contrary to the requested ownership.
- **Call `sessions.run` for each prompt:** recreates and disposes the runtime per turn, losing
  persistent plugin UI/queue state and overlapping terminal controller run accounting.
- **Replace the execution stack with OMP:** changes tools, model/provider behavior and product
  capabilities beyond the requested presentation migration.
- **Fork Pi's complete interactive mode:** introduces a large second implementation of session
  and terminal behavior, making upgrades and account/governance boundaries harder to review.

## Consequences and risks

Harness must maintain its own command routing, focus, keybindings and extension UI lifecycle.
The small internal adapter is an explicit upgrade constraint. Native session format and
account storage stay compatible; cross-folder navigation requires a freshly prepared scope.
Changes to trusted plugin code require review and reopening the terminal.

This record accepts the architectural choice. Implementation exists in the working tree;
publication and exhaustive visual/provider/platform parity are not implied. The living page
records passed focused tests and the pending controlled PTY verification result.

## Implementation and evidence

- [`TerminalApplication`](../../src/terminal/tui/application.ts) owns the screen and input lifecycle.
- [`runtime.ts`](../../src/terminal/tui/runtime.ts) owns the persistent SDK adapter and scoped navigation.
- [`piAdapter.ts`](../../src/terminal/tui/piAdapter.ts) contains pinned compatibility imports.
- [`piExtension.ts`](../../src/terminal/piExtension.ts) retains gate/telemetry integration.
- [`runtime.socket.test.ts`](../../src/terminal/tui/runtime.socket.test.ts) checks the real isolated SDK/socket boundary without a provider request.
- [Reference identities, retained REA evidence and verification limits](../terminal-tui.md#verification-and-remaining-limits).

## Verification follow-up — 2026-10-17

The earlier pending-PTY statement above records the state when this decision was written.
The [living reference](../terminal-tui.md#verification-and-remaining-limits) now records passed
production PTY scenarios at all three planned sizes, 419 Harness tests, a standalone proof and
portable OMP/Harness comparison records. The implementation also scopes retained plugin UI
callbacks and transcript components to a native resource generation, provides frozen runtime
state, and submits grouped question answers through the existing registry atomically.

The personal Codex live attempt reached the provider but was rejected because its usage limit
had been reached. The isolated credentials were deleted, the source sign-in remained unchanged,
and terminal restoration passed; see the [live evidence](../evidence/terminal-2026-10-17-followup/live-codex/README.md).
Successful live streaming/tool acceptance and App renderer acceptance remain open. This evidence
does not establish a released package or exhaustive platform/visual parity.
