# 11 Terminal

## Purpose

The harness owns a generic interactive terminal application (`xharness`) over a
persistent Pi session on a variant. It is the standalone way to use the harness, and an
embedding application can host it in its own PTY. Detail, screen layout and verification evidence
are in [`../terminal-tui.md`](../terminal-tui.md); this page states the binding parts.

## Components

| Type / module | Role |
|---|---|
| `Terminals` (`terminal/terminals.ts`) | Parent side: `prepare` (account, compiled context, trusted resources, run writer) returns a launch specification; `send`, `state`, `input`, `dispose`. |
| `src/terminal/opentui/` (`app.ts`, `root.tsx`) | The OpenTUI/Solid frontend: lifecycle, submission, commands, decisions, composition, transcript, composer, dialogs. |
| `src/terminal/opentui/attachments.ts`, `composerMarks.ts` | Composer attachments: pasted images and collapsed large pastes, their atomic labels, and expansion into the prompt text and Pi image content on send. |
| `src/terminal/tui/runtime.ts` | `AgentSessionRuntime` over `createAgentSession`, `ModelRuntime`, `SessionManager`, `DefaultResourceLoader`. |
| `src/terminal/socket.ts`, `client.ts`, `control.ts`, `controller.ts` | The session socket, the private control key, and the run controller. |
| `src/terminal/piExtension.ts` | The bridge extension, loaded last as the trusted inline gate. |
| `src/terminal/cli.ts` | Wiki and connected-apps commands for the session's shell. |

```text
Harness parent: account + compiled context + trusted resources + run writer
       | launch specification / session socket
Harness terminal child (Bun): OpenTUI application + persistent Pi AgentSessionRuntime
       | typed native events / plugin UI callbacks
Screen: transcript above the composer, centred page dialogs
```

## Contracts

- The published executable is `xharness`; with no command it starts the interactive terminal. `terminal` remains an explicit alias, and `serve` remains the host-facing RPC path.
- `TerminalAssets` is `{ node, cli, piExtension, openTui }`. The command is Bun with
  `--conditions=browser` and `dist/terminal-opentui.js`; no global `pi` is needed.
- The `piExtension` path is the final prepared extension argument; the runtime loads it as the
  final trusted inline factory.
- The terminal compiles its prompt once (`compile` + `render`) and keeps that pack; each run
  records a copy (page 04).
- Standalone defaults: `~/.xingular-harness/{data,state}`; `npm run dev` uses
  `~/.xingular-harness-dev/{data,state}`.

## Invariants

- **INV-TUI-1** OpenTUI is the only terminal frontend. Pi's `InteractiveMode` is never constructed
  ([ADR-0006](../decisions/ADR-0006-opentui-only-terminal.md)).
- **INV-TUI-2** The harness owns screen composition, input, scrolling, command routing and plugin
  UI. Pi owns the execution runtime, native history and rich content components. A host owns the
  PTY and process supervision ([ADR-0001](../decisions/ADR-0001-owned-terminal.md)).
- **INV-TUI-3** Execution, account isolation, trust, authorization and run recording stay behind
  their existing layers. The terminal adds no second path for any of them; its runs are written
  through the controller and the run store.
- **INV-TUI-4** Changes made through the session socket (`plugins.attach|detach|trust|untrust`,
  `accounts.*`, Hub installs) require the control key the trusted terminal process claimed once
  (`control.claim`). The session's shell can read the session token, so the token alone is never
  enough.
- **INV-TUI-5** Every resource reload revalidates the original trusted selection; changed or
  revoked code needs review and a fresh terminal.
- **INV-TUI-6** `sessions.run` stays the embedding and unattended path. The terminal keeps a
  persistent child instead of opening a session per turn.

## Source map

`src/terminal/**`. Decisions: ADR-0001, [ADR-0004](../decisions/ADR-0004-fullscreen-terminal-layout.md)
(superseded), ADR-0006. Experiments: EXP-0001, EXP-0002 in `../experiments/`.

## Session name in the working line (PROP-0010)

The bridge registers `session_name` against Pi's `getSessionName` / `setSessionName` APIs.
The native `session_info_changed` event invalidates the frontend's cached snapshot and
refreshes the working line. Both the active and retained completion line append
` – <name>` after duration and token rate, for example
`Working (2m, 50 tok/s) – Add web browser integrations`. Unnamed sessions omit the suffix.
Names use the existing terminal text sanitization, remain outside the verb shimmer, and
truncate at the right edge. Manual `/name` and existing long names remain supported.

## Doctor command

`/doctor` opens a command page and runs local readiness checks. Refresh and retry are local;
Live checks opens an explicit selection followed by account/model, destination, cost and isolation
confirmation. The page polls structured reports, retains findings after cancellation, and cancels
on close. No command text is sent to the conversation model. See [Doctor](../doctor.md).
