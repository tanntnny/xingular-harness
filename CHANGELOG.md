# Changelog

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

- Rename the published CLI executable to `xharness`; invoking it without a subcommand opens the OpenTUI terminal. The previous `xingular-harness` executable is removed, so scripts and shell aliases must be updated.
- Name how refinement's executions run. `refine.start` (and `harness.refine.start`) accepts `executor: { model?, effort?, accountId?, poolId? }`, and `xharness refine run` accepts `--executor-model <id>` (`--model` still sets the improver). A host's own session settings win, then `executor`, then the account default, so a server client can pin the executor model without supplying a host. `summary.json` records `settings: { executor, improver }`. See PROP-0003.
- Keep refinement workspaces on request. `refine.start` (and `harness.refine.start`) accepts `retainWorkspaces: true`, and `xharness refine run` accepts `--retain-workspaces`: each base, candidate and final execution's workspace is copied whole — binary files included — to `<data>/refine/<id>/rollouts/<label>/workspace/` before the host cleans it up. `refine.candidates` reports each execution's `workspace` path or `null`. Evidence, selection, reflection and the library never read these folders, so refinement stays answer-free; they exist so an outside measurement can grade what an execution produced. Off by default. See PROP-0002.
- Shape every final reply. The compiler adds a fixed `reporting` section ("Reporting your work", `REPORTING_GUIDANCE`, `SECTION_ORDER.reporting = 95`) to every pack, after the tools: answer or outcome first, then only the parts with content — Files (a table when three or more), Blocked, Worth a look, Check by hand, Next steps — and Markdown tables where several items share fields. A format the person, the application or the current mode asks for wins. The stable prefix changes once, so existing sessions miss the provider cache once. See PROP-0001 and ADR-0007.
- Make typing in the OpenTUI terminal fast while idle and while a reply streams. Keys render on demand instead of on a fixed 60 Hz tick (idle p50 13.1 → 5.1 ms); the view is a reconciled Solid store, so a streamed delta updates its markdown block in place instead of rebuilding it; background updates are coalesced to one per frame (30 Hz during a run) while input publishes at once; finished messages and session statistics are cached. Streaming CPU fell from 73% to about 15% in the profile. See `docs/experiments/EXP-0002-opentui-typing-latency/`.
- Never swallow keys typed while a question waits: a character the question dock does not use moves focus to the composer and is typed there. Previously such keys were dropped until the dock collapsed.
- Read the composer's text before handling each key, so Enter sent in the same input chunk as typed text (a fast typist on a busy machine, or a paste ending in a newline) sends the whole text instead of a stale or empty draft.
- Reuse session-socket connections. A request may set `keep: true`, and the reply then leaves the connection open for the next request; the client keeps up to four idle connections per socket, unreferenced so short commands still exit. A request without `keep` behaves as before.
- Add `scripts/profile-terminal-latency.py` (`npm run profile:terminal-latency`) to measure keystroke-to-screen latency against pure Pi and opencode, and let `scripts/verify-terminal.py` match text on a rendered screen when `pyte` is installed.

- Animate the OpenTUI working spinner with the star glyphs in Warp too. Warp no longer gets the ASCII `| / - \` line spinner; every terminal uses the same star frames, and Ghostty keeps its own ending.

- Keep the OpenTUI home screen when a notice arrives before any conversation, such as `Unknown command: /tihnk`. The notice shows beneath the product mark instead of replacing it, and the composer keeps its "Ask anything…" placeholder.

- Swap the OpenTUI send keys: `Return` now queues a prompt behind a running reply (it still sends when idle), and `Cmd+Return` steers the reply mid-run. `Alt+Return` also steers, for terminals that do not report Cmd. The `app.message.followUp` action is renamed `app.message.steer`, so a `keybindings.json` entry under the old name needs renaming.

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
