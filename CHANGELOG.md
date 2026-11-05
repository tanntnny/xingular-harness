# Changelog

## Unreleased

## 2.3.0-unstable

- **Session token totals survive compaction.** The terminal's token counts use recorded session usage, including earlier runs and compacted messages; the cache percentage remains a separate recent-request diagnostic.

- **Wrapped list items hang under their text in the terminal.** A bullet or numbered item that wraps
  now continues under its own text instead of under its marker, bullet and numbered lists start their
  text in the same column, the column widens for `10.` and `100.`, and nested lists indent under their
  parent. The hanging indent was added in 2.0.1-unstable but never ran, because the transcript's
  code-block-only renderer kept lists out of it (D-32); OpenTUI is now patched at run time to render a
  list as its own block, and `scripts/verify-terminal.py --markdown-only` checks the columns again.

- **Optional REA plugin and MCP deadlines.** The disabled-by-default `rea` plugin ships the matching REA skill and an optional pinned MCP runtime dependency. Its plugin-owned connection appears in `/connections` and `/mcp` even while disabled, with links to the plugin switch and settings; it can also be enabled in `/plugins`. Its tools use the connector broker and approval gate. REA requires a supported Node version and optional analysis providers. Its call deadline defaults to 450 seconds and can be changed in plugin settings. Other MCP connections gain a configurable 1–1,800 second call deadline, with the existing 60-second default. A timeout reports an unknown outcome and is never automatically retried.

- **Composer modes no longer change the model or effort (ADR-0087).** Normal and plan share one
  selection per account. Shift+Tab changes tools and the composer, and **Implement** keeps the model
  and effort the plan ran on. Every `/model`, `/effort`, Shift+Up/Down, Ctrl+P or Ctrl+S pick is
  saved for the account, so a new conversation starts on it; a resumed conversation keeps the model
  and effort in its own history. The client terminal's Ctrl+P now actually cycles the catalogue,
  and a previous per-mode `choices.json` is migrated to its newest entry on first read.

- **Marketplace terminology and installed plugin management.** Discovery is called Marketplace; plugins,
  skills and MCP servers are distinguished. `/marketplace` is the canonical terminal command and `/hub`
  remains a compatible alias; IDs stay unchanged. Installed receipts link to the right local manager, and
  packages that cannot be rediscovered stay visible for recovery by exact source. The built-in
  `tui-inspection` skill is switchable and on demand; the optional `tui-test` tool is never installed
  automatically.

- **Change reports can name each edit in a few words.** The final-answer guidance suggests a `#` title
  from a short palette (`# What changed`, `# Causes`, `# Fixes`, `# Diagnosis`, `# Rollback` and others)
  and one bullet per parallel edit opening with a bold three- or four-word label. Both are suggestions:
  content-named headings, outcome titles and prose stay valid.

## 2.2.0-unstable

- **The long-lived harness is the default for `xagent` (ADR-0085).** A window runs in it unless told
  otherwise (`--no-daemon`, `XINGULAR_DAEMON=0`); on Windows, with `XINGULAR_TERMINAL_RUNTIME=inprocess`, when its
  socket path is too long, or when it cannot start, the window runs its own harness and says why. `--worktree`
  now works in the daemon, a window that is killed no longer leaves its session (or the daemon) held open, a
  daemon that goes does not hang the window for a minute, and the start of the daemon is logged and fails fast.
  The lock is created atomically, records the folders and build, and a reused pid is recognised as stale.
- **A host's sessions are its own by the call that started them (ADR-0085).** Side questions, refinements,
  subagents and probes a host starts are now gated and heard by it, a host that is briefly away is waited for,
  sign-in links go only to the call that asked for them, and a host's launch options are read by every `daemon
  run` from `<state>/host-launch.json`. `harness.open` of another data folder is refused while terminal
  windows use the harness.

- **A phone can control a host's live session, and a pairing outlives a closed terminal window (PAR-018).** `sessions.remoteControl.{start,stop,rotate,confirm,status,status.wait}` pair a phone with any live session; a terminal window closed during a reply keeps its phone until the reply settles. `LiveDecisions` is shared by the client terminal and the pairing; `LiveSessions.onEnd` reports a session closed for good.
- **The long-lived harness checks its version and exits when idle.** After an upgrade, a window
  replaces an old daemon that nothing uses, or runs in its own harness (with a notice) when a window
  or reply still uses it. The daemon exits after 30 idle minutes. `--no-daemon` and
  `XINGULAR_DAEMON=0` keep a window's own harness. `daemon.status` reports `version` and `windows`.
- **The terminal screen no longer gets garbled by a failed code highlight.** Code fences always take
  the app's syntax style, and `console` output is held while the terminal window runs and printed
  after it exits.
- **A shell command that hit its timeout now tells the model what stopped it** and how to ask for a
  longer wait. The working row names a lone running shell command and adds `Esc to stop` after five
  minutes.
- **One session runtime: the terminal is now a client of the harness (ADR-0083).**
  - A conversation keeps one open Pi session across turns (`sessions.run { live: true }`), so
    steering, queued follow-ups and plugin state carry from one turn to the next. `sessions.live`,
    `sessions.close`, `sessions.followUp` and `sessions.followUp.clear` manage them. App chat turns
    use it.
  - `xagent` runs no agent loop in its window any more: every turn is a harness run, with the same
    gate, records, plan mode, goals and subagents as a host's. `XINGULAR_TERMINAL_RUNTIME=inprocess`
    runs the previous in-process runtime. Plugins in the new terminal get the host's interface
    (dialogs, notices, status lines and text widgets); custom terminal components, key handlers,
    renderers, shortcuts and themes need the in-process runtime.
  - `xagent daemon start|stop|status` runs one long-lived harness per state folder; `xagent --daemon`
    windows use it, so a reply keeps running when its window closes, and `xagent attach` reconnects a
    window to it. The protocol is also served on an owner-only socket (`server/socket.ts`).
  - Terminal runs now record Pi's session id as `nativeSessionId`, as host runs do; in-process
    terminal runs keep recording their history file.
  - `/session` takes a saved conversation's session id as well as its file.
- **Every harness run ends when it stops making progress.** A reply that produces nothing for fifteen
  minutes (thirty with a tool running; a pending approval or a wait for subagents does not count) is
  interrupted with reason `stalled`, whatever front end started it, and its live session is closed
  rather than reused. Every run now sends the 30-second `heartbeat`, not only runs with a work slice,
  so a long quiet tool is no longer settled as `owner_gone`.
- **Switching accounts starts on the new account's model.** A conversation resumed on another
  account that names a model this account cannot use now starts on this account's own latest choice
  (with a notice), as the in-process terminal did, instead of showing and sending the old account's
  model. If nothing on the account is usable, no model is named and the harness picks one.
- **Plan and normal mode keep their own model and effort in the new terminal.** A mode that never
  chose an effort starts on the model's or account's default instead of keeping the other mode's; a
  mode switch during a reply waits for it to settle; a one-shot `/plan` shows and runs the plan
  mode's choice, then returns to the normal one.
- **The new terminal offers every effort level the model supports.** It stopped at `high`; it now
  lists `xhigh` and `max` where the model maps them, as the in-process terminal did, and runs a
  model at the nearest level it supports when asked for one it does not.
- **A reply whose provider request timed out and was retried successfully is now recorded as
  completed**, not failed.
- **A terminal window whose terminal closed no longer leaves its process running.** The frontend is
  ended three seconds after the hang-up if it has not exited by itself.

- **Make fenced code easier to read in the terminal.** Code blocks now use a bordered panel labeled
  from the fence language, with bundled tree-sitter highlighting where available and lightweight
  Python, shell and JSON fallback highlighting. The final-answer prompt asks for language-labeled
  fences and `bash` fences for commands the person must run; this changes the stable prompt prefix
  once.

- **Connect the agent to your own signed-in Brave profile (ADR-0082).**
  - A device-local browser backend. `/settings` → Browser offers **Isolated browser** or **Brave
    profile**; choosing Brave asks first, naming the extension's `debugger` permission, that a
    signed-in page may hold private information, and that a disconnect never switches backends. No
    project, variant or page can choose it.
  - The **Brave extension** row starts a loopback bridge on `127.0.0.1` and shows a one-time
    `port:code` that expires after five minutes. The unpacked `browser-extension/` folder now ships
    in the package and is loaded from `brave://extensions`. The bridge accepts only the paired
    extension origin with a bearer token, and keeps that pairing owner-only in
    `<state dir>/browser/extension-bridge.json`.
  - Each site is allowed separately in the extension popup by exact origin, port included; a tab
    that leaves an allowed site becomes unavailable. Incognito is disabled, and the extension asks
    for no history or cookie permission and exports no cookies.
  - Brave adopts the existing `browser_*` tools and the shared gate: snapshot-scoped refs that are
    invalidated when the page or the debugger attachment changes, a refused password field, and
    fresh approval for sending, buying, deleting, account changes and granting access.
    `browser_upload` stays with the App's WebKit backend.
  - An in-page badge reads “Xingular Agent is on this site” with **Pause** and **Stop**. Pause
    refuses new calls and lets an in-flight call finish; stop revokes the pairing and rejects
    pending calls. A lost connection refuses calls with a reconnect message instead of switching
    to the isolated browser.
  - New methods `browser.config`, `browser.configure` and
    `browser.extension.status|start|stop`, and `HarnessOptions.browserExtension` for a host that
    supplies its own browser provider. `browser.json` gains `backend`; `<state dir>/browser/` is
    now only profiles, downloads and pairing state.
  - The live acceptance test drives a disposable Brave profile against a fixture page and runs only
    when a person asks for it: `XINGULAR_BRAVE_LIVE=1 npx vitest run
    src/browser/extension/brave-live.acceptance.test.ts`.

- **A reply waiting on children, or on a flaky network, no longer looks stalled (ADR-0078).**
  - Each child a terminal reply waits on gets its own stall clock: fifteen minutes without
    progress, or thirty minutes inside one tool, ends that child as `stalled` and the parent
    receives its result as `interrupted`. The parent's own clock pauses while only child-wait tools
    run, so a long child is no longer recorded as the parent's stall.
  - A transient model failure retries eight times over about four minutes (2, 4, 8, 16, 32, 60, 60
    and 60 seconds) instead of Pi's three attempts over fourteen seconds. A retry budget the person
    set in their own settings still wins.
  - The working row says what the reply waits on instead of repeating the verb: `Waiting on 2
    subagents · last activity 12s ago (Read)`, `Running Bash · 1m 23s`, `Waiting for the model · no
    output for 1m 15s`, `Reconnecting 2/8 · retry in 12s`, and `No progress for 6m · Esc to stop`.
  - `heartbeat` events carry optional `activeTools` and `oldestToolMs`; hosts must tolerate both.

- **Edit the follow-up and steering queue from its own page.**
  - `/follow-up`, and clicking a `Steer:` or `Follow-up:` row in the transcript, opens a page that
    separates the two kinds, marks the next entry, and offers edit, send next, remove and return to
    the composer. Queued images are preserved and marked `· images`.
  - An explicit stop (`/stop` or Esc) now sends one unconsumed steering message before the
    follow-ups, so a correction typed while the reply ran is applied first. A normal completion
    still drains in FIFO order, and nothing is drained on a retry, a failure or a non-user
    interruption.

- **Every question sketch is drawn on one 80-column canvas (ADR-0080).**
  - The `ask_user` guidance asks the model for its `uiSketch` on a fixed 80-column canvas, and the
    terminal projects every valid sketch to 80 content columns: short rows are padded, a standalone
    divider spans the canvas, and the frame stays inside the dock with horizontal panning.
  - Padding is display-only. The permissive validator (1–24 lines, 80 columns), stored events and
    answer payloads are unchanged, and a host may keep its literal, scrollable preview.

- **No work-slice budget by default (ADR-0081).** A reply is no longer ended at 320 tool calls or
  60 minutes, and is no longer continued as a "next slice". The defaults are now no tool-call, time
  or token limit; `workSlice` on a run and `XINGULAR_WORK_SLICE` at launch still set one. The prompt
  no longer tells the model a budget exists, and the standard prompt's "ends only when the guard
  hands it back" now reads "keep working until the request is done or the person interrupts". The
  three-compaction guard stays. This changes the stable prompt prefix once.

- **Phase-led flexible reporting guidance (ADR-0079).** Final reports account for a reader picking
  up cold, state when verification was not run or failed, and give subagents a concise caller-facing
  report contract. Substantial multi-part reports often use content-named Markdown headings, with
  no fixed heading vocabulary; the duplicated progress-update line is removed from `reporting` and
  remains in `writing`. One example now demonstrates headings while the short blocked-publish
  example stays prose.

- **A plan run may conclude that no plan is needed (ADR-0077).**
  - A plan-mode reply with no outcome block is a valid `no_plan` ending: no plan card, no notice, no
    warning, and no repair turn. `plan_ready` and `blocked` are unchanged.
  - The plan instructions say to check whether the requested work already exists, to name the
    evidence and stop when it does, and that a person's instruction not to plan outranks the
    mode's output shape. The one hidden repair stays, but only for a block the model started and
    left incomplete, empty or in conflict; it may finish that block, state that there is nothing to
    plan, or return the blocked block.
  - Plan tags inside fenced or inline code are text, not outcomes, so a reply that quotes plan
    syntax is no longer `invalid`.
  - The terminal's warning reads “The plan reply left its plan block incomplete, so no plan was
    offered.” The App needs no change: it already shows a card only for a complete block.

- **Every tool-like name in CamelCase.**
  - `toolDisplayName` moves to `src/terminal/toolName.ts` and splits on any separator, so
    `todo_write`, `computer-screenshot`, `computer.screenshot` and `customTool` all read in
    CamelCase and the letters a name already has are kept.
  - The todo card reads `Todo` instead of `todo`; a custom message carries its type through the same
    helper (`note` reads `Note`); a running child's activity reads `Read` rather than `read`; and
    the approval prompt, the phone page's transcript and its approval card use the same names.
  - The `/todo` empty-state notice names `TodoWrite` rather than `todo_write`.
- **Codex's final-answer guidance, adopted verbatim (ADR-0076).**
  - The `reporting` section drops the four content questions, the by-hand check, the next-step
    block, the evidence table, the anti-pattern table and one example. It now carries Codex's
    final-answer and technical-communication text: self-contained, outcome first, what changed and
    why, how it was tested, risks and limits, evidence summarized, tables for comparisons, length
    by complexity, prose before lists. It is 3.7k characters (about 0.8k tokens), down from 9.2k.
  - Identity names the model (`Launch.model`, when the host knows it) and adds Codex's
    "collaborate until the intended goal is completely handled" sentence. A model switch after the
    pack is compiled leaves the line naming the starting model.
  - A new `personality` standard section carries Codex's personality paragraph; the unclear-scope
    rule becomes Codex's wording with `ask_user` for the follow-up question.
  - Codex's work rules join the tool guidance: `rg` first, no decorative command separators, shell
    quoting, no reused `$HOME`, no long blocking sleeps, tests only where meaningful and broadening
    them only when justified. Codex's skill and plugin principles join the Wiki guidance.
- **No todo gate; a reply ends when the model ends it (ADR-0075).**
  - The `stop-gate` extension, its three-nudge cap and its displayed `xingular-stop-gate` messages
    are removed. A reply the model ends settles `completed`; a stale todo item no longer marks it
    interrupted, and no checkpoint is written for it.
  - `STOP_GATE_GUIDANCE` becomes `WORK_SLICE_GUIDANCE`; `TODO_GUIDANCE` is relaxed and no longer
    says a reply is sent back. `XINGULAR_STOP_GATE` is retired and ignored if set.
  - A goal's stop (blocked, paused, at a limit) and the work-slice guard keep their codes and
    checkpoints. The goal loop is the only layer that continues a reply.
  - A login that blocks the work now names the exact command in the reply: reporting guidance,
    autonomy, `ask_user` and the todo guidance carry the rule, with a publish-blocked example.
- **A large, content-block reporting prompt (ADR-0073); superseded by ADR-0074.**
  - The `reporting` section in `src/prompt/reporting.ts` is about 15.8k characters: outcome first,
    required what-changed / how-to-test / what-to-do-next blocks for a change, optional beyond,
    departures, unverified and open-question blocks, five worked examples and an anti-pattern table.
  - Headings are the model's choice; the three fixed headings from ADR-0068 are gone.
  - `REPORTING_BUDGET` rises to 18,000, and the section is never cut.
  - The peer study is `docs/study/STUDY-0006-reporting-prompts.md`.
- **Report content, not report blocks (ADR-0074).**
  - The `reporting` section is about 8.9k characters (about 2.1k tokens, down from 3.7k), and
    `REPORTING_BUDGET` falls to 12,000. The section is still last in the stable prefix and never cut.
  - The four required blocks are gone. A reply answers what happened, what changed or was decided,
    what only a person can check and what they do next, in any words and any order.
  - Checks the agent already ran are one line of evidence each — command and result — and are never
    steps for the person. A by-hand check covers only what the agent could not do: a screen, a
    sign-in, a document's tone, a diff or PR, a publish, a deploy; it is left out when nothing needs
    a person, with no "nothing to check" line.
  - "Nothing needed" and "Nothing needed next" are banned. A finished reply with nothing left ends
    on its last real point.
  - Headings are free: no required name and no preferred set. Cross-domain examples and a
    shape-by-work table replace the four-heading vocabulary.
  - Three worked examples replace the five; the observed failure — a person's "how to test" filled
    with commands the agent ran — is an anti-pattern row.
  - The stable prefix changes, so existing sessions miss the provider cache once after the upgrade.
- **Skill installation guidance and package skill layouts.**
  - The release-owned `plugin-authoring` skill now says where a skill is installed (a project's
    `.pi/skills` and `.agents/skills`, the user's `~/.agents/skills`, the shared state folder), to
    copy a whole skill folder, and that `.claude/skills` is never read. It also says which installs
    only a person commits, and that `plugin_propose` is not an install route.
  - `plugins.install` refuses a GitHub or GitLab `tree`/`blob` page address with the repository
    address and the skill routes, instead of a raw git error.
  - A package's foreign plugin manifest (`plugin.json`, `.claude-plugin/plugin.json`,
    `.codex-plugin/plugin.json`) may declare `skills`; those folders load as package skills, under
    the package's switch and filter.

- **Codex's prompts and `/goal`; the completion check moves behind `/goal` (ADR-0072).**
  - **Ordinary replies.** No model-judged check runs on them. The todo gate stays and says the list
    is progress, not the limit of the work; `TODO_GUIDANCE` now says the request is the scope.
  - **Prompt.** A person's own session reads Codex's autonomy and persistence, when-to-ask,
    steering and compaction, and writing-style rules as separate sections, and a longer reporting
    section: unfinished work says so on the first line, with the reason and the next step.
    `ask_user` is never used to ask permission, and no answer means continue.
  - **Failures from outside the session.** A test or error that does not come from the session's
    work is reported with its command and output, not fixed, unless the person asks. It stays off
    the todo list, and it is a reason to stop that the autonomy rules name.
  - **`/goal <objective>`.** A long run the person starts. Codex's `get_goal` and `update_goal`,
    continuation, round-cap and edit prompts, `blocked` after the same blocker on three turns, and
    brakes for idle, failing and erroring rounds. `/goal edit|pause|resume|clear`, a footer label,
    Esc pauses. Caps: 30 rounds or 8 hours (`--rounds`, `--hours`).
  - **A completion claim is checked** once by the same model at low effort with a fresh context.
    `sessions.run` takes `goal`; `run.json` records `goalMode`.
  - **Fixed.** The check sends a session id, so opencode-go no longer answers 400 `MissingSessionID`.
  - Adapted from OpenAI Codex (Apache-2.0); see `NOTICE.md`.
- **A completion check replaces `finish` (ADR-0071; the every-reply check is superseded by ADR-0072).**
  - **The check.** When a reply that did work ends with its todo list closed or absent, the run's
    own model, at low effort and with a fresh context, judges the person's request against what the
    reply did: `done`, `continue` (the reply is sent back with the reason and next step), or
    `needs_person`. The request is the goal; there is no `/goal` command.
  - **Shared cap.** It shares the stop gate's cap of three nudges per reply and its no-progress rule.
  - **Usage and failure.** Its request counts in the run's usage, and any failure leaves the reply
    as it was.
  - **`finish` is removed.** A live GPT 6 Luna run used `needs_decision` after 23 seconds to ask
    something the handoff already answered. Only the check can now decide that the person is needed.
  - **Prompt.** The `role` paragraph names which decisions are the agent's own, says a document the
    request points to is the request, and says a question the request or files already answer is not
    a question for the person. Its budget rises from 1,500 to 2,200 characters, so it fits uncut with
    the subagent paragraph.
  - **Kill switches.** `XINGULAR_STOP_GATE=off` and `XINGULAR_COMPLETION_CHECK=off` at launch switch a
    layer off, for experiments.
- **The model is told it has `edit` and `write`.** Pi's `createEditTool` and `createWriteTool` drop
  the definition's prompt line and guidelines, and Pi lists only tools with a prompt line, so every
  terminal and headless run's system prompt named only `read` and `bash`. Models edited files
  through shell scripts instead: one 2-hour terminal run made 156 script edits (14 failed) and no
  `edit` call. `createWorkspaceFileTools` now restores the prompt line and guidelines, as Pi's own
  `createBashTool` does, for both the terminal and the runner. The stable prefix changes once.
- **A plan no longer leaks its tools into normal mode.** A terminal plan request narrows the active
  tools, and Pi records the restored normal set only with the next request. A rebuild before then
  (a new runtime, resume, switch, fork or tree navigation) replayed the plan set, so normal work ran
  without `edit`, `write`, browser and connected-app tools. One recorded session implemented a whole
  plan that way. The terminal now marks each plan request in the session and restores the normal
  set after any rebuild.
- **Terminal replies continue across work slices (ADR-0070).** A terminal reply that reaches its
  320-call or 60-minute budget after doing work now continues in place as the next slice, with a
  checkpoint and a notice, up to 8 slices, instead of waiting for "continue" and re-sending the
  whole context uncached. Fruitless, blocked, failed, aborted and plan slices still stop.
  `XINGULAR_WORK_SLICE` also accepts key=value pairs such as `maxToolCalls=15,maxSlices=3`.
- **One copy of each credential: no more `invalid_grant` from terminals.** A terminal's Pi kept the
  account's tokens in `auth.json` under its own lock while the host, its subagents and usage probes
  refreshed the same token in the Keychain under another, and `terminalEnd` copied the file back
  over whatever the Keychain held. OpenAI rotates refresh tokens, so whichever side refreshed second
  failed with `invalid_grant` and the account needed a new sign-in. A terminal now reads and refreshes
  through the host store (`accounts.credentials.*`, INV-ACC-5), holding its lock for the refresh. An
  `auth.json` left by an older terminal is folded in, newest token first.
- **A stalled terminal reply is recorded as `stalled`.** Pi's abort reports back through
  `terminal.interrupt` like a person's Esc, which closed the run as `user_abort` before the reply
  settled as `stalled`; one silent 15-minute hang was recorded as the person's abort. The interrupt
  now carries the stall. An interrupt also ends a settling reply's wait for its subagents.

- **A reply can no longer quietly stop with work open (ADR-0069).**
  - **Stop gate.** In attended top-level runs, terminal included, a reply that ends while its todo
    list has open items is sent back to the model, naming the items, up to three times per reply,
    and never after a nudge that produced no work.
  - **`finish`.** Added here as the one explicit way to stop with work open; removed again by ADR-0071
    above.
  - **Honest stop codes.** Such a reply settles `interrupted` with the new stop codes `needs_person`
    or `unfinished`, never `completed`, with a checkpoint the harness writes from the todo list,
    files and checks.
  - **`checkpoint_write` is removed.** A run used it as a sign-off and stopped with work open. At a
    work-slice budget the harness now writes the checkpoint itself.
  - **One budget per reply.** The work-slice budget now covers the whole reply: Pi's own
    continuations (nudges, delivered subagent results, plan repair) no longer reset it.
  - **Prompt wording.** The texts that read as permission to stop were rewritten: the todo guidance's
    "final update before your final reply", and `## What would make this complete` "when the run
    could be more complete".
  - **Subagents.** `spawn_subagent` now returns the child's tools, and the read-only profiles say up
    front when a brief needs a tool they lack.
  - **Hosts.** Accept the two new stop codes and offer Continue for them.
  - **Restart required.** A live terminal session keeps the code it started with, so restart it to
    get the gate.
- Do the job the request implies, and report it apart from the request. A standard session's role
  paragraph now sets the scope of the work — the obvious adjacent step, what the work itself exposes,
  the check it needs, inside the working folder and away from what a person must decide (a deploy, a
  secret, remote data, money), without asking first inside those bounds — and the reporting guidance
  requires two headings when they apply: `## Beyond what you asked` and
  `## What would make this complete` (ADR-0068). The reporting budget rises from 2,000 to 2,400
  characters so both fit uncut. All of it is stable-prefix text, so the cached prefix changes once
  per session.
- Say in the prompt when a reply may end. The standard session's role paragraph, the opening of the
  reporting guidance and the todo guidance now say that an open todo item, a passing check or a
  partial result is not a reason to end the turn, and name the reasons that are: the request is done,
  the work-slice guard hands the reply back, a person's decision is needed, or the person interrupts.
  ADR-0069 below now enforces it in the runner. A sweep of 822 runs in seven days found 207 that ended with work left
  (137 within 30 tool calls, median 17, and 191 with no checkpoint), which is what the wording is
  for. All three texts are in the stable prefix, so this changes the cached prefix once.
- Reword the final-reply guidance so the outcome leads and structure follows what the answer needs. The
  reporting guidance is part of every request's stable prefix, so this changes the cached prefix.
- Keep the provider cache working after a compaction (ADR-0067). The compaction checkpoint now arms only
  for a compaction during the running reply, is built once, and sits right after the summary instead
  of being rebuilt at the end of every request. A request after a compaction is again the previous
  request plus new items, so Codex WebSocket continuation and prefix caching apply. Before, every later
  turn of a compacted session resent its whole context: one measured session fell from 94–99% to
  18–24% cache hits after its first compaction.
- Flag a low prompt-cache hit rate in the terminal's composer status bar. `R<percentage>%` covers the last
  10 model responses instead of the whole session (`recentCacheUsage`, `CACHE_HIT_WINDOW`), and the rate
  gets a yellow `⚠` below 70 percent and a red one below 40 percent. The warning stays in the status bar;
  no cache-hit notice is added to the transcript. A window of one response, or one with no cache reads or
  writes, is not judged (`cacheHitLevel`, `CACHE_HIT_WARNING_PERCENT`, `CACHE_HIT_CRITICAL_PERCENT`).

- Refine a variant from the terminal and keep checkpoints of it (PROP-0052, ADR-0065, ADR-0066).
  `/refine [what to look at]` replays the latest request typed in this chat from a snapshot of the
  folder as that turn found it, in throwaway shared clones, after a confirmation that shows the run
  count and models; it runs in the background, and `/refine review` shows every candidate's changes
  and output and adopts any of them. Guidance reaches improvers and composers only, never the blind
  selector. Task runs default to this chat's model; `--model` sets the improver's, and an adopted
  version records the model it was tuned on. `/variant` switches this conversation to another
  version at the next turn (resuming the same conversation), restores, compares, tags, and takes
  single components back from an earlier version. New methods: `refine.fromRun`,
  `refine.candidateDiff`, `refine.candidateOutput`, `variants.tag|untag|tags|resolve|revert`. Run
  records gain `workspaceSnapshot`, version records `tunedFor`, and scopes `tags.json`.

- Start a conversation this account cannot use on the account's newest selection. A resumed
  conversation keeps its model while the account offers it and holds its provider's credentials;
  otherwise the terminal starts it on the mode's choice, then normal's, then the newest selection in
  any mode, with that selection's effort, writes the model change into the conversation, and says in
  one notice which model it replaced. A fallback is never saved as the person's choice, and with no
  usable saved model Pi's own fallback message stands (ADR-0064).

- Make unfinished-work handoffs actionable: the stable reporting guidance now names the person’s
  concrete decision or the next action and its owner for each material blocker, without imposing a
  fixed heading (PROP-0051, ADR-0063).

- Share the account sign-in between `npm run dev` and the installed `xagent`. A standalone launch
  can now take its account identity from another state directory with `--account-state <dir>`
  (`HarnessOptions.accountsDir` plus that state's `secrets.json`), and `npm run dev` passes the
  installed one, so one provider sign-in serves both while development keeps its own data,
  approvals and plugin trust (ADR-0062).

- Require owner-prefixed plugin commands on terminal and structured sessions. Plugin-owned prompt
  templates join extension commands under `/<owner-prefix>:<name>`, with no bare plugin aliases.
  A package can select a root template with `harness.defaultPrompt`; owner and route collisions fail
  closed. Standalone templates, `/skill:<name>` and core commands remain (ADR-0061).

- Make an approval a control, never a typed permission. The compiled guidance now tells the model to
  call the tool, the Harness pauses that exact call (`waiting_for_approval`), and Allow resumes it in
  the same turn; a denial returns a tool result on the still-running turn and says so, instead of
  inviting another prose request. Nothing outside the workspace changes before the click, and Full
  Permission remains the standing bypass (INV-GATE-9, ADR-0060).

- Record structured tool refusals and run stop codes, and expose them in trajectory search and the
  terminal trajectory page. Compaction events include available token measurements; older run
  records remain readable without these fields.

- Keep a refused question answer in the terminal. A choice, note or typed answer that the Harness
would reject now stays in the dock with an inline reason, instead of closing the form and losing the
draft; the reason names the question and the field (selection, typed answer or note), and the answer
is checked against the server rule before it is sent. The terminal was previously reopening an empty
question after any rejection, so a second Continue skipped everything.

- Scroll a `/btw` answer taller than its block. PageUp/PageDown now reach the side-question dock
while it is open, and the mouse wheel over the block browses it too; before this the transcript
consumed those keys, so the block's `PgUp/PgDn/wheel browse` hint did nothing. When the answer fits, the
keys scroll the transcript as before.

- Drop the context-use reading from the terminal's composer status line, so it no longer ends the
token group with a figure such as `6.6%/?`. The line keeps the project and branch, account, model
and effort, and input/cache hit rate/output tokens; the share of the window stays on the `/context`
page. Both the OpenTUI status bar and the exported `tui/status` band lose the reading.

- Render the `/btw` side answer as Markdown instead of plain text. Headings, emphasis, lists,
  quotes, links, tables and fenced code use the theme's markdown colours, and a streaming answer
  re-renders in place. Terminal control sequences in model output are still removed.

- Add `/remote-control` (alias `/rc`): continue a terminal session from a phone or iPad, as Claude
  Code's `/rc` does, without a cloud relay. The harness serves a small phone page on the computer's
  Tailscale address, or its private Wi-Fi address, and the terminal shows a QR code for a one-device
  pairing link. The person at the terminal allows each device; a paired phone then sends messages,
  watches the reply stream, stops it, and answers approvals and questions through the same paths
  the terminal uses. Every body is sealed with a key that reaches the phone only in the QR code's
  fragment, keys live in memory, and remote control ends with the session. `xagent --remote-control`
  turns it on at start; `/rc off` stops it. Terminal runs now also record streamed `message.delta`
  events. New dependencies: `tweetnacl`, `uqr` (ADR-0056, page 15).

- Recover a plan run whose reply loses its plan block. An attended top-level plan run now makes one
  hidden format-repair turn in the same run, asking the model to re-send its own plan in one complete
  block; a failed repair leaves the run completed and the terminal shows a warning instead of a plan
  choice. The plan-research children, commands, probes, improvers, reflections and other unattended
  runs are unchanged (ADR-0055).

- A live terminal reply now reports a heartbeat every 30 seconds, and one that produces nothing but
  heartbeats for 15 minutes is ended as `interrupted` with reason `stalled` instead of showing a run
  that never settles. A running tool gets 30 minutes and an unanswered approval or question is never
  cut short. Before this, a terminal reply reported no heartbeat at all, so the run sweep waited the
  full 30-minute silence window and recorded `owner_gone` while the process was alive (ADR-0054).

- Stop refusing repeated work. A reply is no longer refused, or ended, for calling the same tool
  with the same arguments three times, for a Bash check that keeps failing, or for editing one path
  more than four times: those calls are ordinary work, and the reply budget is the single bound. The
  320-call/60-minute budget, its checkpoint handoff, slice continuation and the three-compaction
  thrash rule are unchanged, and the `stuck` checkpoint reason stays readable in existing runs
  (ADR-0053).

- Make a skill named in a message required for that request. `$name` is a skill invocation at any
  word start, not only as the first token: `Launch.requiredSkills` carries it and the compiler
  renders a built-in dynamic `required-skills` section (order 52, 12,000 characters) from the pinned
  variant's `SKILL.md`, naming an unavailable skill honestly and falling back to the shipped
  `plugin-authoring` skill. It changes no tool or permission, and it belongs to the request, so an
  identical one is delivered again; structured sessions deliver it through `sessionLaunch` and the
  terminal appends the same text as a hidden `xingular-required-skills` message
  (`requiredSkillsText`). The terminal no longer rewrites a leading `$name` to `/skill:name`, and its
  `$` palette opens at the caret and inserts there, keeping the rest of the draft (ADR-0048).

- Bound delegation per run and per profile. `spawn_subagent` and `wait_subagents` still exist, but a
  run now starts at most four distinct child conversations: two `worker`, three `explorer`, one of
  any other named profile and one with no profile. The parent's `subagents` option overrides them
  (`maxChildren`, `maxByProfile`, `maxOther`, `maxUnprofiled`, clamped to 0–50), so a host and the
  terminal receive the same defaults; `Subagents.spawn` refuses a child past a limit with an
  `invalid_request` that tells the model to do the work itself, and starts no run. The count covers
  the runs the parent was continued from, continuing a stopped child costs no slot, and a concurrent
  spawn reserves its slot before it launches (ADR-0052).

- Record where a request's characters went. `renderSized` returns the prompt and each section's
  size, `Delivery.sizes` stores them on the recorded pack, and `Source.chars` attributes a variant's
  tool guidance inside the tools section, so `context.attribution` (`terminal.context` in the
  terminal) can return one row per contributor with its estimated tokens and share of the window,
  reconciled to the provider's measured total, plus one row's text. `context.snapshot` also records
  the compaction headroom the run was held to (`compaction: { enabled, reserveTokens }`) from Pi's
  own settings.

- Define an opt-in approved-window screenshot contract. `computer_screenshot` in
  `src/computer/screenshot.ts` takes a host backend that captures exactly one currently approved
  window, excludes the desktop, other windows and overlapping overlays, and refuses with
  `COMPUTER_SCREENSHOT_UNAVAILABLE` instead of falling back to a display capture. It goes through
  the ordinary tool gate and is not plan-mode safe; the standalone terminal has no backend, and the
  existing macOS host capture has not adopted the contract (ADR-0050).

- Watch approvals and questions through `terminal.pending.wait`: a control-key-protected revision
  snapshot that returns as soon as the pending set changes and otherwise waits at most 20 seconds,
  waking on additions, removals and disposal. `terminal.pending` stays available, the client
  resynchronizes after errors, and no persisted state or public protocol changes (ADR-0051).

- Swap the OpenTUI send keys back. `Return` sends, or queues a follow-up behind a running reply, and
  `Cmd+Return`, `Ctrl+Return` or `Alt+Return` steers that reply. The `app.message.followUp` action is
  `app.message.steer` again, so a `keybindings.json` entry under the newer name needs renaming.

- Keep a stray mouse report out of input. When the terminal delivers a mouse report in two pieces
  across the input parser's timeout, its `<button;column;row>` tail is dropped instead of being
  typed into the composer or a single-line field, so a scroll can never become a run's prompt or a
  filter. Text typed at human speed is never touched, pastes are never rewritten, and the Trajectory
  page no longer prints a recorded mouse report.

- Give top-level sessions a name and a current-state prompt. An unnamed session derives a
  provisional six-word name from its first substantive request; greetings and short replies stay
  unnamed, and the model can revise the name. Each top-level run also receives a request-scoped
  `Session state` update with the current name, this run's empty todo, and the previous run's list
  as context, in both the terminal and structured sessions. The stable system prompt is unchanged.

- Make annotating simpler. `/annotate:` is one full-screen page with an Annotate tab and an All
  annotations tab (`/annotate:notes`); the duplicate `/annotate:annotate` is gone. The page takes the
  page address, a DevTools port or an app to start in its own field, so no dialog hides behind it.
  The popover has two buttons, Annotate and Annotate & send; every annotation is shared with the
  session, and a note is either unsent or sent. There is no queue and no "fixed" status, and the
  agent's `page_notes_mark_fixed` tool is removed. New `/annotate:submit <request>` sends the unsent
  annotations with your request, and `/annotate:clear` resolves them. Press `a` to list the Electron
  and Chromium apps running with a DevTools port, type a port, or start an app with one. Running
  `/annotate:` again returns to the window that is still open, with its URL and the inspector on; the
  field appears only when no window is open. Sends no
  longer fail silently: a key pressed while the page is busy gets a notice, and a send held back
  while the agent was working is retried until the session is free. Any page that opens a dialog as
  it starts now shows it above itself (PROP-0048, ADR-0044).

- Install agent plugins written for other harnesses as they are. A package's `agents/*.md` files
  become subagent profiles (a new `agent` contribution, switched like a skill), named by their
  frontmatter, with other harnesses' tool names translated and nothing able to replace an existing
  profile. A package with no `package.json` name takes its name and description from `plugin.json`
  (or `.claude-plugin/` / `.codex-plugin/`). Google's Elephant-Goldfish Model, for example, installs
  with `xagent plugins install git:https://github.com/google/elephant-goldfish-model@<commit>` and
  brings its 7 skills and 9 reviewer profiles.

- Keep subagent progress through Esc, failures and restarts. A parent continues a stopped child with
  `spawn_subagent { continue: <runId> }`, which reopens that child's own conversation with its
  profile, tools, account and variant, instead of starting it again. The next reply hears about
  stopped children before it answers. A reopened terminal conversation still adopts children an
  earlier launch started. The `/subagents` page now shows the main agent as a `main` row (a
  reserved profile name), and both the page and the rows under the status line come back when a
  conversation is reopened, until the next run starts. Run records keep their `model` and `effort`
  (ADR-0043).

- Make the shell, write and edit tools work on Windows right after install. Commands run in Git
  Bash when it is installed and in PowerShell otherwise; the tool keeps the name `bash`. Windows has
  no write-boundary sandbox, so each command asks for a one-call approval unless Full Permission is
  on, and plan-mode Bash is refused there. Write and edit run their atomic helper with Node
  directly. `/doctor` names the Windows shell instead of reporting it as delegated to Pi (ADR-0042).

- Make `/doctor` check the use of Bash, not only that the executable exists. The local shell check
  now also reports the platform write-boundary backend (sandbox-exec on macOS, bubblewrap on Linux)
  whose absence stops every Bash call before it runs. The new live check runs one fixed command the
  harness wrote (`printf`) in the working folder through the same root, hard-link scan and sandbox a
  real Bash call takes, after the policy gate, and reports only the exit status. A diagnostic never
  widens the boundary, so a command that the boundary refuses before the shell starts is reported
  as blocked with that reason.

## 1.3.0 — todo progress, bounded work, and plugin management

- Make session naming and progress guidance concrete: name a session before the first tool call when work needs tools or changes state, and keep a todo list for multi-step work. Prompt and tool descriptions use the same wording; guidance remains advisory and subagents retain the parent's title.
- Rename the run checklist to todo: `todo_write`, `todo.updated`, `runs.todo`, the `todo` plugin and a todo block in the terminal. Add `/todo` (alias `/checklist`) to show the current list in the terminal and App without a model request. Existing runs still read `checklist.updated`; pinned `checklist_write` calls continue through `todo_write`; `runs.checklist` and `continuation.checklist` remain deprecated aliases for one release (PROP-0045).
- Raise work-slice defaults to 320 tool calls and 60 minutes, with no token ceiling unless configured. Make stall detection progress-aware, bound plan research to eligible read-only profiles, and restore the latest plan/todo context after compaction (PROP-0044–0046; ADR-0039).
- Separate `/plugins` local package management from `/hub` Community catalog discovery. Preserve all-channel Hub receipts and visible cache/refresh state; keep Hub-owned package removal receipt-aware and prevent floating updates (PROP-0047; ADR-0041).
- Improve terminal skill completion and highlighting while preserving command and argument distinctions.
- Make Doctor's Bash readiness check verify the required write-boundary sandbox and add a fixed, no-network live probe through the same workspace boundary; report policy blocks accurately without widening permissions.

## 1.2.0 — workspace safety and terminal capabilities

- Scope model-controlled file writes and Bash to the active project workspace by default; reject the filesystem root as a workspace. Native writes use revalidated atomic replacement; Bash fails closed on incomplete hard-link scans or unavailable sandboxing (macOS also blocks workspace-local hard links). Explicit outside-scope Bash requires approval before one execution, showing the complete escaped command; output never triggers approval or retry.
- Let plan mode run Bash in a read-only OS sandbox (no writes except a discarded temp folder, no network, nothing that widens it), so plans can check claims with commands such as `git log` (PROP-0043).
- Make plan mode evidence-grounded and allow bounded read-only research delegation. Rehydrate the active checklist and plan instructions after compaction, and retain the latest subagent status until the next run.
- Give plugin-owned terminal commands stable owner namespaces and make Harness-owned routes first-class core commands. Prior command forms remain hidden compatibility aliases for one release; update scripts and keybindings to canonical routes.
- Extend page annotations into open shadow roots while preserving existing document-only annotation targets. Closed shadow roots and frames remain unsupported.
- Record each run's resolved workspace root as an additive run-record field; older records remain readable.
- Add a searchable saved-session picker and composer history for user prompts, Bash commands and executed slash commands, restoring the draft, cursor, mode and attachments while browsing. Fix compact question-dock sizing/scrolling and narrow-page footer rendering.
- Add reproducible PTY and session-runtime profiling plus [EXP-0003's baseline report](docs/experiments/EXP-0003-performance-audit/results.md); it measures 1.1.1 on a dirty worktree, not 1.2.0.
- Update the pinned Pi runtime to 1.4.0, with the terminal adapter's private hooks and HTTP dispatcher chunk rechecked against it.
- Fix the work-slice stall guard reporting a reply's own checklist updates as repeated work. A call's identity is its name and every argument, hashed, instead of six fixed field names that made every `checklist_write` look alike; the counts and the nudge start fresh in each reply, so a terminal session no longer carries a repeat from one reply into the next. Three identical calls are still named once, and a repeat after that still ends the slice.
- Raise the work-slice defaults to 320 tool calls and 60 minutes, and drop the token cap by default: calls and the clock are the bound, and a token ceiling is available per run with `workSlice.maxNewTokens` for whoever wants one. A continuation keeps the policy, and eight slices still cap unattended work. See PROP-0044.

## 1.1.1 — agent profiles and named subagents

The first published release of the 1.1 line, and npm `latest`. It follows the 1.0.0 baseline; earlier 2.x–4.x numbers keep their existing meaning and are not reused. The 1.1.0 tag was pushed, but its release run stopped before publishing, so nothing was published under 1.1.0. This release carries the same changes, plus the release-pipeline fixes below.

- The release pack and smoke scripts take their npm cache from the system temp folder. They previously used a macOS-only path, which failed on Linux runners.
- The `/help` terminal check matches the documented grouped, scrollable help: it pages until every group is seen, and its expected group is `Plugins`.

### Changes in 1.1.0


- Add agent profiles (PROP-0029, ADR-0030). A subagent can start from a named profile: the built-in `worker` and `explorer`, a person's `<data root>/agents/<name>.md`, a repository's `.xingular/agents/<name>.md`, or a variant's c5 subagent. A profile narrows the child's tools and plugins and may choose its variant, model and effort. New `agents.list|get|create|remove` methods, `RunRecord.profile`, and `agent`/`unavailableTools` on the spawn result. The prompt's `subagents` section lists every profile. The terminal's `/agents` page browses, creates, edits (in `$EDITOR`), copies and deletes them, and the terminal now passes its variant to subagents, so c5 names work there.
- The terminal registers `checklist_write` (closing the terminal half of PAR-001), shows each write as a checklist block, and terminal subagents inherit it. The tool description and a new Progress paragraph in the prompt ask the model to keep a checklist for multi-step work, because the person follows progress from it. Each agent keeps its own checklist; there is no shared task pool.
- The subagent rows move under the status line, after one blank row, and lose their heading. Each row shows the status mark, the profile name in its colour, the title the parent gave the child and `n of m tasks` from its checklist. `/subagents` shows the same fields.
- Fix the transcript summary of `spawn_subagent`, which read the wrong argument names.
- Subagents take a title the parent sets (PROP-0030). `spawn_subagent` requires `title`, at most six words; `subagents.spawn` takes an optional one, which defaults to the first line of the brief. The live rows, `/subagents` and the transcript's spawn row show the title instead of the child's session name or brief. `RunRecord.title` stores it.
- A running subagent's row shows the working spinner in its profile's colour, and an in-progress checklist item shows a yellow dot.

## 4.0.0 — breaking terminal command namespace, managed worktrees, and annotations

- **Breaking terminal commands:** built-in plugin commands now use the `/plugin:` namespace. Existing `/doctor` and `/trajectory` commands become `/plugin:doctor` and `/plugin:trajectory`; update scripts and keybindings that invoke the old names. New feature commands are namespaced from their introduction.
- Add Harness-managed Git worktrees for sessions and the terminal, including isolated creation, leases, safe setup scripts, handoff, pruning, and bounded snapshots of work before removal.
- Add page annotations and queued page notes, with capture, review, resolution, sharing, and delivery through Harness methods and terminal `/plugin:annotate` and `/plugin:notes` surfaces.
- Add a unified terminal resource browser with persistent full-screen sections for browser tabs, plugins, skills, connectors, variants, and other Harness resources.
- Upgrade `/plugin:trajectory` to a full-screen Runs/Events browser with searchable event details, selected-event JSON, and responsive split-pane layout.
- Expand terminal controls for browsing subagent activity and managing browser and plugin settings; document the terminal/host parity boundary.
- Fix SQLite parameter binding for the supported Node 22 runtime and prevent early-exiting Git commands from raising an unhandled broken-pipe error.
- Generalize release packaging, smoke checks, registry verification, and CI workflows to use the package version, and require a clean committed tree for release candidates.

## 1.0.0 — stable baseline

- Established the public stable baseline under Apache-2.0, with compiled ESM SDK modules and declarations. Preserved historical version tags and assigned npm latest after release validation.
- Add /doctor with passive readiness inspection, selected live probes, cancellable reports and Node/RPC APIs.
- Include the generic isolated browser backend and document its boundary with App browser UI and native computer control.
- Add exact-tarball installation/consumer checks and a Bun-aware, two-OS release pipeline.
- This resets development numbering intentionally; it does not replace any published package.

### Included development changes

- Send pasted images to the model as images. In the OpenTUI terminal, Cmd+V of an image, a dropped or pasted image path, or `Ctrl+V` (now also on macOS, beside `Alt+V`) attaches the image as a blue `[Image #n]` label, and the image goes in the same user message as image content instead of as a file path the model had to ask about. A paste longer than three lines or 800 characters collapses to `[Pasted text #n +L lines]` and is expanded on send. Backspace, Delete and word deletes remove a label whole. Models without image input refuse the attach. `TerminalRuntime.submit` and `submitPlan` accept `images`; `scripts/verify-terminal.py --attachments-only` checks it in a real PTY.
- Add a run checklist. Every session with harness tools gets `checklist_write`, which records the model's whole checklist as a new `checklist.updated` run event; `runs.checklist` and `checklistOf` read the latest one, and plan mode allows it. A new built-in `checklist` plugin declares it. Hosts that check event types must accept the new kind. See PROP-0006.
- Continue a stopped run as a new run. `sessions.run` accepts `continueFrom`; the run reopens the earlier native history, keeps its account, tree version and capability set, and gets a dynamic `continuation` section saying where it stopped (checklist, unanswered requests, last tool, unfinished subagents). `runs.continuation` describes whether a run can be continued, and `Recovery` gains `interruptedRunIds`. New error codes `continuation_unavailable` and `continuation_mismatch`. A restart still never restarts model work. See PROP-0007.
- Add the opt-in `lessons` first-party plugin: after a completed top-level run, a read-only reflection session may keep one general lesson in the Wiki under `library/lessons/`, using refinement's cue/lesson shape and answer-free guards, capped in count and length. The Wiki pointer section says when lessons exist. Reflection runs carry trigger `reflection`, and the gate refuses anything in them that would need a person. `PiImprover` accepts a role (trigger, identity, tools). See PROP-0008 and ADR-0010.

- **Breaking (development snapshot labelled 5.0.0; included in the 1.0.0 baseline):** name the two halves of the harness. The **foundation** is the fixed half (compiler, sessions and run recorder, gate, accounts, trust, the refinement method); a **variant** is the half that mutates (the c1–c8 tree for one scope, formerly the "harness tree"). `INV-FND-1` and `INV-FND-2` state that only a variant changes and that it changes through one validated door. The spec gains a "Foundation and variants" section and a glossary; page 03 is now `03-variants.md` and `INV-TREE-n` is `INV-VAR-n`. See PROP-0009 and ADR-0011.
- **Breaking, protocol:** the `harnesses.*` methods are `variants.*` and the notice is `variants.changed`. The `harness` parameter of `sessions.run`, `context.compile` and `plugins.inventory` is `variant`; the `tree` parameter and field of the former `harnesses.*` methods is `variant`; `harnesses.materialise` returns `files` in place of `tree`; `treeDir` is `variantDir`; the save error code `harness_invalid` is `variant_invalid`. No aliases are kept.
- **Breaking, SDK:** `src/tree/` is `src/variant/`. `Tree`→`Variant`, `HarnessChoice`→`VariantChoice`, `TreeTrust`→`VariantTrust`, `readTree`/`writeTree`/`seedTree`→`readVariant`/`writeVariant`/`seedVariant`, `TreeError`→`VariantError`, `RunRecord.harnessScope`/`harnessVersion`→`variantScope`/`variantVersion`, `ContextPack.harness`→`variant`, `Materialised.tree`→`files`. The built-in plugin `harness` is `variant`.
- **Storage:** `harnesses/`→`variants/`, `versions/<fp>/tree/`→`…/variant/`, `tree-plugin-trust.json`→`variant-plugin-trust.json`, and the experience library's and a refinement's `harnesses/` folders are `variants/`. `open` migrates earlier data once and never overwrites; earlier run records and refinement records stay readable. Prompt text and the stable prefix are unchanged.
- The improver prompts and the evidence folder's `harness/` names keep the Harness² paper's wording on purpose; they are method text.

## 4.0.0 - 2026-10-22

- Publish the CLI executable as `xagent`; invoking it without a subcommand opens the OpenTUI terminal. The previous `xingular-harness` executable and interim `xharness` command are removed, so scripts and shell aliases must be updated.
- Name how refinement's executions run. `refine.start` (and `harness.refine.start`) accepts `executor: { model?, effort?, accountId?, poolId? }`, and `xagent refine run` accepts `--executor-model <id>` (`--model` still sets the improver). A host's own session settings win, then `executor`, then the account default, so a server client can pin the executor model without supplying a host. `summary.json` records `settings: { executor, improver }`. See PROP-0003.
- Keep refinement workspaces on request. `refine.start` (and `harness.refine.start`) accepts `retainWorkspaces: true`, and `xagent refine run` accepts `--retain-workspaces`: each base, candidate and final execution's workspace is copied whole — binary files included — to `<data>/refine/<id>/rollouts/<label>/workspace/` before the host cleans it up. `refine.candidates` reports each execution's `workspace` path or `null`. Evidence, selection, reflection and the library never read these folders, so refinement stays answer-free; they exist so an outside measurement can grade what an execution produced. Off by default. See PROP-0002.
- Shape every final reply. The compiler adds a fixed `reporting` section ("Reporting your work", `REPORTING_GUIDANCE`, `SECTION_ORDER.reporting = 95`) to every pack, after the tools: answer or outcome first, then only the parts with content — Files (a table when three or more), Blocked, Worth a look, Check by hand, Next steps — and Markdown tables where several items share fields. A format the person, the application or the current mode asks for wins. The stable prefix changes once, so existing sessions miss the provider cache once. See PROP-0001 and ADR-0007.
- Make typing in the OpenTUI terminal fast while idle and while a reply streams. Keys render on demand instead of on a fixed 60 Hz tick (idle p50 13.1 → 5.1 ms); the view is a reconciled Solid store, so a streamed delta updates its markdown block in place instead of rebuilding it; background updates are coalesced to one per frame (30 Hz during a run) while input publishes at once; finished messages and session statistics are cached. Streaming CPU fell from 73% to about 15% in the profile. See `docs/experiments/EXP-0002-opentui-typing-latency/`.
- Never swallow keys typed while a question waits: a character the question dock does not use moves focus to the composer and is typed there. Previously such keys were dropped until the dock collapsed.
- Read the composer's text before handling each key, so Enter sent in the same input chunk as typed text (a fast typist on a busy machine, or a paste ending in a newline) sends the whole text instead of a stale or empty draft.
- Reuse session-socket connections. A request may set `keep: true`, and the reply then leaves the connection open for the next request; the client keeps up to four idle connections per socket, unreferenced so short commands still exit. A request without `keep` behaves as before.
- Add `scripts/profile-terminal-latency.py` (`npm run profile:terminal-latency`) to measure keystroke-to-screen latency against pure Pi and opencode, and let `scripts/verify-terminal.py` match text on a rendered screen when `pyte` is installed.

- Animate the OpenTUI working spinner with the star glyphs in Warp too. Warp no longer gets the ASCII `| / - \` line spinner; every terminal uses the same star frames, and Ghostty keeps its own ending.

- Keep the OpenTUI home screen when a notice arrives before any conversation, such as `Unknown command: /tihnk`. The notice shows beneath the product mark instead of replacing it, and the composer keeps its "Ask anything…" placeholder.

- Swap the OpenTUI send keys back: `Return` sends, or steers a running reply, and `Cmd+Return`, `Ctrl+Return` or `Alt+Return` queues a follow-up. The `app.message.steer` action is renamed `app.message.followUp` again, so a `keybindings.json` entry under the older name needs renaming. Pending steering, follow-up and deferred plan/Bash inputs show above the working line with their delivery type, a queued plan or `!` command acts as a barrier that later inputs wait behind, and `Alt+Up` restores queued text to the draft.

- Draw the OpenTUI `select`, `confirm`, `input` and `editor` dialogs, including `/effort` and the Thinking setting, as the same flat centered panel on the scrim that `/model` and the other pages use, instead of a rounded bordered box. The box clipped the heading's `Esc` hint and the option count; centered dialogs now cap their height at the rows the overlay shows.

- Show a finished plan in the OpenTUI terminal. A plan request's complete `<proposed_plan>` block renders as a bordered card at the end of the reply, and a choice block above the composer offers `Implement "<title>"` (leaves plan mode, restores the normal tools and the mode's own model and effort, then sends `Implement the plan: <title>`) or `Edit the plan` (stays in plan mode and focuses the composer for revisions). `parseProposedPlan` in `src/sessions/planMode.ts` reads the block; `PlanChoice` in `src/terminal/opentui/planChoice.ts` owns the choice keys. `scripts/verify-terminal.py` gains a plan flow.

- Remember the model and effort each mode uses, per account. `src/accounts/choices.ts` stores them in the account's `choices.json`, and `Accounts.choices` / `Accounts.choose` read and write them; the server methods `accounts.choices` and `accounts.choose` and the terminal's `accounts.choices.get` / `accounts.choices.set` expose them, the terminal ones only for its own account. A new terminal conversation starts on the normal mode's saved choice when the account can still use the model; plan and normal switch to their own saved choice on Shift+Tab, and a one-shot `/plan` restores the session's model afterwards. Selections made in the terminal are recorded against the mode they were made in, and the terminal's own changes are never recorded.

- Stop a second Harness on the same data folder from interrupting the first one's active runs. Startup recovery now skips an active run whose owner marker (`runs/<id>/owner.json`, written by `runStore`) names a live process other than itself; only runs with a dead or missing owner are marked interrupted. Terminal tool calls that fail now report the cause (`The terminal controller is unavailable: …`), and a failed control claim is retried on the next call instead of being cached.
- Make OpenTUI the only terminal frontend. `Terminals.prepare` always launches Bun with `dist/terminal-opentui.js`; the `XINGULAR_HARNESS_TUI` opt-in, the legacy Pi terminal entry point and its frontend modules are removed. Bun 1.3.14 or newer is required for build and runtime, and `build:tui` fails when Bun is missing. `HarnessOptions.piProgram` remains accepted but is ignored.
- Present OpenTUI console pages and the `/model` and `/tree` pickers as centered dialogs: 80% of the terminal (capped at 100 columns by 30 rows), a flat panel, and a scrim that keeps the transcript faintly visible. Small dialogs and plugin full-screen surfaces are unchanged.
- Draw the OpenTUI command palette above the composer under an orange top rule in the `primary` colour, the only border it keeps.
- Rank command palette matches by name before description, so typing `/account` offers `/accounts` first instead of `/resume`, whose description mentions an account.
- Draw the OpenTUI composer as plain top and bottom rules with no panel background, put the working status and spinner above it, and move the model, context and token line underneath.
- Add Bash mode to the OpenTUI composer: a leading `!` replaces the chevron with `!` and colors the marker and both composer rules with `bashMode` while the command body keeps the normal text color; Backspace on an empty command returns to the prompt, and submitting sends `!command` through the normal Bash gate.
- Show the OpenTUI command palette as its rows only, without a border, title or key guide.
- Add leading `!` Bash mode to the standalone terminal composer and an opt-in `initialBashCommand` session input. Commands pass through the Bash gate, run once in native Pi history, and the agent reads the result before replying; busy terminal commands queue as standalone turns.
- Replace the terminal's titled-border boxes with flat blocks and independent command pages, each with its own tabs and consistent search. Add `/components` to browse the library and, after confirmation, add skills or rules to the active Harness scope as a new version for future sessions. Add `/btw` for a temporary side question and `/stop` to interrupt a reply; remove the separate `/login`, `/trust`, `/bug`, `/changelog`, `/share`, `/scoped-mode` and `/import` commands.

## 3.0.0 - 2026-10-19

Rebuilt on recursive harnessing (Harness², Apache-2.0, Google LLC). Breaking.

- Add harness trees (`src/tree/`): each caller scope has a versioned tree of eight components — system prompt, guardrails, memory, tool guidance, subagents, skills, scripts and plugins — that is validated, content-addressed, and pinned for a whole run. `SessionRunInput.harness` and `TerminalPrepareInput.harness` choose one; run records carry `harnessScope` and `harnessVersion`. Plugin code in a tree loads only after it is trusted (`TreeTrust`).
- Add refinement (`src/refine/`): Propose–Probe–Compose in parallel and sequential modes with the R=4k/P=3k budget identity, blind answer-free selection, reflection into a per-scope experience library, and adoption of the chosen tree. Executions and improver sessions are ordinary recorded runs, marked by the `probe` and `improver` triggers. `harness.refine`, `refine.*` and `library.*` RPC methods, and `xingular-harness refine demo|run`.
- Add the seventh extension point, `RefineHost`: where an execution works, as whom, with which tools, and what it produced.
- `spawn_subagent` takes `agent`, naming one of the tree's subagents; that child works from its own definition.
- Replace the Wiki with project notes (`src/wiki/`): linked Markdown under `wiki/`, versions, search, and `wiki_search`, `wiki_read`, `wiki_list` and a switchable `wiki_write`. An earlier Wiki's memory blocks, facts, revisions and Inbox are moved once to `legacy/wiki-<time>/`; nothing is deleted.
- Remove memory blocks, facts, proposals and the evidence gate, maintenance and the maintainer, curation, context profiles, the skills/rules/prompts registry as a source of prompt text, `registry_write`, `plugin_write` and `plugin_propose`. `harnesses.seed` builds a caller's first tree from what shaped it before (instructions, its rules, its memory blocks, its skills). `registry/` stays as a component library the Hub installs into and a tree can take items from.
- Hook events are `wiki.page.saved` and `history.run.ended`.

## 2.1.2 - 2026-10-19

- Add `/log`, a page of redacted Harness diagnostics and current-conversation run events.
- Allow argument-specific, provider-classified research calls during plan-mode runs while refusing other tools before approvals.
- Mark recommended options in batched questions and provide a picker for staged multi-select and free-text answers.

## 2.1.1 - 2026-10-19

- Change terminal `/plan` to run one isolated, read-only planning request; queue later messages until it settles and apply plan instructions only for that run.

## 2.1.0 - 2026-10-19

- Add per-request plan mode to SDK session runs: instructions arrive as a dynamic context update, and the tool gate refuses calls outside the read-only set. The terminal uses `/plan`, `/plan on`, and `/plan off` to narrow its active tools.
- Add bounded, UTF-8-safe Hub payload previews, explicit installed/changed/incomplete receipt states, and receipt-scoped uninstall that removes owned resources, including local edits within those paths.
- Highlight recognized leading slash commands in the terminal composer with the selected theme's link color, including enabled `/skill:name` invocations; unknown commands remain plain.

## 2.0.0 - 2026-10-18

- Let a connected app sign in with an OAuth client the application registered itself (`oauthClient: 'app'`), supplied through `HarnessOptions.oauthClients` and never stored; `connections.appClients` reports which catalog entries a build can sign in for. See [ADR-0005](docs/decisions/ADR-0005-app-provided-oauth-clients.md).
- Invoke a skill in the terminal as `$name` instead of `/skill:name`: the completion offers the loaded skills at a `$`, and a leading `$name` is sent to the model as that skill. A typed `/skill:name` still works, and `$` followed by a number or an unknown name stays ordinary text.
- Keep a stored key or sign-in when a terminal that began before it was saved ends, and let several terminals of one account share its auth.json across processes: a terminal saves only what its own Pi changed, and the last terminal out removes the file.
- Give every session bounded `trajectory_search` and `trajectory_read` tools for inspecting recorded run events without exposing credentials, attachments, or provider reasoning.
- Show terminal notices, such as mode changes, errors and the keyboard list, as rows in the conversation instead of above the composer; queued messages stay in the dock.
- Step the terminal's thinking effort with Shift+Up and Shift+Down within the levels the model supports. Shift+Tab toggles a read-only plan mode that withdraws changing tools until it is switched back.
- Show the product lockup above the terminal transcript only until the chat has a user message; a resumed session with history starts without it, and a header from a trusted extension is never hidden.
- Keep the terminal composer on the last rows in fullscreen while the transcript scrolls above it; `tuiMode: regular` keeps the flowing layout, and leaving fullscreen copies the conversation into scrollback.
- Add one native asynchronous subagent service for SDK, RPC and standalone terminal callers, with selective waits, parent joins, typed history receipts and explicit-resume recovery.
- Preserve capability ceilings and route child approvals/questions through the owning terminal; release pending interactions before SDK abort.
- Show a stable rotating work verb with an animated status glyph and keep the completion duration until the next turn.

- Harness owns the standalone terminal frontend, using persistent Pi 1.2.0 sessions and the inspected Oh My Pi 18.11.3 presentation.
- Add titanium and light themes, native session navigation, local command help and completion, account/plugin/Hub controls, and trusted extension UI hosting.
- Keep account isolation, exact prepared context and resource selection, the final tool gate, native histories and Harness run recording.
- Support grouped questions with atomic answers, cancellation and restored draft focus.
- Isolate stale plugin UI callbacks across session replacement and resource reload; restore terminal modes after fatal asynchronous failures and cleanup errors.

Implementation and verification limits are recorded in [the terminal reference](docs/terminal-tui.md).
