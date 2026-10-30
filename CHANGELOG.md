# Changelog

## Unreleased

- **A reply can no longer quietly stop with work open (ADR-0069).**
  - **Stop gate.** In attended top-level runs, terminal included, a reply that ends while its todo
    list has open items is sent back to the model, naming the items, up to three times per reply,
    and never after a nudge that produced no work.
  - **`finish`.** The new `finish` tool is the one explicit way to stop with work open: `blocked` or
    `needs_decision` with a reason. `done` is refused while items are open.
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
- Flag a low prompt-cache hit rate in the terminal's composer status bar. `R<percentage>%` now covers the
  last 10 model responses instead of the whole session (`recentCacheUsage`, `CACHE_HIT_WINDOW`), and
  gets a yellow `⚠` below 70 percent and a red one below 40 percent. Each drop to a worse level posts
  one transcript notice. A window of one response, or one with no cache reads or writes, is not judged
  (`cacheHitLevel`, `CACHE_HIT_WARNING_PERCENT`, `CACHE_HIT_CRITICAL_PERCENT`).

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
