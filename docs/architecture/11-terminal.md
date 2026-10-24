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
Screen: transcript above the composer, centred dialogs, full-screen resource browser
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
- `xharness --worktree [name]` (`-w`) starts in a new managed worktree of the current repository,
  or in the named one, and prunes older managed worktrees (PROP-0016). A session that names a
  worktree holds it for its whole life. `/plugin:worktree` switches folders by asking the host to restart
  the frontend there (`TerminalRelaunch.cwd`), as a new conversation: Pi keeps one history per
  working folder.
- Slash-command aliases share one registry entry: `/session (resume)` switches saved sessions,
  `/history (tree)` navigates branches in the current session, and `/btw (side)` asks a side
  question. Aliases remain callable and searchable, but help and palette show only the canonical
  entry. Plugin-owned built-in and Pi extension commands use `/plugin:<command>`; core commands
  remain unprefixed. Prompt templates and `/skill:<name>` keep their existing invocation forms.

## Invariants

- **INV-TUI-1** OpenTUI is the only terminal frontend. Pi's `InteractiveMode` is never constructed
  ([ADR-0006](../decisions/ADR-0006-opentui-only-terminal.md)).
- **INV-TUI-2** The harness owns screen composition, input, scrolling, command routing and plugin
  UI. Pi owns the execution runtime, native history and rich content components. A host owns the
  PTY and process supervision ([ADR-0001](../decisions/ADR-0001-owned-terminal.md)).
- **INV-TUI-3** Execution, account isolation, trust, authorization and run recording stay behind
  their existing layers. The terminal adds no second path for any of them; its runs are written
  through the controller and the run store.
- **INV-TUI-4** Changes made through the session socket (`plugins.attach|detach|trust|untrust|configure`,
  `accounts.*`, Hub installs, `terminal.browser.*`, `terminal.worktrees.*`, `terminal.annotations.*`) require the control key the trusted terminal process claimed once
  (`control.claim`). The session's shell can read the session token, so the token alone is never
  enough.
- **INV-TUI-5** Every resource reload revalidates the original trusted selection; changed or
  revoked code needs review and a fresh terminal.
- **INV-TUI-6** `sessions.run` stays the embedding and unattended path. The terminal keeps a
  persistent child instead of opening a session per turn.
- **INV-TUI-7** A plugin command is invoked as `/plugin:<command>`, dispatched to its registered
  owner and shown that way in completion and help. Duplicate names are rejected with owner
  diagnostics. Old unprefixed plugin command forms are not aliases; core commands stay unprefixed.

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

`/plugin:doctor` opens a command page and runs local readiness checks. Refresh and retry are local;
Live checks opens an explicit selection followed by account/model, destination, cost and isolation
confirmation. The page polls structured reports, retains findings after cancellation, and cancels
on close. No command text is sent to the conversation model. See [Doctor](../doctor.md).

## Resource browser (PROP-0013)

`/harness` owns shared navigation for Foundation, Variant, Skills, Plugins, Connections, Tools
and Library. `/skills`, `/plugins`, `/connections` (`/mcp`), `/tools`, `/hub` and `/components`
are shortcuts into that browser. Current availability comes from the live resource loader and
active tool registry, independently of saved configuration and the latest variant head.

Every `terminal.browser.*` call requires the private control key, including bounded resource
inspection, local imports, connection management and browser settings. Package install/remove use protected
`plugins.install|remove`. These are adapters to the existing services, not another loader,
attachment store, gate or secret store. Browsing neither executes plugin code nor connects MCP.
The browser uses the full terminal with persistent section tabs (PROP-0014); wide screens keep
inventory beside details, actions and content, while compact screens keep inline details under
the same tabs. Other command pages remain centered except `/settings`, which also uses a full-screen
page layout. See the [terminal guide](../terminal-tui.md#blocks-and-pages) for layout and interaction.

`/settings` is a full-screen page with category tabs, search, settings list and the device-local
Browser tab for `allowPrivate`. Enabling private address access requires confirmation and allows both
agent browsing and annotation capture to reach localhost and private networks. It is off by default.

## Worktrees command (PROP-0016)

`/plugin:worktree` opens a page of the managed worktrees of the repository the session works in: make a
managed or permanent worktree, switch the terminal to one (or back to the main checkout), create a
branch on a detached one, hand changes off in either direction, remove one (with a snapshot when it
holds work, never the one this terminal uses), restore a removed one, prune older ones, and trust
the repository's setup script. The page calls `terminal.worktrees.*` routes, which use the same
`Worktrees` service as the `worktrees.*` server methods. `xharness worktree <command>` offers the
same actions from a shell.

## Page notes commands (PROP-0017)

`/plugin:notes` lists the page notes kept in the data root, with search, and offers reveal, edit, resolve or
reopen, share with this session or stop sharing, and delete. `/plugin:annotate [url]` starts a new note: it
opens a visible capture browser (its own window and profile, separate from the agent's browser), and
the person notes the whole page, selects text, or clicks an element there, then confirms in the
terminal. A note is private until shared; this session's agent then reads it with `page_notes_list`
and `page_notes_read`.

`/plugin:annotate` is the annotate pane (PROP-0018): a full-screen page beside the window being inspected.

- **Ways to start it:**
  - `/plugin:annotate [url]`: the browser window
  - `/plugin:annotate --app <DevTools address | port> [name]`: an app's own windows over its DevTools port
  - `/plugin:annotate --bridge [name]`: app windows that load the page bridge script, which the pane shows
- **The inspector** (`i`) outlines components on hover. A click or a text drag opens a popover in the page with Create annotation, Ask agent to fix, and Proceed now.
- **Sections:** Queue, Sent and fixed (with the agent's summary), and Saved.
- **Other keys:** `s` sends the queue as one run of this session, confirming notes that came from a page-world script first; `x` takes a note out of the queue; `t` picks a window.
- **Routes:** `terminal.annotations.target|attach|windows|selectWindow|inspect|stopInspect|next|queue|dequeue|confirm|send` act only on this terminal's session and need the control key.

## Subagent activity monitor

During an active parent run, the terminal polls a private read-only monitor once per second. It
projects the flat set of child and nested-child runs with task, status, elapsed time and the latest
tool name only; tool summaries, arguments and output never enter the monitor. The latest completed
tool name remains visible across one-second snapshots until new tool or response activity replaces
it. The monitor exposes no controls to steer or stop children. A compact widget sits above the
composer; `/plugin:subagents` opens the searchable full roster and selected task/activity detail. Finished
rows remain until the parent run settles. The projection is volatile and scoped to that parent run;
it is not a persisted event or public server method.
