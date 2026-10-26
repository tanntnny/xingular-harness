# Handoff: App parity with the Harness, and the Solo sidebar and tabs (updated 2026-11-19)

The scoped implementation and documentation are in place; full parity acceptance remains open.
Nothing is committed. The working trees contain substantial pre-existing uncommitted work; preserve
it and do not revert unrelated files.

| Repository | Branch | State |
|---|---|---|
| `Xingular Agent/Harness` | `release/1.0.0` | Code and architecture docs updated; typecheck, full tests and `prove` pass |
| `Xingular UI` | (current) | Shared tab-manager change; typecheck and full tests pass |
| `Xingular Agent/App` | `app-as-frontend` | Profile safety, commands, Solo tabs, browser refusal and docs updated; automated checks pass |
| `Xingular Workspace` | (current) | Shared-UI consumers typecheck and UI check pass; four test failures were observed |

Approved plan: `~/.claude/plans/i-wanna-make-change-velvet-nova.md`.

## What the owner asked for

1. Solo sidebar: **Project › Session**, with no folder or worktree level. People never configure
   worktrees. A new session runs in the project folder, as `xagent` does in a terminal.
2. Each session card has two rows: the title, then a muted row such as `2h ago · 5.1MB`.
3. One shared top bar over the chat, with tabs and an icon-only view switch:
   - **Split**: every open session is its own panel (the earlier behaviour).
   - **Single**: one panel; clicking a tab replaces what it shows.
4. The sidebar shows which sessions are open. A middle click on a tab closes it. Closing a tab
   only closes the tab; it never archives the session.
5. Every Harness terminal slash command works in the App.
6. The prompt, runtime, plugins and skills are the same in both front ends. Features that work
   better in the App (annotate capture, the WebKit browser, computer control) are labelled as
   add-ons in their plugin descriptions.

Choices the owner made:
- Parity: same core, plus labelled add-ons.
- Build every command now.
- Closing a tab only closes it.

## Done

### Harness

- **Shared command registry.** `src/commands/registry.ts` holds `CORE_COMMANDS`, plain data, each
  with `kind` (session, page or local) and `methods`. The terminal's `BUILTINS` now comes from it
  (`src/terminal/tui/commands.ts`).
- **`commands.list` server method** (`src/commands/list.ts`). It returns core commands, built-in
  plugin commands (`annotate:…`), extension commands with their owner prefix, prompt templates
  and `skill:` entries.
- **Session control methods** (`src/sessions/control.ts`, wired in `src/server/methods.ts`):
  - `sessions.tree`, `sessions.navigate` (no summary; the move is saved as a `xingular-navigation`
    custom entry so the next turn opens on it)
  - `sessions.fork`, `sessions.clone` (both into a `targetDir`)
  - `sessions.rename`, `sessions.lastReply`, `sessions.export` (JSONL)
  - `sessions.reload`
- **Session command runs.** `SessionRunInput.command` / `TurnParams.command` accepts `compact`,
  `navigate` (with a summary) or `export` (HTML). `runTurn` runs the command instead of a prompt
  and skips the context update. `checkCommand` in `src/sessions/sessions.ts` validates it.
- **One launch path for prompts and tools:**
  - `Launch.standard` (`src/prompt/standard.ts`) adds the same role, working-folder (with the
    project name) and connections text for every front end.
  - The terminal always uses it; the App now asks for it.
  - The terminal-only `xagent-wiki` wording is gone from `compile.ts`. There is one files-and-shell
    paragraph for every caller, and a standard session always gets it.
  - A new Annotations tool group carries the `page_notes_*` guidance, moved from the App.
- **The terminal gets the same tools:**
  - The Harness History, Wiki and skill tools go over the socket (`ownTools` in
    `src/terminal/terminals.ts`), which closes PAR-002.
  - Output trim and Budget guard load in the terminal (`firstParty.list` socket call plus
    `piExtension.ts`), which closes PAR-006. Budget guard now resets its count per reply
    (`agent_start`).
  - The terminal-only `ask_user_question` alias is removed; `ask_user` covers it.
  - The `pi` command's own extensions (llama.cpp, codemode, tool-search, mcp) are no longer loaded
    in the terminal, because a host session cannot have them. See `catalogue.ts` and
    `inventory.ts`.
- **`xagent --variant <scope>`** (`src/terminal/standalone.ts`, `src/cli.ts`). With the App's
  `--data`, the terminal runs on the same variant as an App agent.
- **Add-on labels.** New `PluginDescriptor.surfaces` / `Plugin.surfaces` field
  `{ preferred: 'host', terminal: 'fallback' | 'unavailable', note }`, with helpers in
  `src/plugins/surfaces.ts`.
  - The annotations plugin is labelled. The layer check forbids naming the App inside the
    Harness, so its text says "a desktop app built on this harness".
  - The terminal's `/plugins` and `/harness` pages show the note and a badge.
- **New exports** in `src/index.ts`: the registry, `SessionCommand`, `SessionTree`,
  `PluginSurfaces`, `describePlugin`, `STANDARD_CONNECTIONS`.
- **Tests:**
  - Added: `src/commands/registry.test.ts`, `src/sessions/control.test.ts`,
    `src/prompt/surfaceParity.test.ts` (a terminal and a host session compile to identical text
    and tool groups), and session-command tests in `sessions.test.ts`.
  - Updated: terminal, catalogue, standalone, runtime-socket and lifecycle tests.

### Xingular UI

- `WorkspaceTabManager` (`src/ui/document-workspace.tsx`): new `addLabel`, and `activeTabId` may
  be `null`. Test added in `tests/workspace-tabs.test.tsx`. Middle-click close already existed.

### App

- **Solo model rewritten:**
  - `src/modes/solo/soloLayout.ts` (version 2): one layout across projects. Every open tab has a
    pane; `view` is `split` or `single`. Functions: `openSoloTab`, `closeSoloTab`, `focusSoloTab`,
    `visibleSoloTree`, `restoreSoloLayout` (migrates version 1).
  - `soloWorkspaceState.ts`: storage key `…:v2`, migrated from the v1 key.
  - `soloThreads.ts`: `groupSoloProjects`, `projectDefaultGroup`, `tabGroup`, `tabProjectId`.
- **Sidebar** (`SoloThreadList.tsx`):
  - Project › Session, with two-row cards (`sessionMeta`) and an open/active indicator
    (`data-open`, `data-active`, `data-solo-open-indicator`).
  - Each session's ⋯ menu has Archive and Remove.
  - The project's + button starts a session in the project's default folder group.
  - The group rows and worktree controls are removed, and `SoloGroupDialog.tsx` is deleted.
- **Center** (`SoloCenter.tsx`):
  - `SoloTabBar` and `SoloViewToggle` sit in the shared `PageFrame` compact header, wired in
    `SoloWorkspace.tsx`.
  - Per-pane headers are removed.
  - ⌘W / ⌘T now call `closeFocusedTab` / `newSession` (`src/shell/frameControls.ts`,
    `src/App.tsx`).
- **Session size.** `ThreadSummary.size_bytes` (Rust `history_bytes` in `agents.rs`) and
  `sizeBytes` in `shared/contracts.ts`. `formatSessionSize` in `shared/files.ts` matches the
  terminal's format.
- **Slash commands from the Harness:**
  - `src/modes/solo/soloCommands.ts` has a handler for every non-sending core command.
    `soloCommands.test.ts` fails if the registry gains one without a handler.
  - `SoloCommandPicker.tsx` is the picker or page dialog.
  - `SoloConversation.tsx`:
    - The `/` menu and highlighting come from `commands.list`.
    - Aliases (`/side`, `/tree`, `/resume`) work.
    - A bare `/plan` toggles a persistent plan mode, and a bare `/btw` dismisses the side question.
  - `chatCommands.ts` is reduced to `isStopCommand` and `chatCommandInput`. The duplicate
    extension-command helpers in `pluginModel.ts` are removed.
- **Host side:**
  - New Tauri commands in `src-tauri/src/agents.rs`, registered in `lib.rs`: `session_tree`,
    `session_fork`, `session_clone` (fork and clone copy the transcript too), `session_rename`,
    `session_compact`, `session_export`, `session_reload`.
  - New sidecar `agent.command` (`createSessionCommand` in `sidecar/src/agentRuns.ts`).
  - `RENDERER_METHODS` (`src-tauri/src/harness.rs`) gained `commands.list`, `doctor.*`,
    `worktrees.list/status` and `agents.list/get`.
  - Bridge: `bridge.commands`, `bridge.session` and `bridge.harnessPages` in
    `src/bridge/commands.ts`. The schemas are in `shared/sessionCommands.ts`.
- **Prompt:**
  - `src-tauri/src/prompts.rs` no longer writes identity, role, working-project or its own
    connections text.
  - It keeps only the add-on groups: App browser and computer, Files, Capabilities, Reactions.
  - It adds a `folder-access` section for trusted folders.
  - `agents.rs` sets `launch.standard = { cwd }`.
- **Plugin labels:**
  - `sidecar/src/appPlugins.ts` labels every App part as an add-on, with `surfaces`.
  - `app-identity` and `app-web-guidance` are removed, and `app-folder-access` is added.
  - The Plugins screen shows a "Better in the app" or "App only" badge (`pluginModel.ts`,
    `PluginCatalog.tsx`, `PluginInspector.tsx`).
  - The plugin schema gains `surfaces`.
- **Guide demo** (`src/modes/guide/SoloWorkspaceExample.tsx`) and the Playwright fixtures and
  specs (`tests/browser/solo-*.{fixture.tsx,spec.ts}`) are rewritten.
- **Shared interactive profile and root safety:** production App and standalone use the Harness
  profile at `~/.xingular-harness/profile.json`; development uses the isolated
  `~/.xingular-harness-dev/profile.json`. Existing App roots are adopted by reference, explicit
  `dataRoot` overrides remain authoritative, and conflicting populated roots block startup rather
  than merge. Historical account/variant/path/cwd pins are not rewritten. Legacy App Support moves
  only if the destination is absent; if both trees exist, startup reports a recovery error and
  leaves both untouched. Development paths are checked against production, including symlink
  traversal. The App resolves the selected host credential backend through Keychain and fails
  closed; the terminal also fails closed without a host adapter. Disposable App identifiers remain
  blocked until an isolated Keychain adapter exists. Sidecar startup requires and validates the
  selected profile and state-directory paths. Coverage is in `sidecar/src/profile.test.ts` and
  `src-tauri/src/{state.rs,host.rs,secrets.rs}`.
- **Browser safety:** unsupported native WebKit operations (refs, accessibility snapshots,
  screenshots, waits, and key presses) return an explicit refusal before effects; the App does not
  switch automatically to the isolated Harness browser.
- **Current App documentation:** accepted ADR-0033 records Project › Session and shared tabs;
  ADR-0027 and the obsolete pane-header portion of ADR-0031 are marked superseded. FEAT-0010,
  FEAT-0018, the Solo glossary, architecture/implementation pages, and this handoff now describe
  shared profile defaults, remaining gaps, and current verification.

## Check results (2026-11-19)

| Check | Result |
|---|---|
| Harness `npm run typecheck` | pass |
| Harness `npm test` | pass: 163 files, 1,255 passed, 3 skipped |
| Harness `npm run prove` | pass: build and standalone proof suite; no provider request |
| App `npm run typecheck` | pass |
| App `npm test` | pass: renderer 90 files/586 tests; sidecar 11 files/86 tests |
| App `npm run check:layers` | pass |
| App `npm run check:ui` | pass: 38 recorded findings, baseline 38 |
| App `cargo test` | pass: 186 passed, 1 ignored; compiler warnings remain |
| App `cargo test --features dev-profile` | pass: 189 passed, 1 ignored; compiler warnings remain |
| App Playwright | pass: all 61 tests with installed Chrome |
| Xingular UI typecheck and `npm test` | pass: 21 files, 124 tests; the package has no `check:ui` script |
| Xingular Workspace typecheck | pass |
| Xingular Workspace `check:ui` | pass: 79 findings, baseline 87 |
| Xingular Workspace `npm run test:run` | **4 failed, 993 passed**: three `assistantService.test.ts` cases hit the Harness Pi-version guard (requires Pi 1.2.0, found 1.4.0), leaving the fake provider's `release` callback unset; one `commandPaletteNoteItem.test.ts` assertion expects an inline SVG style string that is absent |
| Xingular Workspace `electron-vite build` | pass (targeted tab-E2E run) |
| Xingular Workspace tab Playwright (three selected tests) | **3 failed before tab assertions**: shared `launchWithFixture` clicked the Notes sidebar control, then `expectNotePanelReady` timed out. The run used temporary `HOME`, `TMPDIR`, vault and user-data paths; no root cause was established |

Browser command: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx playwright test --reporter=list`.

No provider calls or owner profiles were used. Tests use fixture or temporary data. The Workspace test failures were not changed as part of this task; the shared-tab tests in Xingular UI and App Playwright passed.

## Remaining gaps and decisions

1. **Parity acceptance is not complete.** The source routes and command handlers are present, but each fixed core command still needs its own acceptance. `PAR-002` (Harness History/Wiki/skill tools) and `PAR-006` (first-party hooks) are implemented on both surfaces but acceptance has not been recertified. `get_capabilities` is now Harness-owned; the App has no duplicate tool.
2. **The session catalog remains separate (`PAR-008`).** App `/session` lists App-owned Solo threads; terminal `/session` lists native Pi histories. The read-only audit recommends a Harness-owned catalog of opaque references to existing native histories—not merging or copying transcripts or IDs. Keep logical/App and native Pi IDs distinct; retain the exact locator privately, preserve account/path/cwd guards, fail rather than substitute an unknown account, and serialize shared writes. This is a recommendation, not an implementation; do not claim `/session` parity.
3. **Other registered gaps remain:** `PAR-001` App checklist surface; `PAR-003` continuation; `PAR-004` terminal variant/refinement actions; `PAR-005` App-only Wiki browsing; `PAR-007` host-backed computer/files capabilities; `PAR-009` shared recent-folder choice; `PAR-010` Solo `/agents` detail/management; `PAR-011` native WebKit annotation-gesture acceptance; `PAR-012` Solo worktree status/create/remove; and `PAR-015` native WebKit browser coverage. Unsupported browser refs, accessibility snapshots, screenshots, waits, and key presses explicitly refuse before effects; there is no automatic switch to the isolated Harness browser.
4. **Profile interoperability is intentionally bounded.** Production App and standalone share profile-selected data/state defaults; explicit roots, `--variant`, and historical run pins remain authoritative. The App's per-agent variant is still an App-supplied override. App credentials use the host Keychain backend; a frontend without that host adapter fails closed, and disposable App identifiers are blocked until an isolated Keychain adapter exists. Shared roots do not mean credential-store copying or automatic account substitution.
5. **Native App acceptance was not performed.** The full Playwright suite ran against isolated browser fixtures, not a Tauri window. No real-model request or user profile was used; the native Keychain and WebKit surfaces therefore remain unverified in a running App.
6. **Workspace test failures need a separate follow-up.** `assistantService.test.ts` requires the pinned Pi runtime but this Workspace installation resolves Pi 1.4.0; `commandPaletteNoteItem.test.ts` has an SVG markup expectation mismatch. Typecheck and `check:ui` pass.
7. **Commits:** one per repository, in order Harness → Xingular UI → App, only when the owner asks. No files were committed in this work.
