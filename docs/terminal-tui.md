# Harness terminal frontend

Status: release candidate `@xingular/harness` 4.0.0; npm publication blocked by registry authorization. Last updated: 2026-10-22.
Decision: [ADR-0001](decisions/ADR-0001-owned-terminal.md),
[ADR-0006](decisions/ADR-0006-opentui-only-terminal.md),
[ADR-0009](decisions/ADR-0009-xharness-command.md).

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
OpenTUI textarea for the prompt, `Ctrl+K` for the command palette, `Return` to send (or to queue behind a running reply),
`Cmd+Return` (or `Alt+Return`) to steer a running reply, and `Shift+Return` for a newline. With an
empty composer, unmodified Up recalls the latest non-empty user message from the active session.
After recall, unmodified Up/Down are available for normal editor movement and do not browse history
while the draft is non-empty. Ctrl+Up/Down remain explicit history shortcuts; Down past the newest
entry restores a blank draft. History comes from the active Pi session's saved messages, so `/new`
and `/session` (also `/resume`) switch to that session's history. Steering needs a terminal that reports Cmd with the
kitty keyboard protocol; elsewhere `Alt+Return` steers. In the composer, `Tab` opens up to eight matching filesystem entries for the path token at the cursor, or current-folder entries when the token is empty. The list has no heading or hint row. Up/Down select; Enter or Tab inserts the selection; Escape closes the list. Directories end in `/`, and Bash mode escapes shell-special characters. Use `/effort` or Shift+Up/Down to change effort. The command palette opens above the composer under a muted (`dim`) top rule, and has no other border. Its rows align slash commands and descriptions in two columns: the command column sizes to the widest visible name, bounded to preserve description space, and both columns wrap instead of truncating. The plan-choice rule, question block's top-only divider, and `/btw` block's top rule use the same muted color as the normal composer divider. The console has no background of its own: the renderer, root surface
and transcript are transparent, so the terminal's own background shows through, while panels,
dialogs and the scrim stay opaque. The composer has no panel background: it is bounded by a top and
a bottom rule, with the working status and spinner above it and a wrapping status bar below it. Its
fixed-width left gutter shows `❯` on the first input row and leaves continuation rows blank, including
explicit newlines and soft wraps; Bash mode shows `!` on the first row instead. In plan mode,
`plan mode` is right-aligned within the top rule, followed by exactly one divider character. The status bar shows the working folder's name, the Git branch, the account, model and effort separated by spaces, and input (`↑`) and output (`↓`) token counts with each glyph adjacent to its count; `|` separates the groups. Token counts
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

Most pages become centered dialogs. The page commands `/accounts`, `/permissions`,
`/plugin:trajectory` and `/log`, the `/model` and `/history` pickers, and
the `select`, `confirm`, `input` and `editor` dialogs (such as `/effort` and the Thinking setting),
take 80% of the terminal, capped at 100 columns by 30 rows, on a flat panel in the console's panel
colour. A full-screen scrim dims the console behind the panel so the transcript stays faintly
visible. Centered Harness dialogs fit their rendered content, capped by the available dialog
height, with four columns of horizontal padding and two rows of vertical padding to account for
the terminal's taller-than-wide cells. They use a plain title with a muted `Esc` hint and
omit divider rules and footer hints. Shortcut behavior remains available. Searchable lists share
the same glyph, placeholder, spacing, and muted result note, with search context included on that
row. A terminal too small for a 30-column by
12-row dialog falls back to the full-screen page chrome. A plugin's full-screen surface stays full
screen. `/settings` instead fills the terminal with its category tabs, search, settings list and
full-screen page chrome. The Harness resource browser and all its shortcuts use a full-screen page
with persistent resource-section tabs.

The frontend is verified with a real isolated PTY and a loopback provider. Run
`python3 scripts/verify-terminal.py --composer-only` for explicit-newline and soft-wrap checks of
both prompt gutters plus normal/plan/Bash mode exclusivity, `--file-completion-only` for filesystem
completion and insertion,
`--history-only` for active-session history across `/new` and `/session`, `--help-only` for `/help` replacing the welcome screen with grouped two-column output that wraps without per-command gaps, `--questions-only` for recommended choices,
selected-row and Continue/Submit colors, `--jump-latest-only` for scroll-away badge visibility and click-to-latest (screen-level click assertions use optional `pyte`), and choice-backed “Something else” answers, or `--thinking-only` for `/thinking` visibility toggles. The full suite covers a complete turn, `read`, `bash` approval, `ask_user_question` approval and picker, plugin overlay/widget/status
disposal, a completed run record with usage and decision events, `/help`, `/permissions`,
`/settings`, `/model`, palette selection, confirm cancel, and Ctrl+D exit. Live-provider behavior,
exact OpenCode parity and concurrent session tabs are not established.

## Native subagents (2026-10-18)

Interactive terminal turns use the same `harness.subagents` service as SDK callers. The bridge
registers the current run's effective tools, resolved model, thinking level and pinned account
through its private control channel; a read-only terminal narrows child capabilities and broker
access. `spawn_subagent` returns immediately, `wait_subagents` joins selected children, and
`wait: true` on spawn returns an inline result. Native receipts deduplicate automatic delivery.
The terminal joins outstanding children before its final reply, projects child approvals/questions
with their original run IDs, and stops descendants when interrupted or disposed. Connected apps
need not be enabled. `TerminalPrepareInput.subagents: null` disables the capability.

The terminal also projects the active parent's subagent descendants into a compact roster above
the composer and a searchable `/plugin:subagents` page. The roster polls a private monitor route once per
second during a turn and shows task, status, elapsed time and the latest recorded tool summary.
The projection is read-only, flat across nested descendants, and scoped to the current parent run;
it keeps finished child rows until that parent settles. It never includes tool arguments or output.

Real scripted Pi execution over the actual terminal socket verifies result delivery, decision
routing, and the monitor's parent scoping and summary redaction. It does not establish live-provider
behavior. See
[ADR-0003](decisions/ADR-0003-shared-asynchronous-subagents.md) for recovery and lifecycle details.

## Ownership and process boundary

Harness owns its interactive terminal application in
[`src/terminal/opentui/`](../src/terminal/opentui/). [`app.ts`](../src/terminal/opentui/app.ts)
owns terminal lifecycle, submission, commands, decisions and run records;
[`root.tsx`](../src/terminal/opentui/root.tsx) owns composition, the transcript, the composer,
palette and dialogs. It does not construct Pi's `InteractiveMode`. Pi 1.2.0 supplies the
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
An empty conversation shows the centered product mark and a short hint; once a message exists, a
scrollable transcript fills the space above the composer. Single-line notices can appear with the
welcome, while multiline notices such as `/help` switch to the transcript layout so their output
cannot overlap it. The composer is a single top and bottom rule, with the right-aligned `plan mode` label followed by one divider character in the top rule,
and the textarea in the middle.
The working status row shows the active verb with a soft, warm glint that feathers across it and
fades past its edges, followed by run duration and the latest completed assistant response's output
rate, formatted as `(time, tok/s)`; the spinner and metrics stay steady, and duration updates during a run.
Until response usage is available, the rate shows `— tok/s`. On settlement, the completion verb and
final run statistics stay in that row until the next run replaces them; they do not become a transcript
entry. Notifications, queue announcements, compaction-start and retry updates—including retries
while summarizing context or branches—are one-line transcript entries at the point they occur, so
subsequent chat moves them up rather than keeping them pinned at the bottom. Each entry stays after
the message it followed when compaction shortens the history; an entry whose message was summarized
sits right after the compaction card. A completed context
compaction adds a first-class card from Pi's persisted session history, showing the token count and
an expandable Markdown summary; click the card or use Ctrl+O to toggle its details.
A successful transcript-selection copy instead shows a temporary, opaque toast at the top-right of the
terminal. Interactive blocks and widgets remain docked above the composer. A wrapping status bar
below the composer shows the working folder, branch, account, model, effort and token totals. After
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
inter-entry gap. Internal lines within an entry stay together. The transcript stays pinned to the
latest message until you scroll away. While scrolled away, a `↓ Jump to latest` badge overlays the
transcript's lower-right corner; clicking it returns to the newest message and hides the badge.
`Ctrl+End` remains an alternate way to jump to the end. A primary click in the transcript or empty welcome area focuses the composer. Dragging to select
transcript text copies the selected plain text when the selection is released; a simple click does
not copy. `/copy` and `Ctrl+X` continue to copy the latest assistant reply.

Mouse movement highlights the row under the pointer in the command palette, plan choices, question
dock, searchable dialogs and Harness page lists; the highlight uses the same selection style as
keyboard navigation. A primary click activates the row, and clicks on page tabs switch that page's
section. Question choices still stage their answer until the question's action is clicked. Dialogs
preserve their existing confirmation safeguards. OpenTUI enables terminal mouse-motion reporting for
hover; terminals or multiplexers that do not report motion retain keyboard navigation. ANSI-only
custom UI without a mouse handler remains keyboard-driven.

Page dialogs and blocks are absolute overlays, so the transcript stays behind them. The screen
restores the terminal's alternate-screen state when the application exits.

### Markdown transcript

Assistant replies, plan-card bodies and Markdown image-result text share one style map. Heading
levels use the Harness palette; links are blue and underlined, and only their labels appear in the
transcript. Hovering a supported link changes the terminal pointer to a hand and shows a `Click to
open link` hint in the status bar. A primary click opens it with the system browser; only valid
HTTP and HTTPS destinations are accepted, and the launcher receives the URL as an argument without
a shell. OSC 8 metadata is emitted where available, but link activation does not depend on terminal
OSC 8 support. Inline and fenced code use a subtle panel fill with syntax colors. Emphasis, quotes,
list markers, tables, dividers and task-list markers use the existing titanium palette. Images
display their alt text and are not fetched or rendered as image files.

## Blocks and pages

In Pi's own terminal UI, [`chrome.ts`](../src/terminal/tui/chrome.ts) gives terminal surfaces one
of two rule-based shapes, using the 2-cell composer gutter on each side and a dim hint row.

- A **block** docks at the bottom like the slash-command list above the composer. It has an amber
  (`warning`) rule, a bold title row with an optional dim note at the right edge (a dialog's
  countdown), the body, a hint row, and a neutral (`dim`) closing rule. It is as tall as its body.
  Approvals, questions, and the `select`, `confirm`, `input` and `editor` dialogs use this shape
  there. OpenTUI renders Harness-managed centered dialogs with the inset header treatment below.
- A **page** is a header row (title left, position or status right), a neutral rule, the body,
  a neutral rule, and the hint row. `/settings`, `/plugin:trajectory`, `/log`, `/permissions`, and the
  `/accounts`, `/plugins` and `/hub` menus are pages. Section labels inside a page are plain bold
  headings, never text set into a rule.

`DialogPanel` takes a `variant` (`block` by default). `ui.select` accepts a harness-owned `page`
option, which Pi's own dialogs ignore, so the same extension code runs in either terminal. Selected
rows keep the full-width `selectedBg` highlight and `❯` marker the slash-command list uses. Both
frontends draw that field from the same muted-blue selection palette (`selection.ts`) and use
explicit high-contrast text on it instead of the accent colour, so a choice reads the same in every
list. Rules use the theme's `warning` and `dim` colors, so a custom theme restyles them.

The Harness resource browser (PROP-0013) unifies Overview, Foundation, Variant, Skills, Plugins,
Connections, Tools and Library. `/harness` opens Overview; `/skills`, `/plugins`, `/connections`
(`/mcp`) and `/tools` open sections. `/hub` selects Discover and `/components` selects Library.
The existing Accounts, Permissions, Settings, Trajectory and Log pages retain their own tabs.

`/settings` includes a Browser tab with the device-local **Private address access** setting. It is
off by default. Enabling it asks for confirmation and allows agent browsing and annotation capture
to reach localhost and private networks.

Resource sections share Installed/Discover and source filters. Installed includes locally present
resources; current-session availability comes only from the runtime loader and active tool registry.
Discover uses the existing Hub with All/Community/Official filtering and an explicit remote refresh.
No matching community entries is an empty result, never replaced with built-in resources.
The view preserves search across source switches and restores section selection on return.

The browser fills the terminal (PROP-0014), with Overview, Foundation, Variant, Skills, Plugins,
Connections, Tools and Library as persistent top tabs. The section dropdown and sidebar are removed.
When the strip cannot fit, it shows the active tab and its position with previous/next navigation.
At 88 content columns, inventory sits beside an inspector containing metadata, actions and readable
content. Enter focuses the inspector. Compact terminals show details/content within the active tab;
resizing preserves the selected resource and content position, clamped to the available height.

Tab/Shift+Tab focuses tabs, source, filter, toolbar actions, list and (when available) inspector.
Left/Right changes the focused tab or control; Enter on the tab strip returns to the inventory.
Ctrl+F focuses search. Escape returns from content to actions, returns to the list, clears search,
then closes. Mouse clicks select tabs directly, activate resource actions and focus filters;
wheel scrolling targets the list or inspector under the pointer. Other command pages keep their
centered presentation; `/settings` uses the full-screen page layout. Closing the browser preserves
the composer draft and attachments.

Foundation explains fixed runtime ownership; it is read-only. Variant shows c1–c8 with the
prepared version and current head separately. It previews pinned files from the preparation
snapshot and compares their text with the latest saved version. No in-place editing or adoption
is added. Library skills and rules are added through `terminal.components.add`, which commits a
validated future version. Directory-backed variants stay read-only.

Skill browsing is independent of the Skill commands setting. Use inserts a leading `$name`
without submitting. Ctrl+K opens a separate command filter; choosing a browser section keeps
the existing draft text and attachment labels. Canceling the filter restores that draft. OpenTUI completes
loaded skills for a leading `$`; Enter or Tab inserts the selected skill rather than sending.
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

## Annotate pane (PROP-0018)

`/plugin:annotate` opens a full-screen page that works beside the window being inspected. That window is one of:
- the visible capture browser
- an app's own windows attached over its DevTools port (`--app`)
- app windows that loaded the page bridge script (`--bridge`)

The header shows the target and window and whether the inspector is on. The list has three groups: Queue, Sent and fixed, and Saved. While the inspector is on, the page polls for the next popover comment every 400 ms, shows the result as a notice, and refreshes the list.

| Key | Action |
|---|---|
| `i` | inspector on/off |
| `s` | send the queue |
| `x` | unqueue the selected note |
| `t` | choose a window |
| `Enter` | the note menu |

The page has no search row, so these letters are free for actions. `/plugin:notes` keeps the searchable list.

## Plan mode and thinking keys

Use `/plan <brief>` for one read-only planning request. A plan waits outside Pi's native follow-up
queue until the active response settles, then runs by itself. Later messages remain behind it, even
when Pi's follow-up mode is `all`. During that run the session narrows to read-only inspection
(`read`, `grep`, `find`, `ls`), web search/page reading, questions (`ask_user`, `ask_user_question`)
and recall (history and Wiki reads, `memory_facts`). Providers may mark individual calls as safe for
research; every other call is blocked before approval. Edits, writes, shell commands, memory writes,
subagents and connected-app tools remain unavailable. The plan instructions arrive as a
request-scoped prompt section, which the next ordinary request withdraws.

Each mode keeps its own model and effort for the account. Every selection the person makes (the model
picker, `/effort`, Shift+Up/Down, Ctrl+P) is saved against the mode it was made in, so Shift+Tab switches to that
mode's model and effort, and a new conversation starts on the normal mode's latest choice. A mode with no
choice of its own takes normal's, field by field. A resumed conversation keeps the model in its history,
and a saved model the account cannot use is skipped. The choices live in the account's `choices.json`,
and the App reads and writes them through `accounts.choices` and `accounts.choose`.

A bare `/plan` toggles plan mode, and Shift+Tab cycles between normal and plan mode. Normal, plan
and Bash are mutually exclusive composer modes. While plan mode is on, each submitted message is sent
as a plan request through that same queue, and the composer's top and bottom rules take the plan colour.
Commands still run as commands. Entering Bash with a leading `!` exits plan mode; Shift+Tab from Bash
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
that was interrupted, failed, or had work queued behind it is not offered.

While typing, a recognized leading slash command uses the selected theme's link color. This
includes built-in commands, loaded extension and prompt commands, and enabled skill invocations
written as `/skill:name`. Unknown slash tokens keep the normal text color.

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

The terminal extension checks Bash policy and requests approval before using Pi's native
`executeBash`. Output streams into the transcript while the command runs, so browser-login URLs are
visible before the command finishes; the running item shows that Escape stops the command. The
native result is recorded in run activity and session history before the model is prompted to read
and explain it. This does not attach interactive stdin to the shell. SDK callers may opt into this
behavior with `SessionRunInput.initialBashCommand`; it is restricted to a new interactive user turn
and the session runner applies the same Bash gate.

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
[`opentui/theme.ts`](../src/terminal/opentui/theme.ts). The OpenTUI status bar shows the project name,
branch, account, model, context use and current-session input/output totals. Input totals add cache
reads and exclude cache writes; its `R<percentage>%` hit rate is cache reads divided by total input.
Token counts below 1,000 show as whole numbers; larger counts use floor-rounded K/M/B suffixes
without decimals.

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
contains the remaining presentation dependencies and requires exactly Pi **1.2.0** before
loading them. The shared [`runtime.ts`](../src/pi/runtime.ts) loader imports Pi first, then invokes
the same HTTP dispatcher hook as Pi's CLI before any Harness Pi runtime is used. This reapplies
the process `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` settings after Pi's bundled Undici has
loaded. Account and model checks, sessions, maintenance, plugin discovery and installation,
pricing, and the standalone terminal all use this loader. It is process-wide and coalesces
concurrent initialization.

| Internal dependency | Reason |
|---|---|
| `dist/bundle/chunks/chunk-TJXZSVTD.js:configureHttpDispatcher` | Restore Pi's environment-aware HTTP proxy dispatcher after the SDK import |
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
  queued images with a warning.

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

The private key is required for `terminal.policy`, `terminal.approval`, `terminal.pending`,
`terminal.approve`, `terminal.answer`, `terminal.draft`, `terminal.interrupt` and
`terminal.resources`, as well as existing account and plugin mutations. A model-spawned shell with
only the environment token cannot submit policy or approval decisions, change permissions, or
answer its own pending questions. The application renders decisions obtained from the existing
controller and returns the person's answer through these calls.

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

The bridge exposes the shared `ask_user` batch tool alongside the existing single-question
`ask_user_question` contract. Every question must include at least one choice and at least one
recommended choice; recommendations remain visual and never preselect. Choice-based questions also
retain a free-text “Something else” answer. A pending question appears in a flat block immediately above the
composer, not in a modal. It has only a muted top divider and separates its hint from the content by
one blank line. The block shows one batch question at a time with previous/next navigation and batch
progress, choices and descriptions, a numbered free-text answer row after the choices, and a Continue
or Skip action. Selected choices fill the whole row with subtle dark green; Continue and Submit uses
a green-filled button, while Skip remains neutral. The regular composer remains below it for a direct message to the waiting session.
Tab and Shift+Tab move focus through the available controls; Tab from a focused selected choice opens
its inline note field. In multi-select questions, Tab can open a note for each selected choice; notes
are submitted by choice label and cleared when that choice is deselected. While the block is active,
Tab takes precedence over the normal thinking and plan-mode shortcuts. Up and Down navigate choices;
Left and Right navigate the batch while choices or the action are focused. Enter selects a choice,
activates the focused action, or submits the answer or note field. Escape interrupts the pending
question. Press `x` from the choices or action to collapse the block; Tab reopens it.

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
The separate `$` palette completes enabled skill invocations; `/skills` always browses skills. `/help`
renders the command list as one transcript entry, grouped under Core, Run, Model, Session, Inspect,
Harness, Plugins and Prompts; command names and descriptions wrap in aligned columns, with no
blank rows between choices. `/plugins` opens the browser with protected code trust and plugin settings actions. Settings use
`plugins.configure`; on/off settings and bounded whole-number settings keep their existing ranges.
Saved settings are read when the plugin next uses them and do not require a restart. The standalone
terminal no longer has separate `/login`, `/trust`, `/bug`, `/changelog`, `/share`, `/scoped-mode` or
`/import` commands. `/btw <question>` (or `/side <question>`) asks a short side question in a separate tool-free session. Its block puts the question after `/btw`, shows the normal animated spinner while answering, and separates the answer and hint by one blank row; it has no status labels. Escape closes the block without interrupting the main reply, and either command with no question dismisses it. `/stop` interrupts the current reply. The `/accounts` page handles sign-in
and sign-out. `/components` browses reusable skills, prompts and rules; a confirmed skill or rule addition
creates a variant version for future sessions while the current terminal keeps its pinned version. `/reload` applies trusted resource and keybinding changes.

`/plugin:trajectory` opens the newest recorded run for the current native conversation; `/plugin:trajectory <run-id>`
opens a selected run from that conversation. Tab switches between Runs and Events; `[` and `]` change
runs, up/down selects recorded events, PageUp/PageDown scrolls event details, and `c` copies the
selected event. Active runs refresh while the overlay is open. The protected terminal socket scopes both the run list and event
reads to the current terminal and native session file.

`/log` opens a centered page dialog with separate Harness diagnostics and current-conversation
run-event views. The diagnostic file is read at its captured size in bounded socket chunks. Tab/Shift+Tab
switches views; arrows, PageUp/PageDown, Home and End scroll; Escape closes. Fetch
diagnostics retain available error stacks and safe request metadata, while the viewer redacts secrets
and URL queries and omits response bodies, prompts and message contents. Embedded hosts without a
`harness.log` still show the conversation's recorded run events.

## Slash command ownership

Core terminal commands stay unprefixed. Built-in plugin commands and Pi extension commands use
`/plugin:<command>`, appear with that prefix in `/help` and the command palette, and dispatch to the
registered owner. Duplicate extension names are rejected with the extension paths shown as the
diagnostic. Former unprefixed plugin commands such as `/annotate` and `/doctor` are no longer
aliases. Prompt templates and `/skill:<name>` keep their existing forms.

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
- **No swallowed keys.** A character the question dock does not use moves focus to the composer and
  is typed there.

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

Agents can use `session_name({ name: string })` to name meaningful work early and revise
its name when the objective changes. Names submitted by agents are short imperative
sentences with at most six words. The agent may revise a manual name; `/name` remains
available and manual names have no new word limit. Pi stores the name in native history,
so resuming the same conversation restores it without another model request.

The working line shows `Working (2m, 50 tok/s) – Add web browser integrations`; the name
also stays on the completion line. Unnamed sessions have no separator, and narrow terminals
truncate trailing text. Renaming refreshes the line through Pi's existing metadata event.

## `/plugin:doctor`

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
