# Harness terminal frontend

Status: implemented in the 2.1.2 release candidate; publication follows the tagged CI workflow. Last updated: 2026-10-19.
Decision: [ADR-0001](decisions/ADR-0001-owned-terminal.md).

## Native subagents (2026-10-18)

Interactive terminal turns use the same `harness.subagents` service as SDK callers. The bridge
registers the current run's effective tools, resolved model, thinking level and pinned account
through its private control channel; a read-only terminal narrows child capabilities and broker
access. `spawn_subagent` returns immediately, `wait_subagents` joins selected children, and
`wait: true` on spawn returns an inline result. Native receipts deduplicate automatic delivery.
The terminal joins outstanding children before its final reply, projects child approvals/questions
with their original run IDs, and stops descendants when interrupted or disposed. Connected apps
need not be enabled. `TerminalPrepareInput.subagents: null` disables the capability.

Real scripted Pi execution over the actual terminal socket verifies result delivery and decision
routing. It does not establish live-provider behavior or new visual UI parity. See
[ADR-0003](decisions/ADR-0003-shared-asynchronous-subagents.md) for recovery and lifecycle details.

## Ownership and process boundary

Harness owns its interactive terminal application in [`src/terminal/tui/`](../src/terminal/tui/).
[`TerminalApplication`](../src/terminal/tui/application.ts) owns terminal lifecycle, screen
composition, focus, input dispatch, scrolling, editor mounting, dialogs and keyboard actions.
It does not construct Pi's `InteractiveMode`. Pi 1.2.0 supplies the persistent agent session,
model and auth runtime, native JSONL history, tool execution and rich content components.

The parent process still calls `Terminals.prepare()`, spawns its returned specification in a
PTY or inherited terminal, and eventually calls `dispose()`. Its default command is the active
Node runtime followed by the existing Harness CLI and `terminal-frontend`; it requires no global
`pi` command. `TerminalAssets` remains `{ node, cli, piExtension }`, and the existing
`prepare`, `send`, `state`, `input` and `dispose` contracts remain in place. The `piExtension`
path remains the final prepared extension argument. The owned runtime recognizes that bridge
position and loads its trusted, bundled factory inline after the selected disk extensions.

```text
Harness parent: account + compiled context + trusted resources + run writer
       | launch specification / existing session socket
Harness terminal child: TerminalApplication + persistent Pi AgentSessionRuntime
       | typed native events / plugin UI callbacks
Harness screen: transcript, with the product lockup above it until the first message, above a dock
       (status, editor, footer), with dialogs and overlays
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

[`screen.ts`](../src/terminal/tui/screen.ts) chooses the screen from Pi's `tuiMode` in the
account's `settings.json`; the default is `fullscreen`. Fullscreen uses Pi 1.2.0's
`TuiAltScreen` with a layout root: a `ScrollView` holds the transcript (with the product lockup
above it) and fills the terminal, and a `VStack` dock sits below it. The dock holds the working
line, queued messages, widgets, the editor with its status band, and the footer. Terminal notices
(mode changes, errors, the keyboard list) are rows in the transcript, so they scroll with the
conversation and clear with its session. The dock stays on the last rows as the transcript grows,
and scrolling moves only the transcript. When the screen is short, the prompt and status keep
their full height, and queued messages and widgets show their first rows and scroll for the rest. Pi's `tui.altScreen.*` bindings
(PgUp/PgDn, Ctrl+Home/End and the rest), mouse wheel, selection and search apply. The scrollbar,
wheel step and copy-on-select behaviour are read from Pi's `fullscreen*` settings. Submitting a
message and changing session return the transcript to its latest row. The product lockup
(`welcome.ts`) is the first row of the transcript only while the current chat has no user
message, so a resumed session with history starts without it and a new, cleared or switched-to
empty chat shows it again. A header set by a trusted extension with `setHeader` replaces the
lockup and is never hidden. Hiding the lockup shrinks the rendered rows, so the main screen clears
and reprints once when the first message is sent.

`regular` uses the main screen with the same components flowing in order, and the terminal keeps
the scrollback. Leaving fullscreen with `fullscreenExitOutput: "transcript"` (Pi's default) copies
the rendered conversation into the normal scrollback once the alternate screen is gone; a session
with no messages writes nothing, and a started chat copies it without the product lockup. Other
exit-output values are not implemented and write nothing.
The decision and its consequences are recorded in
[ADR-0004](decisions/ADR-0004-fullscreen-terminal-layout.md).

## Plan mode and thinking keys

Use `/plan <brief>` for one read-only planning request. A plan waits outside Pi's native follow-up
queue until the active response settles, then runs by itself. Later messages remain behind it, even
when Pi's follow-up mode is `all`. During that run the session narrows to read-only inspection
(`read`, `grep`, `find`, `ls`), web search/page reading, questions (`ask_user`, `ask_user_question`)
and recall (history and Wiki reads, `memory_facts`). Providers may mark individual calls as safe for
research; every other call is blocked before approval. Edits, writes, shell commands, memory writes,
subagents and connected-app tools remain unavailable. The plan instructions arrive as a
request-scoped prompt section, which the next ordinary request withdraws. `/plan` without a brief
and the old on/off/toggle forms are rejected.

While typing, a recognized leading slash command uses the selected theme's link color. This
includes built-in commands, loaded extension and prompt commands, and enabled skill invocations
written as `/skill:name`. Unknown slash tokens keep the normal text color.

SDK session runs receive plan instructions as a dynamic context update, leaving the stable system
prompt unchanged; their session gate refuses calls outside the read-only set. The standalone
terminal applies the same one-run instructions and tool restrictions. Shift+Up and Shift+Down step
the thinking level within the levels the model supports, and do not wrap.

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
palette and `src/prompt/welcome.ts` establishes the five-row Pi logo, exact diagonal RGB stops
and indexed-color fallback, centered lockup and narrow-width behavior. Harness adapts these
into [`theme.ts`](../src/terminal/tui/theme.ts) and [`welcome.ts`](../src/terminal/tui/welcome.ts),
with its own product name, package version and existing-command tips. The text-only status band in
[`status.ts`](../src/terminal/tui/status.ts) shows the project name, branch, account/model/effort,
the last completed response's output rate and current-session input/output totals. Input totals add
cache reads and exclude cache writes. The prompt
frame is implemented in [`editor.ts`](../src/terminal/tui/editor.ts): two full-width neutral
rules around the prompt, a dim `❯` glyph, a `Try "…"` placeholder before the first prompt of a
launch, and a `? for shortcuts` footer line above the band. The frame follows the observed
composer of Claude Code 2.1.302, reproduced from its visible values; no code is copied, and
`?` opens the same list as `/hotkeys`. Startup selects the Harness titanium presentation
without rewriting the user's saved theme settings. The shipped OMP light palette is also
available as `light`; native rich components and the status band switch together. Missing
Pi-specific color tokens use documented Harness fallbacks in `theme.ts`.

The frontend exposes capabilities already present in Harness/Pi. It does not import OMP's
agent runtime, tools, providers, MCP implementation, task system or other product features.
Harness-owned composition reuses public Pi Markdown, message, tree/model selector and rich
tool components. Tool diffs, expandable output, images and extension renderers therefore retain
the existing Pi interpretation. This is an implementation of the requested terminal presentation;
complete visual or behavioral parity with every OMP surface has not been established.

Full upstream copyright and MIT permission notices are in [NOTICE.md](../NOTICE.md).

## Runtime compatibility adapter

Most integration uses public Pi exports. [`piAdapter.ts`](../src/terminal/tui/piAdapter.ts)
contains the remaining implementation dependencies and requires exactly Pi **1.2.0** before
loading them:

| Internal dependency | Reason |
|---|---|
| `dist/extensions/index.js` builtin inventory | Preserve selected `llama.cpp`, `codemode`, `tool-search` and MCP builtins with the CLI's replacement semantics |
| `dist/modes/interactive/theme/theme.js:setThemeInstance` | Keep public native rich components on the same active theme as the Harness screen |
| `dist/core/tools/renderers/index.js:withBuiltInRenderers` | Preserve existing read/edit/bash/write formatting without replacing tool execution |
| `dist/utils/clipboard.js` and `clipboard-image.js` read helpers | Preserve explicit user clipboard paste behavior; these are not called during inspection or startup |

The adapter is initialized once; its global theme setter and renderer lookup are synchronous
thereafter. A Pi dependency upgrade must update this adapter deliberately and rerun the
terminal compatibility tests. These module imports do not instantiate `InteractiveMode`.

## Accounts, history and resource trust

The child requires the prepared absolute `PI_CODING_AGENT_DIR`; there is no fallback to a
personal Pi profile. Provider authentication and model catalogs use that account's files.
The selected account stays pinned. The existing `/accounts` command requests a parent-managed
restart to use a different account while resuming the conversation.

An initial `--session` or `/resume` target must resolve inside the prepared history directory,
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
`ask_user_question` contract. Registry events project the actual batch IDs, order, summaries,
choices, descriptions and optional recommendation metadata into the terminal inbox. Its custom
picker places recommended choices first and marks them in yellow without changing their labels or
preselecting them; a single-choice question allows at most one recommendation, while multi-select
questions may recommend several. The frontend stages answers locally and
submits them together through protected `terminal.answers`; the registry validates the entire
batch before resolving any question. Escape interrupts a pending question; cancelling optional
text entry returns to the choices and preserves selections. Disappearing requests abort their
open dialogs. Labels are numbered so a real choice cannot collide with a dialog action.

Plugin UI methods carry a generation guard, including methods a plugin retained before an
`await`. Session replacement, reload and disposal revoke the old generation. Outgoing native
event subscriptions and custom transcript components detach before native invalidation.
Cleanup failures cannot prevent terminal restoration. Fatal asynchronous errors restore the
terminal and exit with failure; startup failures and suspend/resume use the same lifecycle.

The command registry supplies help and completion for every pinned Pi built-in command name,
plus Harness commands supplied by the bridge. `/trust` opens the existing protected code-review
workflow in `/plugins`; trust changes require a freshly prepared terminal. `/bug` opens a
reviewable Harness issue draft after confirmation, without attaching history. `/changelog`
reads bundled Harness change notes. `/reload` also applies the isolated account's edited
keyboard bindings through the public TUI manager.

`/trajectory` opens the newest recorded run for the current native conversation; `/trajectory <run-id>`
opens a selected run from that conversation. Left/right changes runs, up/down selects recorded
events, PageUp/PageDown scrolls event details, and `c` copies the selected event. Active runs
refresh while the overlay is open. The protected terminal socket scopes both the run list and event
reads to the current terminal and native session file.

`/log` opens a static full-screen snapshot with separate Harness diagnostics and current-conversation
run-event views. The diagnostic file is read at its captured size in bounded socket chunks. Tab/Shift+Tab
or left/right switches views; arrows, PageUp/PageDown, Home and End scroll; Escape closes. Fetch
diagnostics retain available error stacks and safe request metadata, while the viewer redacts secrets
and URL queries and omits response bodies, prompts and message contents. Embedded hosts without a
`harness.log` still show the conversation's recorded run events.

## Verification and remaining limits

Release-candidate verification, 2026-10-19: clean `npm ci` and `npm run ci` passed—541 tests
(two skipped), typecheck, build and standalone proof. In the sibling App, typecheck, layer check and
sidecar build passed; its renderer tests passed (561), but one sidecar screenshot assertion and two
Rust tests failed in the broader in-progress App worktree. Those failures do not touch the Harness
release files; the App changes were not included in this package.

Fullscreen layout verification, 2026-10-18: [`screen.test.ts`](../src/terminal/tui/screen.test.ts)
covers the dock on the last rows as the transcript grows and scrolls, notice clipping, regular
flow, and the exit copy. The PTY verifier against the built CLI passed all 14 interaction groups at
40×20, 80×24 and 120×40; the retained result is
[docs/evidence/terminal-2026-10-18-fullscreen](evidence/terminal-2026-10-18-fullscreen/verification.json).
The verifier's keyboard-list check now waits for the list's first line, because a long notice shows
its first rows in the dock and scrolls for the rest. The App sidecar's suite passes 30 of 30 and
`cargo test` passes 217 tests against this tree. The App's root Vitest suite has one failure, the
pre-existing `PendingRequestDock` expectation. The App sidecar's own `tsc` run reports four errors
in `agentRuns.ts` and `app.test.ts` that also occur on the checkpoint commit.

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
rounded settings framing and the need for flat settings rows at 80 columns; the latter was
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
account capacity is available. GitHub gist publication, actual OS clipboard/image transfer,
Windows behavior and every terminal emulator remain unverified. Rich image/diff rendering and clipboard adapters have
focused compatibility tests; that does not establish OS interaction. These changes shipped in
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
