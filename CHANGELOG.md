# Changelog

## Unreleased

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

- Add `/log`, a full-screen snapshot of redacted Harness diagnostics and current-conversation run events.
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
