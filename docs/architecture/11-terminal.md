# 11 Terminal

## Purpose

The harness owns a generic interactive terminal application (`xagent`) over a
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

- The published executable is `xagent`; `xharness` is not retained as a compatibility alias. With no command, `xagent` starts the interactive terminal. `terminal` remains an explicit alias, and `serve` remains the host-facing RPC path.
- `TerminalAssets` is `{ node, cli, piExtension, openTui }`. The command is Bun with
  `--conditions=browser` and `dist/terminal-opentui.js`; no global `pi` is needed.
- The `piExtension` path is the final prepared extension argument; the runtime loads it as the
  final trusted inline factory.
- Each terminal `begin` returns the run's pinned `workspaceRoot` to that extension. Native file
  writes use the same revalidated atomic helper and OS write scope as SDK sessions. Terminal Bash,
  including initial `!` commands, defaults to the workspace sandbox and external-hard-link scan;
  `!outside <command>` requests human-only approval before that exact command runs once; its full
  escaped command is available in scrollable approval details, and an undersized terminal denies
  the request. The eligible Full Permission switch is the only standing boundary bypass; remembered
  per-tool grants do not widen it, and command output never triggers approval or replay.
- The terminal compiles its prompt once (`compile` + `render`) and keeps that pack; each run
  records a copy (page 04). The shared compaction checkpoint extension reintroduces the active
  request and latest checklist into post-compaction model context until the run settles.
- Normal mode keeps `ask_user` out of the active tool set. An attended plan request enables the
  shared tool alongside its read-only set and restores the normal set on success, failure or
  interruption. There is no terminal-only question alias (PROP-0040).
- A plan request keeps `bash` in its active set; each call runs in the sandbox's read-only scope
  (PROP-0043). A user `!` command is refused while a plan request runs.
- Current standalone source defaults: `~/.xingular-harness/{data,state}`; `npm run dev` uses
  `~/.xingular-harness-dev/{data,state}`. The standalone development launch uses a file SecretStore
  under its resolved development state directory, even when its profile names a host backend; it
  does not use or alter host credentials. `--variant <scope>` explicitly selects a variant head.
  PROP-0040 approves a shared Harness-owned interactive profile, neutral default scope and
  credential backend; adoption and runtime verification remain in progress. Until that lands,
  matching roots/scopes is explicit and matching roots alone does not share host Keychain secrets.
- `Launch.standard` supplies the shared role and folder text. History, Wiki and skill model tools
  use the session socket; enabled output-trim/budget-guard hooks load through `firstParty.list`.
  Pi CLI built-ins (llama.cpp, codemode, tool-search and MCP) are not loaded as a terminal-only
  resource path. Harness MCP remains available.
- An empty conversation shows a centered welcome using `env.productName` (default `Xingular Agent`):
  the first letter of a multiword name is the orange block mark and its remaining words are letter-spaced
  in blue. The welcome adds a greeting, tagline and `/help` hint without replacing the composer or
  status bar. Explicit host product names use the same generic formatting.
- `xagent --worktree [name]` (`-w`) starts in a new managed worktree of the current repository,
  or in the named one, and prunes older managed worktrees (PROP-0016). A session that names a
  worktree holds it for its whole life. `/worktree` opens the worktree page; selecting
  one switches folders by asking the host to restart the frontend there (`TerminalRelaunch.cwd`),
  as a new conversation: Pi keeps one history per working folder.
- Slash-command aliases share one registry entry: `/session (resume)` opens the full-screen, searchable
  saved-session page with unnumbered title and metadata rows; `/history (tree)` navigates branches in
  the current session, and `/btw (side)` asks a side
  question through the Harness `SideQuestions` service. It uses the same account/model/effort,
  mirrors the main run's redacted prompt and public evidence, starts a separate tool-free run, and
  leaves the main conversation untouched. The dock streams, scrolls and copies the complete answer.
  Aliases remain callable and searchable, but help and palette show only the canonical
  entry. `/usage:` and `/usage:analysis` open the usage page's Analysis tab, and `/usage:limit`
  opens its Limits tab (PROP-0042); both are plugin-owned namespaced routes. The usage page is a
  centered dialog: each window is a label and reset line above a quota-left bar coloured green at
  50% or more left, amber from 20–49%, and red below 20%. `commands.list`
  publishes the effective routes; the browser-safe core catalogue is `commands/registry.ts`. First-class Harness commands are unprefixed and live in that registry,
  independently of plugin command metadata. Every plugin-owned command uses
  `/<owner-prefix>:<command>`; the namespace root is offered only by plugins that declare a default
  command. Prompt templates and `/skill:<name>` keep their existing forms.

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
  `accounts.*`, Hub installs, `terminal.browser.*`, `terminal.worktrees.*`,
  `terminal.annotations.*`, `terminal.sideQuestions.*`) require the control key the trusted terminal process claimed once
  (`control.claim`). The session's shell can read the session token, so the token alone is never
  enough.
- **INV-TUI-5** Every resource reload revalidates the original trusted selection; changed or
  revoked code needs review and a fresh terminal.
- **INV-TUI-6** `sessions.run` stays the embedding and unattended path. The terminal keeps a
  persistent child instead of opening a session per turn.
- **INV-TUI-7** Harness core commands use unprefixed names and are registered independently of
  feature-plugin command metadata. This includes `/doctor`, `/worktree`, `/trajectory`, `/subagents`
  and `/agents`; `/history` remains session-branch navigation, and `/mcp` remains a Connections
  shortcut. Every plugin-owned terminal command uses `/<owner-prefix>:<command>`, for required and
  optional built-ins and Pi extensions alike. Completions, help and dispatch use the same stable
  owner prefix. Prefixes are unique to an owner; a prefix collision or duplicate command within an
  owner is rejected with owner diagnostics. `/skill:<name>` remains reserved for skill invocation.
  For one release, the former owner-qualified and `/plugin:<command>` forms of promoted Harness
  commands remain hidden compatibility aliases; aliases are not listed in help or completion.
- **INV-TUI-8** Terminal sessions use the Harness-pinned workspace root and the same write
  boundary as SDK sessions. Native file mutations use revalidated atomic replacement under an OS
  scope; default Bash scans for external hard-link aliases and runs inside the sandbox. The terminal
  cannot widen the boundary through its socket or native extension. `!outside <command>` requests
  human-only approval before one execution; the terminal shows the complete escaped command and
  denies the request if it cannot display details and choices together. stdout/stderr cannot trigger
  approval or replay. Missing enforcement fails closed. Full Permission bypasses the boundary only
  for eligible interactive
  user runs and does not override hard policy denials, read-only or plan mode, unattended work, or
  refinement restrictions.

## Source map

`src/terminal/**`. Decisions: ADR-0001, [ADR-0004](../decisions/ADR-0004-fullscreen-terminal-layout.md)
(superseded), ADR-0006, [ADR-0021](../decisions/ADR-0021-required-command-namespaces.md)
(superseded by [ADR-0031](../decisions/ADR-0031-plugin-command-owner-namespaces.md)),
[ADR-0024](../decisions/ADR-0024-xagent-command.md),
[ADR-0027](../decisions/ADR-0027-connected-sketch-display.md),
[ADR-0028](../decisions/ADR-0028-xingular-agent-product-identity.md),
[ADR-0031](../decisions/ADR-0031-plugin-command-owner-namespaces.md),
[ADR-0034](../decisions/ADR-0034-first-class-harness-terminal-commands.md),
[ADR-0036](../decisions/ADR-0036-workspace-write-operation-boundary.md). Experiments:
EXP-0001, EXP-0002 in `../experiments/`.

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
the same tabs. Other command pages remain centered except `/settings` and `/accounts`, which use
full-screen page layouts. Accounts keeps Accounts/Pools tabs, search and account-service operations.
Wide terminals show selected-account details beside the list; Enter or a primary click opens grouped
actions in that inspector. Compact terminals replace the list with a full-page account detail view
and its grouped actions. Enter opens the selected account; Escape returns to the list while
preserving its section, query and selection across navigation and resizing. Tab/Shift+Tab moves focus
between tabs, the list and (when open) actions; Left/Right changes a focused tab and Up/Down moves
the focused list or action list. Account actions retain their Session, Account, Sign-in and Remove
groups; pool actions remain grouped under Manage and Remove. See the
[terminal guide](../terminal-tui.md#blocks-and-pages) for layout and interaction.

`/settings` is a full-screen page with category tabs, search, settings list and the device-local
Browser tab for `allowPrivate`. Enabling private address access requires confirmation and allows both
agent browsing and annotation capture to reach localhost and private networks. It is off by default.

## Worktrees command (PROP-0016)

`/worktree` opens a page of the managed worktrees of the repository the session works in: make a
managed or permanent worktree, switch the terminal to one (or back to the main checkout), create a
branch on a detached one, hand changes off in either direction, remove one (with a snapshot when it
holds work, never the one this terminal uses), restore a removed one, prune older ones, and trust
the repository's setup script. The page calls `terminal.worktrees.*` routes, which use the same
`Worktrees` service as the `worktrees.*` server methods. `xagent worktree <command>` offers the
same actions from a shell.

## Question dock

Pending questions appear in a flat block above the composer, with a tab for each 1–2 word question
label above its title. Tabs can be clicked; Left/Right also switch questions and preserve staged
answers. The header has no pager or collapse control, and the dock stays expanded until the answer
is submitted or Escape cancels the pending question. While it is active, the chat composer and its
lower status bar are hidden. `n` opens a note for the focused selected choice; Tab and Shift+Tab
navigate existing note fields, the free-text answer and the action without creating notes. Notes
and the “Something else” answer wrap across lines. Choice recommendations remain visual only and
never preselect an answer.

Every choice uses one shared measured layout: a marker gutter, a one-third label cell, a two-cell
gap, and the remaining description cell. Column boundaries align across all rows at every terminal
width, including compact widths. Text wraps within its cell; a missing description keeps its cell
and columns never stack. Recommendation text uses `(Rec.)` when the label column is fewer than 14
cells. Below 60 terminal columns, the dock uses a compact hint. Multi-select choices use `✓`
when selected and `○` when unselected, matching checklist glyphs; single-choice options remain
numbered.

The dock body has bounded height and vertical scrolling; question tabs and answer/action controls
stay outside that scrolling region. PageUp/PageDown scroll the body and Ctrl+Home/End jump to its
beginning/end while the dock is active, rather than scrolling the transcript. Focused choices and
note fields are brought into view. Ordinary arrows retain question/choice navigation; Shift+arrows
pan the sketch horizontally or vertically.

When a question sets `uiSketch: true`, one shared border-only monospace preview below the choices
shows the hovered or focused choice's ASCII wireframe, with no visible caption or extra left rule.
Sketch source supports up to 80 columns by 24 lines (page 02) and remains literal ASCII in
persistence. The terminal uses a bounded structural display projection: recognized ASCII table-border
rows—including a title between horizontal runs—and enclosed vertical table edges become connected
box-drawing glyphs, while internal framed tables retain their original widths and positions. For a
high-confidence frame with matched `+` corners, missing or slightly displaced side edges may be
filled or moved only through whitespace to the established boundary columns; interior text is never
moved or overwritten, and conflicting or ambiguous rows remain literal. Bare standalone hyphen
divider rows expand to `max(panel viewport width, original sketch widest line)` and join the outer
single-line preview frame with `├` and `┤`. This is not a global `+|-` substitution: prose, content
operators, ordinary pipes and unrecognized rows remain literal. Source sketches and all persisted
whitespace remain unchanged; only the display projection adjusts recognized boundary cells.

There is no wrapping, reflow, truncation or markup interpretation. A bounded two-axis viewport makes
all overflow reachable by panning. Moving focus changes the preview without changing the staged
answer. Projected glyphs and expanded dividers never enter persisted events or answers; the wire
contract is unchanged. See [PROP-0025](proposals/PROP-0025-contextual-question-wireframes.md),
[ADR-0026](../decisions/ADR-0026-contextual-question-wireframes.md) and the approved display amendment
[PROP-0026](proposals/PROP-0026-connected-sketch-display.md) /
[ADR-0027](../decisions/ADR-0027-connected-sketch-display.md), and
[PROP-0028](proposals/PROP-0028-normalize-question-wireframes.md) /
[ADR-0029](../decisions/ADR-0029-normalized-question-wireframe-borders.md). Isolated production
PTY verification is retained in `docs/evidence/terminal-wireframe-normalization/`; it establishes
cell topology for bounded fixtures, not every emulator/font or live-model sketch quality.

## Web annotations commands (PROP-0017)

`/annotate:notes` lists the Web annotations kept in the data root, with search, and offers reveal, edit, resolve or
reopen, share with this session or stop sharing, and delete. `/annotate:` opens the default capture pane;
`/annotate:annotate [url]` is its explicit command form. It opens a visible capture browser (its own window and profile, separate from the agent's browser), where the person can annotate the whole page,
select text, or click an element there. An annotation is private until shared; this session's agent then reads it with `page_notes_list`
and `page_notes_read`.

The annotate pane (PROP-0018) is a full-screen page beside the window being inspected.

- **Ways to start it:**
  - `/annotate:` or `/annotate:annotate [url]`: the capture browser
  - `/annotate:annotate --app <DevTools address | port> [name]`: an app's own windows over its DevTools port
  - `/annotate:annotate --bridge [name]`: app windows that load the page bridge script, which the pane shows
- **The inspector** (`i`) outlines components on hover. A click or a text drag opens a popover in the page with Create annotation, Ask agent to fix, and Proceed now.
- **Sections:** Queue, Sent and fixed (with the agent's summary), and Saved.
- **Other keys:** `s` sends the queue as one run of this session, confirming notes that came from a page-world script first; `x` takes a note out of the queue; `t` picks a window.
- **Routes:** `terminal.annotations.target|attach|windows|selectWindow|inspect|stopInspect|next|queue|dequeue|confirm|send` act only on this terminal's session and need the control key.

## Checklist (PROP-0006, PAR-001)

Terminal sessions register the shared `checklist_write` tool. The extension validates each list
with the same tool code and sends it as `checklist` telemetry; the controller emits it as
`checklist.updated` on the active run, so `runs.checklist` and continuation read terminal runs too.
The gate treats it as read-only, plan mode allows it, and terminal children inherit it. The
transcript shows each write as a checklist block (`✓` done, `●` in progress (warning yellow), `○` pending) under a
`Checklist · n of m done` header instead of a tool row; a failed or malformed call stays a tool row.

## Work-slice checkpoint (PROP-0041)

Terminal replies carry the same work-slice guard as structured runs: 160 tool calls, 40 minutes or
320 000 new tokens, then a refusal that asks for `checkpoint_write`. The extension registers the shared
tool and sends it as `checkpoint` telemetry, which the controller records as `checkpoint` on the
active run, so an App reading the same session sees the handoff. Terminal replies are not
auto-continued: at the boundary the person decides, which is what the terminal's own turn model
already does. The run record says `interrupted` with terminal reason `slice_complete` (or `stalled`
when the guard ended it), so a host can continue it; a checkpoint card in the transcript is not built
yet (PAR-004). Start the terminal with `XINGULAR_WORK_SLICE=off` to launch a reply with no
boundary at all; it is not persisted, so the next launch without it restores the guard.

## Subagent activity monitor

During an active parent run, the terminal polls a private read-only monitor once per second. It
projects the flat set of child and nested-child runs with task, status, elapsed time, the latest
tool name, the child's agent profile (name and colour, PROP-0029), the title the parent gave it
(PROP-0030), counts from the child's own checklist, the pinned account label, effective model and
effort, and cumulative usage totals. Model and effort come from the volatile launch selection; the
latest provider-reported model supersedes the launch model when usage is available. Usage is an
explicit projection of token, cache, cost, request-count and context-window totals. Per-request
payloads and reasoning summaries do not enter the monitor. The child's own `session_name` is not
projected; it names the child's session, not its row. Tool summaries, other arguments, output and
checklist item text never enter the monitor. The latest completed tool name remains visible across
one-second snapshots until new tool or response activity replaces it. The monitor exposes no
controls to steer or stop children.

The live rows sit under the status line, after one blank row, with no heading. Each row reads, in
order: the status mark (`○` queued, a running row that shows the working spinner's frame in the profile's colour (warning for a copy of the parent), `●` waiting in the accent,
`✓` done, `✕` failed, `!` stopped), the profile name in its colour (`subagent`, muted, for a copy
of the parent), the title the parent gave the child (PROP-0030), and `n of m tasks` when the child
keeps a checklist. Active rows come first, at most three, then `+N more · /subagents`; a narrow
terminal cuts the title first. `/subagents` opens the searchable full roster, with a colored
profile and normal-color title on its first line, then muted account, model, effort and usage
metadata on its second line. One blank row separates each two-line entry. Narrow rows truncate this
lower-priority summary without hiding the title.
At parent settlement, the terminal makes a final monitor read and keeps the latest parent's rows
visible until the next parent run starts. The projection remains volatile and read-only, is scoped to
the latest parent run in the terminal session, and is cleared on session replacement or terminal
disposal. It is not a persisted event or public server method.

## Agent profiles (PROP-0029)

`/agents` opens the Agents page over `terminal.agents.list|create|remove`, which call the same
`agents/profiles.ts` functions as `agents.*`. It lists built-in, global, project and variant
profiles, and files that cannot be read. The detail pane shows the colour, description, tools,
plugins, variant, model, effort, file and instructions. Enter on a row offers: for a person's own
profile, edit (opens the file in `$VISUAL`/`$EDITOR` with the renderer suspended), copy and delete
(confirmed); for a built-in or variant profile, copy. New profile asks for a name and a place
(project or global), writes the template and opens it. The terminal passes its pinned variant to
`Subagents.register`, so the variant's c5 names are profiles there too.
