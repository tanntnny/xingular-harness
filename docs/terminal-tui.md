# Harness terminal frontend

Status: terminal behavior and message-delivery contract
([known drift D-20](architecture/README.md#known-drift)).
Decision: [ADR-0001](decisions/ADR-0001-owned-terminal.md),
[ADR-0006](decisions/ADR-0006-opentui-only-terminal.md),
[ADR-0009](decisions/ADR-0009-xharness-command.md),
[ADR-0021](decisions/ADR-0021-required-command-namespaces.md),
[ADR-0024](decisions/ADR-0024-xagent-command.md),
[ADR-0026](decisions/ADR-0026-contextual-question-wireframes.md),
[ADR-0027](decisions/ADR-0027-connected-sketch-display.md),
[ADR-0028](decisions/ADR-0028-xingular-agent-product-identity.md).

## OpenTUI terminal

OpenTUI/Solid, built from [`src/terminal/opentui/`](../src/terminal/opentui/), is the only terminal
frontend. It needs Bun 1.3.14 or newer for its build and runtime:

```sh
npm run build:tui
node dist/cli.js terminal
```

`npm run build` builds `dist/terminal-opentui.js`; without Bun the build fails, because there is no
second frontend to fall back to. The harness passes `--conditions=browser` when it launches the
bundle so Solid resolves to its client build, not its server build. `XINGULAR_HARNESS_BUN`
overrides the Bun executable.

[`app.ts`](../src/terminal/opentui/app.ts) owns the terminal lifecycle and reuses the shared
`TerminalRuntime`, session replacement, commands, decisions, account pinning and run records. It
projects the runtime's snapshot and transcript into an OpenCode-inspired view, with a native
OpenTUI textarea for the prompt and `Ctrl+K` for the command palette. `Return` sends or queues a
follow-up; `Cmd+Return`, `Ctrl+Return` or `Alt+Return` steers a running reply, and `Shift+Return`
inserts a newline. Typing `/` at the start of the draft filters matching commands, and typing `$` at any word start
filters matching skills; `Tab` inserts the selected entry and leaves the cursor after it. A `$`
entry replaces only the token being typed, so text before and after it stays in place.
With an empty composer, unmodified Up recalls the latest non-empty user message from the active session.
With a draft, unmodified Up browses older history and Down browses newer history when the caret is at
either absolute draft endpoint (start or end). Down past the newest entry restores the draft, cursor
and attachments that were present when history browsing began. At non-endpoint positions, Up on the
first visual line moves the cursor to the first character and Down on the last visual line moves it
to the final character; elsewhere, Up/Down move the caret normally. Ctrl+Up/Down remain explicit
history shortcuts from anywhere. History includes
user messages and Bash commands from the active Pi session; recalled Bash commands return to `!`
mode. Executed slash commands from this terminal instance are included too, across session switches.
`/new` and `/session` (also `/resume`) switch the saved-message and Bash history to that session.
Modified Enter shortcuts depend on the terminal reporting the modifier distinctly; Cmd may require
the kitty keyboard protocol. In the composer, `Tab` opens up to eight matching filesystem entries for the path token at the cursor, or current-folder entries when the token is empty. The list has no heading or hint row. Up/Down select; Enter or Tab inserts the selection; Escape closes the list. Directories end in `/`, and Bash mode escapes shell-special characters. Use `/effort` or Shift+Up/Down to change effort. The command palette opens above the composer under a muted (`dim`) top rule, and has no other border. Its rows align slash commands and descriptions in two columns: the command column sizes to the widest visible name, bounded to preserve description space, and both columns wrap instead of truncating. The plan-choice rule, question block's top-only divider, and `/btw` block's top rule use the same muted color as the normal composer divider. The console has no background of its own: the renderer, root surface
and transcript are transparent, so the terminal's own background shows through, while panels,
dialogs and the scrim stay opaque. The composer has no panel background: it is bounded by a top and
a bottom rule, with the working status and spinner above it and a wrapping status bar below it. Its
fixed-width left gutter shows `❯` on the first input row and leaves continuation rows blank, including
explicit newlines and soft wraps; Bash mode shows `!` on the first row instead. In plan mode,
`plan mode` is right-aligned within the top rule, followed by exactly one divider character. The status bar shows the working folder's name and Git branch together as `<repo>:<branch>`, followed by the account, model and effort separated by spaces, and input (`↑`) and output (`↓`) token counts with each glyph adjacent to its count; `|` separates the groups. Token counts
below 1,000 show as whole numbers and larger counts use K/M/B suffixes. A leading `!`
enters Bash mode: the chevron becomes `!`, and the marker and both rules use the `bashMode` colour.
In plan mode, the marker and rules use the plan blue and `plan mode` is right-aligned within the
top rule with exactly one divider character after it; in the normal prompt, the marker matches the divider. The command body keeps the normal
text color. Every terminal animates the same star
glyphs (`·✢✳✶✻✽`) while working, with Ghostty's existing variant; there is no ASCII line fallback.
Extension dialogs, pages, custom editors, widgets, headers and footers keep using Pi's component
API through [`dialogHost.ts`](../src/terminal/opentui/dialogHost.ts): a small fake `TUI` renders
`Component.render(width)` ANSI into stacked overlays and forwards raw key sequences. Extensions
never receive an OpenTUI renderable or a second account. A theme an extension selects still colors
its own components, while the OpenTUI chrome keeps the fixed OpenCode-inspired palette. Component
UI is supported; an extension that draws only by writing raw ANSI through the TUI terminal is not.

Most pages become centered dialogs. The page commands `/permissions`, `/log`, the `/model` and
`/history` pickers, and
the `select`, `confirm`, `input` and `editor` dialogs (such as `/effort` and the Thinking setting),
take 80% of the terminal, capped at 100 columns by 30 rows, on a flat panel in the console's panel
colour. A full-screen scrim dims the console behind the panel so the transcript stays faintly
visible. Centered Harness dialogs fit their rendered content, capped by the available dialog
height, with four columns of horizontal padding and two rows of vertical padding to account for
the terminal's taller-than-wide cells. They use a plain title with a muted `Esc` hint and
omit divider rules and footer hints. Shortcut behavior remains available. Bracketed paste and the
clipboard-paste shortcut insert text into the active dialog input or search field, using that
component's input semantics; images and file attachments remain composer-only. Searchable lists share
the same glyph, placeholder, spacing, and muted result note, with search context included on that
row. A terminal too small for a 30-column by
12-row dialog falls back to the full-screen page chrome. A plugin's full-screen surface stays full
screen. `/settings` fills the terminal with its category tabs, search, settings list and full-screen
page chrome. `/accounts` also fills the terminal with Accounts/Pools tabs and search. Wide terminals
show selected-account details beside the list; opening an account reveals grouped actions in that
inspector. On compact terminals, opening an account replaces the list with a full-page detail view
and its grouped actions. `Enter` opens the selected account; `Esc` returns to the list. Tab and
Shift+Tab move focus between tabs, the list and (when open) actions; Left/Right changes a focused
tab and Up/Down moves the focused list or action list. Search, section and account selection survive
returning and resizing.
Account actions are grouped by Session, Account, Sign-in and Remove; pool
actions are grouped by Manage and Remove. Existing confirmations and account-service calls remain
unchanged. The Harness resource browser and all its shortcuts use a full-screen page with persistent
resource-section tabs.

The frontend is verified with a real isolated PTY and a loopback provider. Run
`python3 scripts/verify-terminal.py --welcome-only --sizes 40x20,80x24,120x40` to check the empty
welcome, product label, accent colors and `/help` transition. Run
`python3 scripts/verify-terminal.py --composer-only` for recognized slash-command colors in the composer
and a user bubble, enabled-skill colors in the composer (leading and after text), unknown-token and argument colors,
explicit-newline and soft-wrap checks of both prompt gutters, and normal/plan/Bash mode exclusivity.
Run it with `--sizes 40x20,80x24,120x40` for compact through wide layouts. Use `--dialog-paste-only` to verify bracketed paste into a centered
input dialog, `--file-completion-only` for filesystem completion and insertion,
`--history-only` for active-session history across `/new` and `/session`, `--resume-only` for the full-screen searchable, unnumbered two-line saved-session picker, `--help-only` for `/help` replacing the welcome screen with grouped two-column output that wraps without per-command gaps, `--questions-only` for multi-select marker glyphs, recommended choices,
selected-row and Continue/Submit colors, `--jump-latest-only` for scroll-away badge visibility and click-to-latest (screen-level click assertions use optional `pyte`), and choice-backed “Something else” answers, or `--thinking-only` for `/thinking` visibility toggles. The full suite covers a complete turn, `read`, `bash` approval, `ask_user_question` approval and picker, plugin overlay/widget/status
disposal, a completed run record with usage and decision events, `/help`, `/permissions`,
`/settings`, `/model`, palette selection, confirm cancel, and Ctrl+D exit. `--questions-only` checks
recommended choices, bounded literal ASCII sketch previews, focus-driven preview changes and answer
colors; run it with `--sizes 40x20,80x24,120x40` for compact through wide layouts. At 80 columns and
above it also checks wrapped notes and free-text; the narrowest run keeps the sketch and answer
interaction compact. The normal turn omits question tools; plan-mode flows exercise `ask_user` batches
and `ask_user_question` cancellation. Live-provider behavior, exact OpenCode parity and concurrent
session tabs are not established.

## Native subagents (2026-10-18)

Interactive terminal turns use the same `harness.subagents` service as SDK callers. The bridge
registers the current run's effective tools, resolved model, thinking level and pinned account
through its private control channel; a read-only terminal narrows child capabilities and broker
access. `spawn_subagent` returns immediately, `wait_subagents` joins selected children, and
`wait: true` on spawn returns an inline result. Native receipts deduplicate automatic delivery.
The terminal joins outstanding children before its final reply, projects child approvals/questions
with their original run IDs, and stops descendants when interrupted or disposed. Connected apps
need not be enabled. `TerminalPrepareInput.subagents: null` disables the capability.

The terminal also projects the latest parent's subagent descendants into rows under the status line
and a searchable `/subagents` page. The rows poll a private monitor route once per second
during a turn and make a final read at settlement. They sit one blank row below the status line, with
no heading, and each reads: the status mark, the agent profile name in its colour (`subagent` for a
copy of the parent), the title the parent gave the child (PROP-0030), and `n of m tasks` from the
child's own todo list. At most three show, active first, then `+N more · /subagents`. The
`/subagents` page uses a colored profile and normal-color title on the first line, then muted account,
effective model, effort and cumulative usage metadata on the second. One blank row separates each
two-line entry. The page also shows status, elapsed time and the latest tool name. Runtime metadata
stays in the private terminal projection.
Usage contains safe token/cache/cost/context totals, not per-request payloads or reasoning summaries.
The projection is read-only, flat across nested descendants, and scoped to the latest parent run in
this terminal session; finished rows remain visible until the next parent run starts. The page also
pins a `main` row for the parent run itself, with the same details; the rows under the status line
leave it out. Reopening a conversation (a new launch, `/resume`, or a switch) rebuilds the rows from
the branch's latest parent run and its saved child runs, with their final status, until the next run
starts. A switch to a conversation without one clears them, as does disposal. It never includes tool
arguments (beyond the title), output or todo item text.

An interrupted or failed child keeps its saved conversation. The next reply is told which children
stopped before it answers, and the parent continues one with `spawn_subagent { continue: <runId> }`,
which reopens that child's own history with its profile and tools (ADR-0043). Esc therefore does
not lose a child's progress.

`/agents` opens the Agents page (PROP-0029): built-in, global, project and variant profiles with
their tools, plugins, variant, model and instructions. Enter on a row edits a person's own profile
in `$VISUAL`/`$EDITOR`, copies one, or deletes one after confirmation; New profile writes a template
in the project or global folder and opens it.

Real scripted Pi execution over the actual terminal socket verifies result delivery, decision
routing, and the monitor's parent scoping and summary redaction. It does not establish live-provider
behavior. See
[ADR-0003](decisions/ADR-0003-shared-asynchronous-subagents.md) for recovery and lifecycle details.

## Ownership and process boundary

Harness owns its interactive terminal application in
[`src/terminal/opentui/`](../src/terminal/opentui/). [`app.ts`](../src/terminal/opentui/app.ts)
owns terminal lifecycle, submission, commands, decisions and run records;
[`root.tsx`](../src/terminal/opentui/root.tsx) owns composition, the transcript, the composer,
palette and dialogs. It does not construct Pi's `InteractiveMode`. Pi 1.4.0 supplies the
persistent agent session, model and auth runtime, native JSONL history, tool execution and rich
content components.

The parent process calls `Terminals.prepare()`, spawns its returned specification in a PTY or
inherited terminal, and eventually calls `dispose()`. Its command is Bun with
`--conditions=browser` and the built `dist/terminal-opentui.js`; it requires no global `pi`
command. `TerminalAssets` is `{ node, cli, piExtension, openTui }`, and the existing `prepare`,
`send`, `state`, `input` and `dispose` contracts remain in place. The `piExtension` path remains
the final prepared extension argument. The runtime recognizes that bridge position and loads its
trusted, bundled factory inline after the selected disk extensions.

```text
Harness parent: account + compiled context + trusted resources + run writer
       | launch specification / existing session socket
Harness terminal child: OpenTUI application + persistent Pi AgentSessionRuntime
       | typed native events / plugin UI callbacks
Harness screen: transcript above the composer, with centered page dialogs and blocks
```

[`runtime.ts`](../src/terminal/tui/runtime.ts) builds a public `AgentSessionRuntime` around
`createAgentSession`, `ModelRuntime`, `SessionManager` and `DefaultResourceLoader`. Events and
subscriptions survive session replacement. Before replacement it detaches extension UI; after
replacement it binds a fresh `ExtensionUIContext` in `tui` mode. Presentation reads frozen
`TerminalSnapshot` values; submission, interruption, navigation, decision polling and decision
responses pass through `TerminalRuntime`. Native components retain a scoped SDK adapter for
rich Markdown, tool and extension rendering. Native history remains owned by
Pi; Harness run records remain written through the existing controller/run store.

A persistent child retains queues, session-local extension state and interactive UI between
prompts. Reusing `sessions.run` for each prompt would recreate and dispose a session for every
turn and overlap the terminal controller's run lifecycle. That API remains the embedding and
unattended execution path.

## Screen layout

[`root.tsx`](../src/terminal/opentui/root.tsx) draws the terminal on OpenTUI's alternate screen.
An empty conversation shows a centered welcome. The default `Xingular Agent` identity appears as
an orange block `X` and blue letter-spaced `A G E N T`, followed by `Welcome.`, the tagline
`One run, done well.`, and a blue `/help` hint. Explicit host product names use the same generic mark and
subline formatting. The current model and thinking level remain available in dim text. Once a message
exists, a scrollable transcript fills the space above the composer. Single-line notices can appear
with the welcome, while multiline notices such as `/help` switch to the transcript layout so their
output cannot overlap it. The composer is a single top and bottom rule, with the right-aligned `plan mode` label followed by one divider character in the top rule,
and the textarea in the middle.
The working status row shows the active verb with a soft, warm glint that feathers across it and
fades past its edges, followed by run duration and the latest completed assistant response's output
rate, formatted as `(time, tok/s)`; the spinner and metrics stay steady, and duration updates during a run.
Until response usage is available, the rate shows `— tok/s`. On settlement, the completion verb and
final run statistics stay in that row until the next run replaces them; they do not become a transcript
entry. Notifications, queue announcements and retry updates—including retries while summarizing
context or branches—are one-line transcript entries at the point they occur, so subsequent chat
moves them up rather than keeping them pinned at the bottom.

While context compaction runs, the working line shows `Compacting context` (or `Retrying
compaction`) with the same spinner, in place of the working verb. During a run it keeps the run's
clock; a `/compact` while idle shows the spinner with its own clock. Compaction does not start a new
session or hide earlier chat. After it, the transcript shows, in order: the whole conversation from
before the compaction (rebuilt from Pi's session history, kept messages included); a rule labelled
`Context compacted · <tokens> tokens`; the summary printed as a normal reply; an `End of summary`
rule; then the work that followed. The summary is shown by default. Clicking either rule hides or
shows it, and Ctrl+O shows every summary again. On a narrow screen the rule drops the click hint, then
the token count. Earlier compactions in the same session keep their own rules and summary in place.
Notices stay after the message they followed. The model sees the summary and recent messages plus a
bounded, hidden checkpoint of the active request, todo list and plan instructions when available;
the checkpoint is regenerated for each post-compaction request until the run settles. The visible
transcript remains a presentation of the full history, not the model context.
Transcript entry ids follow positions in the displayed message list, so when a rebuilt list moves a
different kind of entry onto an id, the renderer builds a new component for it instead of reusing the
old layout, and each entry draws inside its own error boundary. A run therefore keeps updating live
through a compaction; it does not need `/resume` to show its later output.
A successful copy shows a temporary, opaque toast anchored at the terminal's top-right. Interactive blocks and widgets remain docked above the composer. A wrapping status bar
below the composer shows `<repo>:<branch>`, account, model, effort and token totals, with `|` between groups. After
the input token count it shows cache hit rate as `R<percentage>%`, calculated from cache reads divided
by total input tokens. The footer shows status messages without a shortcut-hint row. Press `?` with an empty
composer to open the shortcut reference. Transcript entries include
messages, thinking, tools, notices and extension ANSI components. Image blocks returned by tools
appear as separate image-result entries immediately after their tool call, within the scrollable
transcript; they move up with newer chat. The `/settings` Show images option controls whether the
image data is rendered. Mouse-wheel scrolling and PgUp/PgDn
move the transcript without moving the composer; Ctrl+Home and Ctrl+End jump to its beginning and
end. A narrow `▕` thumb marks transcript position at the right edge; its mouse and keyboard scrolling remain native. The transcript has one blank row between each pair of entries, including assistant replies,
thinking, tools, image results, notices, summaries, custom messages, user messages, plan cards and
Bash entries. User, plan and Bash bubbles also have one blank row of internal padding above and below
their content; other entries have no internal vertical padding. Bubble padding is additional to the
inter-entry gap. A plan card carries its title as an underlined header in the plan blue, then one
blank row before the plan body. Internal lines within an entry stay together. The transcript stays
pinned to the latest message until you scroll away. While scrolled away, a `↓ Jump to latest` badge overlays the
transcript's lower-right corner; clicking it returns to the newest message and hides the badge.
`Ctrl+End` remains an alternate way to jump to the end. A primary click in the transcript or empty
welcome area focuses the composer. Dragging to select text anywhere in the TUI—including the
composer, transcript, widgets, dialogs and pages—copies the selected plain text when selection ends;
a simple click does not copy. `/copy` and `Ctrl+X` continue to copy the latest assistant reply.

Mouse movement highlights the row under the pointer in the command palette, plan choices, question
dock, searchable dialogs and Harness page lists; the highlight uses the same selection style as
keyboard navigation. A primary click activates the row, and clicks on page tabs switch that page's
section. In `/accounts`, clicking an account opens its inspector or compact detail view, and clicking
an action runs the existing account flow. Question choices still stage their answer until the
question's action is clicked. Dialogs preserve their existing confirmation safeguards. OpenTUI enables terminal mouse-motion reporting for
hover; terminals or multiplexers that do not report motion retain keyboard navigation. ANSI-only
custom UI without a mouse handler remains keyboard-driven.

A mouse report the terminal delivers in two pieces across the input parser's timeout arrives as
printable keys. The composer and every single-line field drop the report's `<button;column;row>`
tail instead of keeping it, so a stray scroll never becomes a draft, a filter or a prompt; text typed
at human speed is untouched even when it spells the same shape. Recorded text never prints a
reported sequence on a page, and a bare tail that was recorded stays visible as recorded evidence.

Page dialogs and blocks are absolute overlays, so the transcript stays behind them. The screen
restores the terminal's alternate-screen state when the application exits.

### Markdown transcript

Assistant replies, plan-card bodies and Markdown image-result text share one style map. Heading
levels use the Harness palette; links are blue and underlined, and only their labels appear in the
transcript. Hovering a link changes the terminal pointer to a hand and recolours the link's own
text (`theme.linkHover`); the status line says nothing about it. The gesture that opens a link is
the one the platform uses: **Ctrl+click** where the terminal reports the modifier, and on macOS the
**primary click**, because ⌘ is not part of the terminal mouse protocol (a macOS terminal opens an
OSC 8 link itself on ⌘+click). Either way the link opens with the operating system's handler for
its kind: a web address in the browser, `mailto:` in the mail client, a file in its default
application, a folder in Finder. A click that opens a link leaves the composer focused. `core/links.ts` decides what
may open (ADR-0047): a relative path resolves against the session's folder, and an application
bundle, an installer, a launchable script or an executable file is refused with a notice instead of
being run. The launcher receives the address as one argument without a shell. OSC 8 metadata is
emitted where available, but link activation does not depend on terminal OSC 8 support; a terminal
that opens OSC 8 links itself acts on its own modifier, so the Harness keeps the primary click.
Inline and fenced code use a subtle panel fill with syntax colors. Emphasis, quotes, list markers,
tables, dividers and task-list markers use the existing titanium palette. Images display their alt
text and are not fetched or rendered as image files.

## Todo block

`todo_write` is registered in terminal sessions (PAR-001). Each call renders in the transcript as
a todo block: a status mark, `Todo · n of m done`, then one line per item with `✓` (done, success
colour), `●` (in progress, warning yellow, bold) or `○` (pending, dim). Each row reserves a one-cell
status column and one-cell gap; item text and wrapped lines share the same starting column. A call
whose arguments are not a todo list, or that failed, stays an ordinary tool row. The prompt's
Progress group asks the model to keep the list current and write a final update before replying;
unfinished work remains unfinished rather than being marked complete.

`/todo` (alias `/checklist`) appends a snapshot of the current list: the same header and rows, with
no status mark on the header, because it is not a tool call. It reads the latest non-side-question
run of this terminal's native session and makes no model request; an empty list is a one-line
notice.

## Blocks and pages

In Pi's own terminal UI, [`chrome.ts`](../src/terminal/tui/chrome.ts) gives terminal surfaces one
of two rule-based shapes, using the 2-cell composer gutter on each side and a dim hint row.

- A **block** docks at the bottom like the slash-command list above the composer. It has an amber
  (`warning`) rule, a bold title row with an optional dim note at the right edge (a dialog's
  countdown), the body, a hint row, and a neutral (`dim`) closing rule. It is as tall as its body.
  Approvals, questions, and the `select`, `confirm`, `input` and `editor` dialogs use this shape
  there. OpenTUI renders Harness-managed centered dialogs with the inset header treatment below.
- A **page** is a header row (title left, position or status right), a neutral rule, the body,
  a neutral rule, and the hint row. `/settings`, `/log`, `/permissions`, and the `/accounts`,
  `/plugins` and `/hub` menus are pages. Section labels inside a page are plain bold headings, never
  text set into a rule. `/trajectory` is a full-screen page with searchable Runs and Events
  tabs; its Events view keeps the event list beside the selected event's JSON on wide terminals.
  `/context` is a full-screen page with Request and Growth tabs: one bar that gives each kind of
  context its own colour — foundation blue, variant orange, your application green, conversation
  amber, the same four values as the App's `--data-1..4` tokens — with the track for free space and a
  `│` where Pi would start compacting, a legend naming every run, then one row per contributor (`❯` on the selected one, `·` for a section that arrives per request) reading
  `tokens` and `share`, group headings carrying their own total, the reserve and free space, and an
  On demand list. `space` folds a group, `enter` shows the text a row contributed, `g` regroups rows
  by owner or by kind, `c` compacts after a confirmation, and `v` opens `/harness`. It reads
  `terminal.context` and draws no figure it did not receive.

`DialogPanel` takes a `variant` (`block` by default). `ui.select` accepts a harness-owned `page`
option, which Pi's own dialogs ignore, so the same extension code runs in either terminal. Selected
rows keep the full-width `selectedBg` highlight and `❯` marker the slash-command list uses. Both
frontends draw that field from the same muted-blue selection palette (`selection.ts`) and use
explicit high-contrast text on it instead of the accent colour, so a choice reads the same in every
list. Rules use the theme's `warning` and `dim` colors, so a custom theme restyles them.

The broad Harness resource browser (PROP-0013) unifies Overview, Foundation, Variant, Skills,
Plugins, Connections, Tools and Library. `/harness` opens Overview; `/skills`, `/connections`
(`/mcp`), `/tools` and `/components` open sections. `/plugins` is a separate
full-screen local manager with Plugins, Trust and Packages tabs; `/hub` is a separate
full-screen Community catalog with Catalog and Installed tabs. Both keep a searchable
inventory beside selected-item details on wide terminals, stacking details below the list
on compact terminals. The existing Accounts, Permissions, Settings, Trajectory and Log
pages retain their own tabs.

`/settings` includes a Browser tab with the device-local **Private address access** setting. It is
off by default. Enabling it asks for confirmation and allows agent browsing and annotation capture
to reach localhost and private networks.

Within the broad `/harness` browser, resource sections share Installed/Discover and source filters.
Installed includes locally present resources; current-session availability comes only from the runtime
loader and active tool registry. Discover uses the unfiltered Hub service with All/Community/Official
filters and an explicit refresh. No matching Community entries is an empty result, never replaced with
built-in resources. The view preserves search across source switches and restores section selection.

The dedicated `/hub` Catalog shows Community entries across supported types only. Its Installed tab
shows receipts from every channel with the channel labeled. On each page entry, cached/bundled entries
appear first, then the remote catalog refreshes; the status keeps the origin, last-refresh time and any
stale/error feedback visible. Manual refresh remains available. Catalog installs are pinned to the
selected version, and Hub uninstalls remove only receipt-owned resources. Registry/document entries
offer a bounded payload Preview; Pi packages have no JSON payload Preview.

The `/plugins` manager keeps local switching, code trust and settings separate from public discovery.
Its Packages tab adds local package installation, update and removal. Hub-owned packages remain pinned
to exact catalog versions; removal goes through Hub receipt cleanup, and updating requires an explicit
Hub version replacement.

The browser fills the terminal (PROP-0014), with Overview, Foundation, Variant, Skills, Plugins,
Connections, Tools and Library as persistent top tabs. The section dropdown and sidebar are removed.
When the strip cannot fit, it shows the active tab and its position with previous/next navigation.
At 88 content columns, inventory sits beside an inspector containing metadata, actions and readable
content. Enter focuses the inspector. Its action rows group related tasks under Use, Inspect, Manage,
Access and Remove. Compact terminals show details/content within the active tab; resizing preserves
the selected resource and content position, clamped to the available height.

Tab/Shift+Tab focuses tabs, source, filter, toolbar actions, list and (when available) inspector.
Left/Right changes the focused tab or control; Enter on the tab strip returns to the inventory.
Ctrl+F focuses search. Escape returns from content to actions, returns to the list, clears search,
then closes. Mouse clicks select tabs directly, activate resource actions and focus filters;
wheel scrolling targets the list or inspector under the pointer. Other command pages keep their
centered presentation; `/settings`, `/accounts`, `/plugins` and `/hub` use full-screen page layouts.
Closing the browser preserves the composer draft and attachments.

Foundation explains fixed runtime ownership; it is read-only. Variant shows c1–c8 with the
prepared version and current head separately. It previews pinned files from the preparation
snapshot and compares their text with the latest saved version. No in-place editing or adoption
is added. Library skills and rules are added through `terminal.components.add`, which commits a
validated future version. Directory-backed variants stay read-only.

Skill browsing is independent of the Skill commands setting. Use inserts `$name` without submitting. Ctrl+K opens a separate command filter; choosing a browser section keeps
the existing draft text and attachment labels. Canceling the filter restores that draft. OpenTUI completes
loaded skills for a `$` at any word start; Enter or Tab inserts the selected skill rather than sending.
Plugin contributions, settings, attachment and code trust share one detail flow. Package install
and removal delegate to existing services; installing never trusts or activates code.

Connections supports local stdio and remote HTTP forms, masked credentials, explicit scope,
saved disabled defaults, explicit testing and OAuth sign-in. Browsing never starts an MCP process.
Saved test results show timestamps rather than claiming a live connection. A Hub connector document
is inert: a separate setup action validates supported remote-definition fields before opening the
normal connection form. Other document kinds stay inspectable data. Tools show their owner,
parameters, active state and saved approval; each call still passes the gate.

The typed model is `terminal/browser.ts`; the protected adapter is `terminal/browserControl.ts`.
The browser accepts resource IDs for bounded regular-file previews, not arbitrary paths. Local
skill import rejects symbolic links and limits bytes, files and traversal. See
[source study and wireframes](study/tui-resource-browser.md),
[PROP-0013](architecture/proposals/PROP-0013-resource-browser.md) and
[ADR-0015](decisions/ADR-0015-resource-browser.md).

## Annotate page (PROP-0018, PROP-0048)

`/annotate:` opens the full-screen annotate page beside the window being inspected. It has two tabs:
**Annotate** and **All annotations** (`/annotate:notes` opens on the second). Add a page address with
`/annotate: [url]`; without one, the page returns to the window that is still open, with its URL and
the inspector on, and asks for an address only when no window is open. The target window is one of:
- the visible capture browser
- an app's own windows over its DevTools port (`--app [port]`, or `a` in the page)
- app windows that loaded the page bridge script (`--bridge`)

The header shows the target and window and whether the inspector is on. Click a component in the
window and choose **Annotate** or **Annotate & send** (Cmd/Ctrl+Enter). Every annotation is shared
with this session; the list groups them as Unsent and Sent. While the inspector is on, the page polls
for the next popover comment every 400 ms, shows the result as a notice, and refreshes the list.

| Key | Action |
|---|---|
| `i` | inspector on/off |
| `s` | send every unsent annotation (page-origin ones are confirmed once first) |
| `o` | type a page address |
| `a` | apps with a DevTools port: pick one, type a port, start an app with one, or use the bridge |
| `t` | choose a window |
| `Enter` | the annotation menu |
| `Tab` | switch tab |

The Annotate tab has no search row, so these letters are free for actions. `/annotate:submit <request>`
sends the unsent annotations with your request after them; `/annotate:clear` resolves the unsent ones
and stops sharing them.

## Pending messages and barriers

The terminal shows pending steering, follow-up and deferred plan/Bash inputs above the working
line, one row per item: `Steer:` or `Follow-up:` in the accent blue for the two native queues, and a
muted `Plan:`, `Bash:` or `Prompt:` for deferred input, followed by the single-line text. A steering
message is intended for the active reply; a follow-up waits until it finishes. With no active reply,
a normal message starts a turn. Pi's steering and follow-up settings determine delivery within
those queues.

A queued plan or `!` Bash command is a barrier: it runs as a standalone turn after the current
response, and subsequent inputs wait behind it rather than entering Pi's native queues and
crossing the barrier. `Alt+Up` restores queued text to the draft; queued images are dropped, with
a warning for deferred images. Pi's queue projection can briefly include an item already taken
for delivery; identical queued text can also make its displayed removal ambiguous. Interrupting a
reply does not automatically clear native queues, and deferred work may run after it settles.

## Plan mode and thinking keys

Use `/plan <brief>` for one read-only planning request. A plan waits outside Pi's native follow-up
queue until the active response settles, then runs by itself. Later messages remain behind it, even
when Pi's follow-up mode is `all`. During that run the session narrows to read-only inspection
(`read`, `grep`, `find`, `ls`), web search/page reading, questions (`ask_user`, `ask_user_question`)
and recall (history and Wiki reads, `memory_facts`). The parent may also run Bash in the
OS-enforced read-only sandbox: no network and no writes except a discarded per-command temporary
directory (PROP-0043). It may delegate bounded research to a named profile whose effective tool and
plugin allowlists qualify for research; the child inherits plan mode and receives only the
intersection of the parent's frozen capabilities, profile and plan-research set. Children cannot
write, run commands, ask the user, use connectors or spawn more children; they remain bounded by the
configured work-slice policy without gaining `checkpoint_write`, and the Harness records an
evidence-derived checkpoint if the child stops at a boundary. Normal mode omits both question tools
from the active set; the plan request enables registered questions and research delegation
temporarily and restores the normal set when it settles, including on failure or interruption.
Providers may mark individual calls as safe for research; every other call is blocked before
approval. Edits, writes, memory writes and connected-app tools remain unavailable to parent and
child; generic browser controls are also blocked. Sandboxed read-only Bash is the parent's only
plan-mode shell exception; children cannot run commands. The plan instructions arrive as a
request-scoped prompt section, which the next ordinary request withdraws.

Each mode keeps its own model and effort for the account. Every selection the person makes (the model
picker, `/effort`, Shift+Up/Down, Ctrl+P) is saved against the mode it was made in, so Shift+Tab switches to that
mode's model and effort, and a new conversation starts on the normal mode's latest choice. A mode with no
choice of its own takes normal's, field by field; when neither has a saved effort, the mode uses Pi's
default level rather than keeping the level chosen in the other mode. A resumed conversation keeps the model in its history,
and a saved model the account cannot use is skipped. The choices live in the account's `choices.json`,
and the App reads and writes them through `accounts.choices` and `accounts.choose`.

A bare `/plan` toggles plan mode, and Shift+Tab cycles between normal and plan mode. Normal, plan
and Bash are mutually exclusive composer modes. While plan mode is on, each submitted message is sent
as a plan request through that same queue, and the composer's top and bottom rules take the plan colour.
Commands still run as commands. The model may run Bash during a plan request, only in the read-only sandbox scope (PROP-0043); your own `!` commands are not part of the plan. Entering Bash with a leading `!` exits plan mode; Shift+Tab from Bash
switches to plan mode and keeps the draft text. Turning plan mode off returns to normal mode. The old
on/off/toggle forms are rejected; a bare `/plan` is the switch.

When a plan request ends with a complete `<proposed_plan>` block, the terminal shows it as a bordered
card at the end of the reply, with the text around the block left as ordinary assistant text. A choice
block then appears above the composer with `Plan ready`, a blank row, then `Implement "<title>"` or
`Edit the plan`, followed by a blank row and the hint. Up and Down choose, Enter confirms, and Escape
dismisses it; the block yields to the composer as soon as the draft has text.
Implement leaves plan mode, so the normal tools and the mode's own model and effort come back, and sends
`Implement the plan: <title>`; the plan itself is already in the conversation. Edit the plan stays in plan
mode and focuses the composer, so the next message revises the plan and offers a new choice. A plan run
that was interrupted, failed, or had work queued behind it is not offered. If a completed plan run still
has no complete block after the harness's one repair attempt, the terminal shows a warning notice instead
of a plan choice; the plan request can be sent again.

A recognized leading slash command uses the selected theme's link color while typing and in its
user-message bubble. Only the command token is accented; arguments and unknown slash tokens keep the
normal text color. Recognition follows the active command registry, including built-in commands and
aliases, loaded extension and prompt commands, and enabled skill invocations written as
`/skill:name`.

SDK session runs receive plan instructions as a dynamic context update, leaving the stable system
prompt unchanged; their session gate refuses calls outside the read-only set. The standalone
terminal applies the same instructions and tool restrictions to each plan request. Shift+Up and
Shift+Down step the thinking level within the levels the model supports, and do not wrap. Use `/thinking` to toggle transcript thinking visibility, or `/thinking show` and `/thinking hide` to set it explicitly. This changes only whether thinking blocks appear in the transcript; it does not change model reasoning or effort, and it shares the Hide thinking setting with Ctrl+T and `/settings`.

## Bash command mode

Typing or pasting `!` at the start of the composer enters Bash mode: the first-row prompt marker
changes from `❯` to `!`, and the `!` and the composer rules use the `bashMode` theme color while the
command body keeps the normal text color. Continuation rows keep their blank gutter. Entering Bash
exits plan mode; Shift+Tab from Bash switches to plan mode and preserves the draft. Plan mode colors
the marker and rules blue; in the normal prompt, the marker matches the divider color. Backspace on
an empty Bash body returns to the normal prompt. Submitting while a reply is active queues
the command as a standalone turn; it does not steer the current model request.

The terminal checks Bash policy before using Pi's native `executeBash`. Ordinary `!command` runs
workspace-scoped; `!outside <command>` explicitly requests human-only approval before the command
runs once with broader filesystem access. The complete command is shown as escaped, scrollable
approval details; if the terminal is too small to show both details and choices, the request is
denied. Shell output never triggers approval or replay. Output streams into the transcript while the
command runs, so browser-login URLs are visible before the
command finishes; the running item shows that Escape stops the command. The native result is
recorded in run activity and session history before the model is prompted to read and explain it.
This does not attach interactive stdin to the shell. SDK callers may opt into this behavior with
`SessionRunInput.initialBashCommand`; it is restricted to a new interactive user turn and the
session runner applies the same Bash gate and explicit outside-scope request.

## Reference and reproduced presentation

The reference is **Oh My Pi 18.11.3**, identified from npm and GitHub on 2026-10-17; its release
publication timestamp was 2026-10-16T21:45:36Z. Inspection used the shipped npm package sources,
not an arbitrary checkout of upstream main. The source repository is
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

| Inspected artifact | SHA-256 |
|---|---|
| `@oh-my-pi/pi-coding-agent@18.11.3` npm tarball | `b4a4eaf8057a7591f4ca83be293780489fd72b174e6a629d4704320165177f09` |
| `@oh-my-pi/pi-tui@18.11.3` npm tarball | `d28351b1309474eaf02f9be0fdd59c099ba9b8baeec811ef61349facf7a3565c` |
| Native `omp` artifact used for observation | `d518310d647d467a2c5c3f2d38e34489a761996d766395c03b37c61a2203d02b` |

In the extracted `pi-tui` package, `src/theme/defaults/titanium.json` establishes the titanium
palette and its indexed-color fallbacks. Harness adapts these into
[`theme.ts`](../src/terminal/tui/theme.ts) and
[`opentui/theme.ts`](../src/terminal/opentui/theme.ts). The OpenTUI status bar shows the project name and
branch together as `<repo>:<branch>`, followed by account, model and current-session
input/output totals. Input totals add cache reads and exclude cache writes; its `R<percentage>%`
hit rate is cache reads divided by total input. Token counts below 1,000 show as whole numbers;
larger counts use floor-rounded K/M/B suffixes without decimals. The band carries no context-use
reading; `/context` reports the share of the window.

The OpenTUI composer follows the observed composer of Claude Code 2.1.302, reproduced from its
visible values; no code is copied. The command palette follows the same borderless convention.
Startup selects the Harness titanium presentation without rewriting the user's saved theme
settings. The shipped OMP light palette is also available as `light`; native rich components and
the OpenTUI chrome switch together. Missing Pi-specific color tokens use documented Harness
fallbacks in `theme.ts`.

The frontend exposes capabilities already present in Harness/Pi. It does not import OMP's
agent runtime, tools, providers, MCP implementation, task system or other product features.
OpenTUI owns screen composition and transcript rendering. Dialogs and extensions continue to use
Pi's component API through `dialogHost.ts`. Image blocks returned by tools appear as separate
scrollable image-result entries, rendered inline when `/settings` Show images is on; Markdown
images continue to show alt text only. This is an implementation of the requested terminal
presentation; complete visual or behavioral parity with every OMP surface has not been established.

Full upstream copyright and MIT permission notices are in [NOTICE.md](../NOTICE.md).

## Runtime compatibility adapter

Most integration uses public Pi exports. [`piAdapter.ts`](../src/terminal/tui/piAdapter.ts)
contains the remaining presentation dependencies and requires exactly Pi **1.4.0** before
loading them. The shared [`runtime.ts`](../src/pi/runtime.ts) loader imports Pi first, then invokes
the same HTTP dispatcher hook as Pi's CLI before any Harness Pi runtime is used. This reapplies
the process `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` settings after Pi's bundled Undici has
loaded. Account and model checks, sessions, maintenance, plugin discovery and installation,
pricing, and the standalone terminal all use this loader. It is process-wide and coalesces
concurrent initialization.

| Internal dependency | Reason |
|---|---|
| `dist/bundle/chunks/chunk-MM3LKT73.js:configureHttpDispatcher` | Restore Pi's environment-aware HTTP proxy dispatcher after the SDK import |
| `dist/extensions/index.js` builtin inventory | Preserve selected `llama.cpp`, `codemode`, `tool-search` and MCP builtins with the CLI's replacement semantics |
| `dist/modes/interactive/theme/theme.js:setThemeInstance` | Keep public native rich components on the same active theme as the Harness screen |
| `dist/core/tools/renderers/index.js:withBuiltInRenderers` | Preserve existing read/edit/bash/write formatting without replacing tool execution |
| `dist/utils/clipboard.js` and `clipboard-image.js` read helpers | Preserve explicit user clipboard paste behavior; these are not called during inspection or startup |

The adapter is initialized once; its global theme setter and renderer lookup are synchronous
thereafter. A Pi dependency upgrade must update this adapter deliberately and rerun the
terminal compatibility tests. The dispatcher compatibility check also pins the private Pi bundle
chunk and fails with a clear error if that hook moves or disappears. A local proxy fixture test
checks that a Pi HTTP request reaches the configured proxy without contacting an external host.
These module imports do not instantiate `InteractiveMode`.

## Attachments: images and large pastes

Images are sent to the model as image content in the same user message, not as file paths
(`TerminalRuntime.submit(text, followUp, images)` and `submitPlan(text, images)` pass Pi's
`PromptOptions.images`). [`attachments.ts`](../src/terminal/opentui/attachments.ts) holds the
draft's attachments; [`composerMarks.ts`](../src/terminal/opentui/composerMarks.ts) keeps one
virtual OpenTUI extmark on each label, so the label is drawn in the `attachment` colour and the
cursor, Backspace and Delete treat it as one unit.

- **Cmd+V, drag and drop.** The composer intercepts the terminal's bracketed paste. An empty paste
  (what terminals send when the clipboard holds only an image) reads the clipboard; a paste made
  only of existing image paths — escaped, quoted, `file://` or one unescaped path — attaches those
  files. `Ctrl+V` (and `Alt+V`) on macOS, `Ctrl+V` elsewhere, read the clipboard directly, and a
  `super+v` key from a terminal that forwards Cmd+V does the same.
- **Labels.** An image shows as `[Image #n]`. A paste of more than three lines or 800 characters
  shows as `[Pasted text #n +L lines]` (or `… N chars]`). Numbering restarts after each send.
- **Deleting.** Backspace or Delete next to a label removes it whole. A word or line delete that
  cuts into a label removes the rest of it, and the attachment goes with it.
- **Sending.** Pasted text is put back in place of its label; image labels stay in the text so the
  model can refer to "Image #1", and the images follow in label order. Sent user messages colour
  `[Image #n]` the same way. Images are resized with Pi's `resizeImage`; one that cannot be
  shrunk and is over 5 MB is refused.
- **Refusals.** A model whose `input` lacks `image` refuses the attach with a notice naming the
  model. Bash mode and plugin editors take no images. A slash command or Bash command sent with
  images runs without them, with a warning. Alt+Up (dequeue) restores queued text and drops
  queued images; deferred images produce a warning.

Finder-copied file paths are read before clipboard image pixels. On macOS, `.heic` and `.heif`
files are converted with `/usr/bin/sips` to private temporary PNGs, preserving the copied path
order and leaving the originals untouched; temporary files are removed when the terminal shuts
down. Clipboard image pixels go through Pi's native adapter, which reads PNG/TIFF on macOS and
normalizes TIFF to PNG. `python3 scripts/verify-terminal.py --attachments-only` checks a dropped
image path, label colour, collapsed pastes, whole-label Backspace and Alt+Backspace, and that the
loopback provider receives an image part and the expanded text. Whether a given emulator sends an
empty bracketed paste for an image-only clipboard has to be checked by hand in that emulator.

## Accounts, history and resource trust

The child requires the prepared absolute `PI_CODING_AGENT_DIR`; there is no fallback to a
personal Pi profile. Provider authentication and model catalogs use that account's files.
The selected account stays pinned. The existing `/accounts` command requests a parent-managed
restart to use a different account while resuming the conversation.

An initial `--session` option or `/session` target (also accepted as `/resume`) must resolve inside the prepared history directory,
including symlink targets, and its stored absolute working folder must match the terminal's
canonical working folder. `/import` may copy an explicitly selected external native JSONL file
only when its recorded working folder matches. A caller cannot override a foreign recorded
folder to borrow the current project's permissions. Lifecycle navigation and reload refuse an
active response; cancel it first. Opening a conversation from another working folder requires
opening that folder's terminal and preparing a fresh context/resource scope.

Navigation revalidates resource trust before tearing down the current runtime. The resource
loader suppresses its own discovery and uses only the prepared extensions,
skills, prompts and themes. Before **every** loader reload, including startup and native
session replacements, the child calls protected `terminal.resources`. The parent reruns
`Plugins.loading` for the original scope and compares selected paths and content/trust
identities with the preparation snapshot. Changed, detached or revoked code requires review
and a fresh terminal. Explicit `/reload` validates before invalidating the current session.
The Harness approval extension remains last, so it gates the final tool arguments.

## Private control and user decisions

The environment contains a session socket address and bearer token. The frontend claims a
second key once with `control.claim`, before plugin code loads. [`control.ts`](../src/terminal/control.ts)
retains it in a process-local promise shared with the bridge; it is never written to disk or
placed in the environment. It survives `/new`, resume, fork and reload.

The private key is required for `terminal.policy`, `terminal.approval`, `terminal.pending`, `terminal.pending.wait`,
`terminal.approve`, `terminal.answer`, `terminal.draft`, `terminal.interrupt` and
`terminal.resources`, as well as existing account and plugin mutations. A model-spawned shell with
only the environment token cannot submit policy or approval decisions, change permissions, or
answer its own pending questions. The application renders decisions obtained from the existing
controller and returns the person's answer through these calls.
The frontend waits on revisioned decision snapshots instead of polling continuously; a bounded wait
and reconnect resynchronize the inbox after a lost connection.

Approval prompts offer **Allow once**, **Always allow this tool everywhere** when the host policy
marks the decision rememberable, and **Deny**. A tool grant covers every call with that tool name
in Pi terminal sessions using this device's local Harness state directory; for example, Bash grants
cover every Bash command. `/permissions` lists those grants and lets the person revoke them. Its
Full Permission switch approves future eligible prompts across those terminal sessions, asks for
confirmation when enabled, and is off by default. Neither choice approves an already-pending
request. Hard denials and disabled tools remain enforced; human-only requests stay manual unless
the host explicitly permits Full Permission for them. Chat approvals keep their separate profile.

The editor sends exact draft state to `terminal.draft`; host delivery waits for that state
instead of overwriting a draft. Interruption resolves pending socket-backed questions and
approvals in the run registry before awaiting Pi abort. Disposal uses that order too, avoiding
a tool waiting forever on a question after the screen has closed. Native `session_shutdown`
clears controller readiness and stops that session's poller; the replacement's `session_start`
restores readiness while retaining the same process control claim.

The bridge registers the shared `ask_user` batch tool alongside the single-question
`ask_user_question` contract; only plan requests activate them. Each question has a concise 1–2 word
label, at least one choice, and at least one recommended choice; recommendations remain visual and
never preselect. Choice-based questions also retain a free-text “Something else” answer. A pending
question occupies the composer position in a flat block, not a modal, with the chat transcript
above it. The dock fits its content and grows to at most two-thirds of the terminal height; each
question tab is sized from its own content. When content overflows, its body scrolls while tabs and
answer/action controls stay outside that region.
The final choice sits one blank row above “Something else”. The block has only a muted top divider
and separates its hint from the content by one blank line; below 60 terminal columns, it uses a
compact hint. While the dock is active, PageUp/PageDown scroll its body and Ctrl+Home/End jump to
its beginning/end instead of the transcript. Focused choices and note fields are brought into view.
A tab strip shows each question label above the active question title, with one blank row below the tabs
and below the title;
clicking a tab or using Left/Right changes questions without discarding staged answers. The header has
no pager controls, and the block cannot be collapsed. Choices and descriptions appear above the numbered free-text answer and Continue or Skip
action. Selected choices fill the whole row with subtle dark green; Continue and Submit uses a
green-filled button, while Skip remains neutral. While the block is active, the chat composer and
its lower status bar are hidden. Tab and Shift+Tab move through the available controls; `n` opens a
note for the focused selected choice. Its editor appears below that choice, aligned with the description
column, and begins with an accent-colored `Note:` label. Tab only visits note fields that are already
open. Notes are submitted by choice label and cleared when that choice is deselected. Notes and
free-text answers wrap across lines. Tab takes precedence over normal thinking and plan-mode shortcuts. Up
and Down navigate choices. Enter selects a choice, activates the focused action, or submits the
answer or note field. Escape cancels the pending question and interrupts the run. A refused answer
keeps the dock, its choices, notes and typed text, shows the reason inside the dock, and can be
submitted again after the change; writing a different answer clears the message.

Questions may set `uiSketch: true` to enable a choice sketch preview. Every choice must then include
an ASCII sketch of 1–24 LF-separated lines, no more than 80 printable ASCII characters per line
(1,943 bytes maximum), and at least one visible character. Tabs, CR, controls, escape sequences and
non-ASCII text are rejected. Without the flag, choice sketches are rejected. Tool guidance asks for
contextual UI wireframes with actual panel/table structure and neighboring elements, consistent
across alternatives, rather than isolated decorative diagrams; quality is not a schema guarantee.

The dock uses one shared measured layout for all choices: marker gutter, one-third label cell,
two-cell gap, and remaining description cell. Boundaries align across rows at every width, including
compact terminals; both cells wrap independently, missing descriptions keep their cell, and columns
never stack. Recommendation text becomes `(Rec.)` when the label column is fewer than 14 cells.
Multi-select choices use `✓` when selected and `○` when unselected, matching checklist glyphs;
single-choice options remain numbered.

One shared border-only monospace preview below the choices follows the hovered choice, falling
back to keyboard focus. It has no visible caption or extra left rule. Under the approved
[PROP-0026](architecture/proposals/PROP-0026-connected-sketch-display.md) /
[ADR-0027](decisions/ADR-0027-connected-sketch-display.md) and
[PROP-0028](architecture/proposals/PROP-0028-normalize-question-wireframes.md) /
[ADR-0029](decisions/ADR-0029-normalized-question-wireframe-borders.md) amendments,
the terminal display uses a bounded structural projection in
`src/terminal/opentui/sketchPanel.ts`: recognized ASCII table-border rows—including title-bearing
top rules—and enclosed vertical table edges become connected box-drawing glyphs. Internal framed
tables keep their original widths and positions. Within a high-confidence frame, a missing side
edge may be filled or a displaced edge moved only through whitespace to matched corner columns;
interior text and ambiguous rows remain literal. Bare standalone hyphen divider rows expand to
`max(panel viewport width, original sketch widest line)` and attach to the outer single-line frame
with `├` and `┤`. Prose, content operators, ordinary pipes and unrecognized rows remain literal;
there is no global `+|-` substitution. The original validated ASCII source, including whitespace,
is persisted untouched; normalization and projected glyphs are display-only.

A bounded two-axis viewport exposes all overflow without wrapping, reflow, truncation or
Markdown/ANSI interpretation. Shift+arrows pan the sketch; ordinary arrows retain question/choice
navigation. Hosts may keep literal previews of that same source. The preview does not change the
selected answer, and sketch metadata is not included in the answer event. The 80×24 source bounds
and dock layout remain as specified by
[PROP-0025](architecture/proposals/PROP-0025-contextual-question-wireframes.md) and
[ADR-0026](decisions/ADR-0026-contextual-question-wireframes.md). Isolated production PTY evidence
for [PROP-0026](architecture/proposals/PROP-0026-connected-sketch-display.md) and
[PROP-0028](architecture/proposals/PROP-0028-normalize-question-wireframes.md) is retained under
`docs/evidence/terminal-wireframe-normalization/`; it does not claim every-emulator rendering or
live-model sketch quality.

Recommended choices appear first with a warning-colored marker, without changing their labels or
preselecting them; every question requires at least one recommendation. A single-choice question
allows at most one recommendation, while multi-select questions may recommend several. The frontend stages each answer locally and submits the complete
batch together through protected `terminal.answers`; a single question uses `terminal.answer`. The
registry validates answers before resolving the request. If a request disappears, its block and
staged answers are discarded.

Plugin UI methods carry a generation guard, including methods a plugin retained before an
`await`. Session replacement, reload and disposal revoke the old generation. Outgoing native
event subscriptions and custom transcript components detach before native invalidation.
Cleanup failures cannot prevent terminal restoration. Fatal asynchronous errors restore the
terminal and exit with failure; startup failures and suspend/resume use the same lifecycle.

The command registry supplies help and slash completion for Harness commands, loaded extensions
and prompts. `/session` selects a saved session (`/resume` remains an alias), and `/history` navigates
branches in the current session (`/tree` remains an alias). `/btw <question>` asks a side question;
`/side` is its alias. Help and the slash-command palette show each pair once, as `/session (resume)`,
`/history (tree)` and `/btw (side)`; aliases still match palette searches.
With no path argument, `/session` opens a full-screen searchable page. Each unnumbered row shows a
normal-color title and a muted second line with relative activity time, `<project>:<branch>` and JSONL
file size separated by ` · `. One blank line separates each session. Enter resumes the selected
session; account and folder scope checks
remain enforced. Supplying an explicit path continues directly without opening the picker.
The `$` palette completes enabled skill invocations using the same two-column palette as slash
commands, at any word start in the draft; `/skills` always browses skills. Choosing a skill inserts
`$name` at the caret without submitting. Every recognized `$name` that names a loaded skill uses the
blue accent in the composer, while its arguments, unavailable names and ordinary currency text keep
the normal color. Sending a message that contains `$name` makes that skill required for the request:
the terminal appends its text and the requirement as a hidden request-scoped message, and the
person's wording is sent unchanged. `/help` renders the command list as one
transcript entry, grouped under Core, Run, Model, Session, Inspect, Harness, Plugins and Prompts;
command names and descriptions wrap in aligned columns, with no blank rows between choices. `/plugins`
opens the focused local manager; its Packages tab installs, updates and removes packages with protected
Harness operations. Settings use `plugins.configure`; on/off settings and bounded whole-number settings
keep their existing ranges. Saved settings are read when the plugin next uses them and do not require a
restart. The standalone
terminal no longer has separate `/login`, `/trust`, `/bug`, `/changelog`, `/share`, `/scoped-mode` or
`/import` commands. `/btw <question>` (or `/side <question>`) starts a separate Harness run with the
main run's effective instructions, visible conversation and redacted public tool inputs/results.
Hidden reasoning and image bytes are excluded; the side run has no tools. Its block puts the
question after `/btw`, shows the normal animated spinner while answering, renders the answer as
Markdown, and separates the answer and hint by one blank row; it has no status labels. Headings,
emphasis, lists, quotes, links, tables and fenced code keep the theme's markdown colours, and a
streaming answer re-renders as it grows. PageUp/PageDown, or the mouse wheel over the block, browse
an answer taller than the block; Ctrl+X copies the full answer. Escape or either command with no
question dismisses the dock and interrupts
only that side run; the main reply continues. `/stop` interrupts the current main reply. The `/accounts` page handles sign-in
and sign-out. `/components` browses reusable skills, prompts and rules; a confirmed skill or rule addition
creates a variant version for future sessions while the current terminal keeps its pinned version. `/reload` applies trusted resource and keybinding changes.

`/trajectory` opens the newest recorded run for the current native conversation; `/trajectory <run-id>`
opens a selected run from that conversation. The full-screen page keeps searchable Runs and Events
tabs. In Events, the list sits beside the selected event's JSON on wide terminals and stacks above it
on compact terminals. Type to search run IDs, goals, event types, timestamps, summaries and payload
text; `[` and `]` change runs, up/down selects events, PageUp/PageDown scrolls event details, and
`Shift+C` copies the selected event JSON. Active runs refresh while the page is open. The protected
terminal socket scopes both the run list and event reads to the current terminal and native session file.

`/log` opens a centered page dialog with separate Harness diagnostics and current-conversation
run-event views. The diagnostic file is read at its captured size in bounded socket chunks. Tab/Shift+Tab
switches views; arrows, PageUp/PageDown, Home and End scroll; Escape closes. Fetch
diagnostics retain available error stacks and safe request metadata, while the viewer redacts secrets
and URL queries and omits response bodies, prompts and message contents. Embedded hosts without a
`harness.log` still show the conversation's recorded run events.

## Slash command ownership

Harness core commands are unprefixed and live in the core terminal command registry, independently
of feature-plugin command metadata: `/doctor`, `/worktree`, `/trajectory`, `/subagents`, and `/agents`.
`/history` (also `/tree`) continues to navigate session branches. `/mcp` and `/connections` open the
Connections browser. Feature descriptors and their services remain registered; only these terminal
routes move out of the plugin command registry. Other plugin-owned commands continue to use
`/<owner-prefix>:<command>`. The annotations plugin uses `/annotate:notes`, `/annotate:submit` and
`/annotate:clear`; `/annotate:` opens its annotate page (a root-only command with no named route). Pi package extensions use their normalized package name
as owner prefix unless `harness.commandPrefix` overrides it; loose extensions use their normalized
extension name. A plugin prefix collision or a duplicate command within one owner is rejected with
owner paths in the diagnostic. The former owner-qualified and `/plugin:<command>` routes of promoted
Harness commands remain hidden compatibility aliases for one release, omitted from help and
completion. Prompt templates and `/skill:<name>` keep their existing forms.

## Input performance profile

`npm run profile:terminal-latency` (`scripts/profile-terminal-latency.py`) types into the real
terminal in a PTY and times each key until it is visible on a virtual screen, while idle, after a
long tool history, while a reply streams, and with an approval or question waiting. It can run pure
Pi and opencode the same way for comparison; method and results are in
[EXP-0002](experiments/EXP-0002-opentui-typing-latency/results.md).
`npm run profile:terminal-input` still measures the local draft-control socket on its own.

How the frontend keeps typing fast:

- **Rendering on demand.** The renderer is not started in continuous mode, so a key is drawn as soon
  as it arrives instead of waiting for the next fixed tick; `maxFps` is 120.
- **Fine-grained view.** `root.tsx` keeps the application view in a Solid store and reconciles each
  update by item id, so a streamed delta updates one markdown block in place (`streaming` is passed
  to `<markdown>`) and a keystroke does not redraw the transcript.
- **Coalesced background updates.** `change()` publishes runtime events at most once per frame,
  33 ms while a run is active. A person's input (keys, the composer, the question dock) publishes at
  once and synchronously, in order with the composer's own events.
- **Draft read at key time.** The composer reports its text in a microtask, after all keys of one
  input chunk; the root reads the composer before each key so Enter never sends a stale draft.
- **Cached derived data.** Finished messages keep their transcript items until their position or tool
  results change; session statistics refresh at most every 250 ms during a run.
- **Kept connections.** Session-socket requests ask to `keep` their connection, so the two 100 ms
  polls and per-key draft updates reuse a connection instead of opening one each.
- **No swallowed keys.** While a question is active, an unused printable character moves focus to
  “Something else” and is typed there when free text is allowed; it never creates a hidden chat draft.

## Verification and remaining limits

Release-candidate verification, 2026-10-19: clean `npm ci` and `npm run ci` passed—541 tests
(two skipped), typecheck, build and standalone proof. In the sibling App, typecheck, layer check and
sidecar build passed; its renderer tests passed (561), but one sidecar screenshot assertion and two
Rust tests failed in the broader in-progress App worktree. Those failures do not touch the Harness
release files; the App changes were not included in this package.

OpenTUI verification, 2026-10-20: the OpenTUI unit tests cover the transcript model, palette,
Bash mode, dialog geometry, composer, theme and component host. Targeted PTY probes against the
production bundle cover centered page dialogs at 40×20, 80×24 and 120×40, palette ranking, and
Bash mode through its approval gate; see
[docs/evidence/terminal-2026-10-20-console-tui](evidence/terminal-2026-10-20-console-tui/README.md).
The full `scripts/verify-terminal.py` run under OpenTUI stops at `/settings` because the verifier
sends the command and Return in one burst; the targeted probes send them separately. Run
`python3 scripts/verify-terminal.py --sizes 80x24 --click-focus-only` to check composer focus from
the empty welcome area, transcript text and blank transcript space in an isolated PTY.

Earlier fullscreen-layout verification, 2026-10-18, covered the removed Pi frontend's dock,
notice clipping, regular flow and exit copy. It is retained as history in
[docs/evidence/terminal-2026-10-18-fullscreen](evidence/terminal-2026-10-18-fullscreen/verification.json).

Earlier verification, before the fullscreen layout: Harness typecheck, **419 passing tests / two platform skips**, build and standalone proof
passed on 2026-10-17. A final cleanup-order adjustment was rechecked with all **91 frontend
tests**, typecheck, build and standalone proof. Coverage includes the real isolated persistent SDK/socket boundary,
exact history scope and symlink rejection, resource-trust refusal before new/reload, event and
UI rebinding, retained stale plugin callbacks, immutable snapshots, commands, keybinding reload,
modal/focus behavior, grouped answers, Unicode widths and cleanup failures. Tests make no
external provider request.

The controlled production PTY verifier exercises the real CLI, persistent SDK, native tools,
final gate/socket and run writer using a loopback OpenAI-compatible SSE fixture. See the
[retained result](evidence/terminal-2026-10-17-followup/verification.json) and its compressed
ANSI captures. The earlier [three-size result](evidence/terminal-2026-10-17/verification.json)
is retained separately. Fixture responses verify transport and actual runtime/tool behavior;
they do not establish commercial-provider or OAuth availability.

The final three-size acceptance run covers 40×20, 80×24 and 120×40, live resizing, streaming,
thinking, actual read/bash execution, approval allow/deny/Escape, grouped and single questions,
question cancellation, account switching/restart, new/resume, trusted plugin custom overlays,
widgets/status, light-theme switching, tool expansion and scrolling. It also checks
suspend/resume, fatal asynchronous plugin failure and plugin startup failure. Normal exits
restore terminal attributes, bracketed paste and cursor visibility; failure cases restore them
and exit 1. Each report binds the exact CLI and verifier SHA-256 digests.

After the user reported that the global command still displayed Pi, inspection found an older
installed 0.1.6 bundle despite the checkout sharing that version. The checkout build was packed
and installed locally, without publication or account-data changes. The installed CLI now matches
the tested build byte for byte and passed all 14 isolated PTY groups at 80×24. See the
[global installation evidence](evidence/terminal-2026-10-17-followup/global-install/README.md).
Already-running sessions need to exit and relaunch to load the replacement.

A direct REA comparison of the pinned OMP executable and Harness at 80×24 captures startup and
settings without output truncation; both exit 0. The [readable comparison](evidence/terminal-2026-10-17-followup/reference-comparison.md)
retains exact frame/evidence IDs. It established matching centered welcome/composer geometry,
rounded settings framing (since replaced by [pages](#blocks-and-pages)) and the need for flat settings rows at 80 columns; the latter was
corrected using the shipped SettingsList's minimum editable-pane width. Product lockups, tips,
capability tabs, setting names, paths and unavailable-model guidance differ deliberately.
This is bounded visual review, not proof of equivalence for every OMP surface.

The App sidecar build passed, and its actual bundled `dist/cli.js` passed the same **14 PTY
interaction groups at 80×24**, including account restart, suspension and both failure cleanup
cases. Its [separate report](evidence/terminal-2026-10-17-followup/app-bundle/verification.json)
binds that bundle digest. App typecheck, layer/UI checks, all **29 sidecar tests**, and **215 Rust tests** passed (one Rust
test ignored). The full renderer run remains blocked by the existing untracked
`PendingRequestDock.test.ts:68` expectation for `Planner needs your answer`; those App UI files
were preserved. The combined App test script stops there, so sidecar tests were run separately.

The user-authorized personal Codex live attempt used a disposable Harness profile and only
an unexpired copied access token. Codex returned **“The usage limit has been reached”** before
a successful response or tool execution. Harness persisted the failed run and restored the
terminal; the source sign-in file was unchanged and the disposable credentials were deleted.
The [live report and capture](evidence/terminal-2026-10-17-followup/live-codex/README.md) retain
this quota failure explicitly. Successful live streaming/tool acceptance remains open until
account capacity is available. GitHub gist publication, actual OS clipboard pixel transfer,
Windows behavior and every terminal emulator remain unverified. HEIC/HEIF file staging has focused
conversion tests; that does not establish Finder or Warp OS interaction. Rich image/diff rendering
and clipboard adapters have focused compatibility tests; that does not establish OS interaction. These changes shipped in
`@xingular/harness` 2.0.0 (commit `44471bc`), while the complete plan's acceptance remains
open pending the required integration and provider evidence.

To reproduce the controlled scenario after building:

```sh
npm run build
python3 scripts/verify-terminal.py --save-evidence docs/evidence/terminal-2026-10-17-followup
```

Complete REA records are retained as compressed JSON in the follow-up evidence directory; the
[evidence manifest](evidence/terminal-2026-10-17-followup/rea-artifacts.json) records their IDs,
digests, coverage and sizes. The earlier REA IDs below are inherited ledger references; only
new portable records in that manifest are independently available from this checkout.

### REA evidence ledger

- `ev_f372e317bc5780ef895531421d5ec29e62fcea219ed9e8f792bc132805ac4f07`:
  shipped JavaScript static analysis; 13 selected files, 935 unselected. Semantic limits were
  3,000 per file and 25,000 globally. This is bounded static evidence, not whole-program or runtime coverage.
- `ev_3f4ebe0f81050df8144f3fb02fb712753350635dffbe1f37c1606fc45cca610f`:
  focused shipped welcome implementation evidence.
- `ev_5d7ec70517e2e0da4258e5236ab93b9f4c269086dd7664c8b760e0375fba512b`:
  native OMP observation; animation caused output truncation, so it is incomplete runtime evidence.
- `ev_12f82d325a8a2cf48c1f1783b4737696caf3ec98c7d8063910c9ddece4ad4028`:
  owned frontend 80×24 menu/startup capture described above; no output truncation.

Evidence IDs refer to the investigation's retained REA ledger. The package digests and source
paths above allow artifact identity to be re-established; a fresh session does not implicitly
inherit that retained ledger.

- `ev_4438bf7b94a78ee2d13d0fe3b7a22238671d48b29a68f8beafbf942b9cee930c`:
  supplemental static inspection of nine selected shipped files: default band composer,
  composer integration, light palette, selector, approval/question dialogs, errors and generic
  tool rendering. 939 inventoried files remain outside scope; semantic limits were 2,500 per
  file and 20,000 globally. Source parsing did not execute the package.
- The portable OMP/Harness runtime evidence IDs and selected frame numbers are recorded in
  the readable comparison and manifest linked above. An earlier OMP capture sent input before
  startup completed; it is retained as incomplete evidence and excluded from the comparison.

## Agent-managed session names

Agents can use `session_name({ name: string })` to name work before their first other tool call
when a request needs tools or changes state, and revise the name only when the objective changes.
Names submitted by agents are short imperative
sentences with at most six words. The agent may revise a manual name; `/name` remains
available and manual names have no new word limit. Pi stores the name in native history,
so resuming the same conversation restores it without another model request.

A substantive first turn also gets a provisional name through the terminal policy when the
session is unnamed; a refused or failed name leaves it unnamed. Each turn appends a hidden
`xingular-session-state` message with the current name and this run's empty todo, with the
previous run's list as context; the message is request-only and does not enter the stable pack.

The working line shows `Working (2m, 50 tok/s) – Add web browser integrations`; the name
also stays on the completion line. Unnamed sessions have no separator, and narrow terminals
truncate trailing text. Renaming refreshes the line through Pi's existing metadata event.

## `/doctor`

Checks accounts/models, tools, MCP, plugins/skills, variant/prompt validity, runtime assets, storage
and startup recovery. The summary keeps mode, progress, account/model and status counts visible above
the findings. Wide layouts use aligned Status, Check, Category and Verification columns, with evidence
and any next step beneath each finding; narrow layouts stack those fields. Status colors follow the
active theme: pass is success, warning/blocked warning, fail error, disabled dim and unverified muted.

`r` refreshes, `t` retries one local finding, `l` selects live checks, `c` cancels, Up/Down scroll by
line, PgUp/PgDn or the mouse wheel by page, and Home/End jump to the first/last finding. Escape
closes/cancels. Live
checks show their costs and isolated resources before confirmation. Providers without diagnostic
callbacks are reported unverified. See [Doctor](doctor.md).

## Resource browser verification (2026-10-22)

The [retained evidence](evidence/terminal-resource-browser/README.md) records three-size PTY
acceptance, pointer/filter and resize behavior, skill completion/insertion and preserved drafts,
with zero model requests. Isolated idle/history/stream input profiling reported no missed keys
and p95 14.81/14.27/17.32 ms. The manifest binds both the CLI and OpenTUI bundle to their digests.
Live external connector authentication and community package installation were not exercised.


## Full-screen browser verification (2026-10-23)

[PROP-0014](architecture/proposals/PROP-0014-fullscreen-browser-tabs.md) and
[ADR-0016](decisions/ADR-0016-fullscreen-browser-tabs.md) replace the browser's centered layout
with full-screen section tabs and a responsive inventory/inspector. The
[retained PTY evidence](evidence/terminal-fullscreen-browser/README.md) covers 40×20, 80×24 and
120×40, keyboard and pointer tab selection, filter interaction, resizing and draft preservation,
with zero model requests. The manifest binds the CLI, OpenTUI bundle and verification script.

Harness typecheck, full tests (893 passing, three platform skips), build and standalone proof
passed. The final focused browser/page/command run passed 75 tests. Agent app typecheck, layer
checks, frontend tests, all 40 sidecar tests and 240 Rust tests passed (one Rust test ignored).
Sidecar tests were rerun with two workers and a 30-second timeout after four five-second timeouts
under concurrent load. Socket-backed Harness and PTY checks required sandbox escalation;
verification used local fixtures and disposable session data.
