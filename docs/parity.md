# Capability parity register

**Status:** descriptive register, as of 2026-11-19. The binding rules are
[14 Surfaces and parity](architecture/14-surfaces-and-parity.md) (`INV-PAR-1`–`INV-PAR-4`).

Every capability a person can use is a Harness capability. The standalone terminal (`xagent`)
is the reference front end; a host such as the App presents the same capabilities with a richer
UI. This page lists each capability, where the Harness owns it, how each front end shows it, and
whether both pass. A gap has an ID (`PAR-NNN`) until it is closed.

Host-only surfaces (presentation a terminal cannot show, `INV-PAR-4`) are not listed here; each
host keeps its own register. The App's is
[`App/docs/architecture/app-only-surfaces.md`](../../App/docs/architecture/app-only-surfaces.md).

Status: **parity** only where both surfaces passed acceptance; **implemented** means source routes
exist but acceptance is not certified; **terminal only**, **host only**, **partial**, **planned**,
and **host-backed** (needs a host object; terminal fallback named). A slash-command row marked
implemented is not a parity claim; acceptance is tracked per command.

## Register

| Capability | Harness owner | Method or tool | Terminal surface | App surface | Status | Gap |
|---|---|---|---|---|---|---|
| Sessions and turns | `sessions/` | `sessions.run`, `terminal.*` | the terminal itself | Solo chat | parity | — |
| Plan mode | `sessions/planMode.ts` | `plan: true` | `/plan`, Shift+Tab, plan card; shared outcome and bounded repair; plan/todo context restored after compaction | plan request, PlanCard; shared Harness classification and checkpoint behavior | ADR-0058 clarification contract approved; implementation and surface acceptance not verified | — |
| Capability discovery | `tools/getCapabilities.ts` | read-only `get_capabilities` | terminal extension reports Pi's active tools and schemas; shared plan allowlist includes it | structured Harness run uses the same tool; no duplicate App-owned tool | implemented; acceptance not recertified | — |
| Bash command mode | `sessions/sessions.ts`, `sessions/initialBash.ts` | `initialBashCommand`; Bash `workspaceWriteScope` | `!command` defaults to workspace; `!outside command` asks before running once | same `!command` and `!outside command` composer semantics | parity | — |
| Workspace-scoped writes | `core/workspace.ts`, `sessions/workspaceBoundary.ts`, `core/workspaceBashTool.ts`, `core/workspaceSandbox.ts`, `core/workspaceWriteOperations.ts` | pinned non-root `RunRecord.workspaceRoot`; native `edit`/`write`; Bash scope | revalidated atomic native writes; external-hard-link scan and Bash sandbox (Windows: no sandbox, each Bash call asks once, plan-mode Bash refused; ADR-0042); complete escaped outside command in scrollable approval details (deny if too small); no output-triggered retry | same Harness gate and full approval action in scrollable App details; App policy can tighten scope; Full Permission remains the eligible explicit bypass | parity | — |
| Side questions | `sessions/sideQuestions.ts` | `sideQuestions.start/read/interrupt`; terminal `terminal.sideQuestions.*` | `/btw` contextual dock; the answer renders as Markdown, with scroll and copy | side-question dock through the shared service | parity | — |
| Approvals and standing approvals | `sessions/approvals.ts` | `approvals.*`; run events `approval.requested`/`approval.resolved` | decision dock, `/permissions`; the call pauses in `waiting_for_approval` and resumes in the same turn | approvals dock above the composer, approval notification in the notification inbox and as a system notification while the window is hidden; settings | parity | — |
| Opening a link | `core/links.ts` | `links.open`; `HarnessOptions.linkOpener` (ADR-0047) | hover shows the hand pointer and recolours the link, Ctrl+click (the primary click on macOS, whose ⌘ the mouse protocol cannot report) opens web, `mailto:`, file and folder targets with the system handler, a refused link posts a notice | ⌘-click on macOS and Ctrl+click elsewhere opens with the system handler, a plain click keeps the sidebar and falls back to the system for what it cannot show, `a:hover` uses `--link-hover` | implemented; acceptance not certified | — |
| Questions (`ask_user`) | `tools/askUser.ts` | shared `ask_user` tool | plan-mode dock: strict aligned columns, bounded body scroll, 80×24 source sketch viewport; connected structural projection with high-confidence boundary normalization (PROP-0026, PROP-0028) | plan-mode form accepts the same 80×24 ASCII source contract with literal preview and accessible overflow; no typography change required | existing question surface parity; ADR-0058 plan clarification contract not verified | — |
| Subagents | `sessions/subagentService.ts` | `spawn_subagent` (requires `title`, PROP-0030; `continue` resumes a stopped child, ADR-0043), `subagents.*`; plan mode allows only named eligible read-only research profiles; per-profile and total child budgets enforced in `Subagents.spawn` (ADR-0052), with the same refusal result in both surfaces | `/subagents` page with the `main` row pinned first, and live rows under the status line (mark, profile, parent-set title, `n of m tasks`), both rebuilt from saved runs when a conversation reopens; plan-mode research delegation uses the same Harness gate | reply trajectory; plan-mode research delegation uses the same Harness gate | parity | — |
| Agent profiles | `agents/profiles.ts` | `spawn_subagent { agent }`, `agents.list/get/create/remove`; terminal `terminal.agents.*`; package profiles through `Loading.profilePaths` | `/agents` page: browse, create, edit in `$EDITOR`, copy, delete; package profiles listed under "From a plugin" and switched on `/plugins` | Solo `/agents` lists profiles; profile details and management are not wired | partial | PAR-010 |
| Run todo list | `tools/todo.ts` | `todo_write`, `runs.todo` (`runs.checklist` deprecated); terminal `todo` telemetry | registered in terminal sessions and their subagents; each write shows as a todo block in the transcript; `/todo` shows the current list; a subagent row shows its `n of m tasks` | `/todo` shows the current list on demand; each write is not rendered inline | terminal done; App shows it on demand | PAR-001 |
| Continuation of a stopped run | `sessions/continuation.ts` | `continueFrom`, `runs.continuation` | not offered (`/resume` reopens history only) | not offered | planned | PAR-003 |
| Bounded replies and checkpoints (PROP-0041) | `sessions/workSlice.ts`, `tools/checkpoint.ts`, `sessions/runner.ts`, `terminal/stallWatch.ts` | `checkpoint_write`, `workSlice`, `runs.continuation.checkpoint`, `checkpoint`/`heartbeat` events | guard on every terminal reply with the shared tool; every live reply heartbeats and a reply with no progress for fifteen minutes ends as `stalled`; the handoff is recorded on the run; no checkpoint card or slice control yet | not wired | implemented; terminal card, App presentation and `/slices` open | PAR-004 |
| Accounts | `accounts/` | `accounts.*` | `/accounts` | Accounts | parity | — |
| Models and effort | `accounts/choices.ts` | — | `/model`, `/effort` | composer pickers | parity | — |
| Skills | `plugins/`, `tools/dispatch.ts`, `prompt/compile.ts` | `skill_load`; `Launch.requiredSkills` | `$name` at any word start (required for that request), `/skill:name`, browser Skills tab | composer `$` chip with `requiredSkills`; Capability | implemented; acceptance not recertified | — |
| Plugins and Hub | `plugins/`, `hub/` | `plugins.*`, `hub.*` | full-screen `/plugins` local manager; separate full-screen `/hub` Community catalog with bounded registry/document Preview (no Pi-package Preview) | local Plugins manager; Community Hub with payload Preview for non-package entries | parity | — |
| Plugin authoring and proposal review | `plugins/proposals.ts`, `tools/defaultSkills.ts` | `plugin_propose`, `plugins.proposals.*` | `/plugins` Proposals tab: preview, accept or reject | structured model tool and skill; review UI not implemented | partial; App review pending | PAR-017 |
| Connected apps (MCP) | `mcp/` | `connections.*`, broker tools | resource browser Connections tab | Connections | parity | — |
| Web search and page reading | `web/` | `web_search`, `web_fetch` | world tools | world tools | parity | — |
| Isolated browser | `browser/` | shared `browser_*` schemas | isolated world tools, headed on request, `/settings` Browser tab | native WebKit: navigate, tabs, visible-text read, page screenshot and page scroll without refs; unsupported operations refuse explicitly; live screenshot acceptance pending | partial; native backend gap | PAR-015 |
| Web annotations | `annotations/` (PROP-0017, PROP-0018, PROP-0038, PROP-0048) | `annotations.*`, `annotations.capture.*`, `page_notes_*` | `/annotate:` page (Annotate and All annotations tabs; DevTools app list and launch), `/annotate:notes`, `/annotate:submit`, `/annotate:clear` | website tab Annotate panel (inspector, queue to the focused thread, app windows through `annotations.capture.*`) | App behind PROP-0048 (queue methods removed); native WKWebView gestures unaccepted | PAR-011 |
| Managed worktrees | `worktrees/` (PROP-0016) | `worktrees.*` | `--worktree`, `/worktree`, `xagent worktree` | Solo `/worktree` lists records only; Solo starts sessions in the project folder and has no worktree level | partial | PAR-012 |
| Wiki notes (model tools) | `wiki/`, `tools/` | `wiki_*` | `Terminals.ownTools` registers Wiki-read tools through the session socket; `xagent-wiki` remains a person-facing shell utility | structured Harness tools | implemented on both; acceptance not recertified | PAR-002: acceptance not recertified |
| History and trajectory (model tools) | `history/` | `history_*`, `trajectory_*` | `Terminals.ownTools` registers model tools through the session socket; `/trajectory` shows refusal events and interrupted status reasons or codes; `/history` navigates session branches | structured tools and trajectory views | implemented on both; acceptance not recertified | PAR-002: acceptance not recertified |
| Wiki browsing | `wiki/` | `wiki.*` | none | Wiki | host only | PAR-005 |
| Variants and refinement | `variant/`, `refine/` | `variants.*`, `refine.*` | `/variant` (switch, restore, compare, tag, take components), `/refine [guidance]` with background status and review/adopt, browser Variant tab, `xagent refine` | Harness screen; `/refine` and `/variant` open it | host only | PAR-004 |
| Output trim and budget guard plugins | `plugins/firstParty.ts` | trusted first-party hooks | `firstParty.list` loads enabled hooks in `terminal/piExtension.ts` | structured Harness sessions load enabled hooks | implemented on both; acceptance not recertified | PAR-006: acceptance not recertified |
| Doctor | `doctor/` | `doctor.*` | `/doctor` | diagnostics | parity | — |
| Run inspection | `sessions/runStore.ts` | `runs.*` | `/trajectory`, `/log` | run views, analytics | parity | — |
| Usage analytics | `usage/` (PROP-0042) | `usage.summary`, `usage.sync` | `/usage:`, `/usage:analysis` page (Analysis tab) | not wired | terminal implemented; host planned | PAR-016 |
| Remote control (ADR-0056) | `remote/` | protected `terminal.remoteControl.*`; phone calls through `Terminals.send` and the terminal controller | `/remote-control` (`/rc`) page with link, QR code, devices and pair confirmation; `rc` status-bar group; `--remote-control`; the served phone page | stub: App sessions are not terminal sessions | terminal only | PAR-018 |
| Run details | `context/runDetails.ts` | `context.runDetails`; protected terminal trajectory details | `/context` Run details tab, scoped run selection and links to `/trajectory` | Context Run details tab and links to Trajectory | implemented; acceptance not certified; skill observations cover `skill_load` only and terminal plugin activation is unknown | — |
| Context attribution (PROP-0049) | `context/` | `context.attribution`; protected `terminal.context` | `/context` page with Request and Growth tabs, a four-colour context bar with a free track and a compaction marker, `space` fold, `enter` row text, `g` grouping, `c` compact; the page header reads `18.3%/1M`, and the composer status band carries no context figure | full-width Context page opened from the Context tab with the same four-colour bar and a screen-reader reading of it, composer ring reading the same share | implemented on both; acceptance not recertified | — |
| Provider limits | `usage/limits/` (PROP-0042) | `usage.limits` | `/usage:limit` (current account), `/usage:accounts` (all accounts) | not wired | terminal implemented; host planned | PAR-016 |
| Session catalog (sessions per folder) | `sessions/` saved-history controls; shared catalog not implemented | `sessions.*` controls; no cross-surface catalog method | `/session` selects native Pi histories in the current folder | `/session` reads `bridge.agent.threads(SOLO_ID)`, maps each thread to its project folder, and filters by current effective account; `all` broadens only this App list | planned; catalogs differ | PAR-008 |
| Folder choice and recent folders | project/worktree selection remains surface-specific | launch `cwd`, `--worktree`, `/worktree` | starts in launch folder; explicit worktree commands | Solo sidebar is Project › Session; new sessions use the project's folder, with no folder/worktree level | planned; no shared recent-folder picker | PAR-009 |
| Computer control | `computer/screenshot.ts` defines an opt-in approved-window screenshot contract; `computer/control.ts` is an unregistered interaction adapter, not an authorization boundary | `computer_*` (host tools) | no computer screenshot or interaction backend | macOS bridge (host-backed); its display capture has not adopted the approved-window contract | partial; shared interaction adapter is not integrated | PAR-007 |
| Shared files vault | — | `files_*` (host tools) | none | Files | host only | PAR-007 |

## Plugin command namespaces (ADR-0061)

The approved contract gives plugin-owned extension commands and plugin-owned prompt templates the
same `/<owner-prefix>:<name>` namespace, with no bare plugin aliases. A package may set
`harness.defaultPrompt` to its own template for `/<owner-prefix>:`; built-in defaults remain
supported. Owner-prefix and same-owner route collisions fail closed with owner diagnostics.
Standalone templates, `/skill:<name>`, and core commands and their core aliases remain available.
`commands.list`, terminal completion and dispatch must agree; this documentation change does not
certify implementation or acceptance on either surface.

## Core slash-command surfaces (PROP-0040)

These are the fixed `CORE_COMMANDS` entries. The App column records the current Solo source route,
not a claim that it has passed acceptance. `commands.list`, a handler-completeness test, and source
presence do not certify parity. Each command needs its own acceptance evidence; dynamic
plugin/extension, prompt-template and skill commands are listed by `commands.list` but are not in
this fixed table.

| Command | Terminal surface | App Solo route in source | Acceptance / remaining gap |
|---|---|---|---|
| `/help` | Command list and palette | Searchable command picker; selection fills the composer | Not certified per command |
| `/plan` | Plan request / mode toggle | Plan request; bare form toggles persistent plan mode; model Bash runs read-only (PROP-0043) | Not certified per command |
| `/btw` (`/side`) | Contextual side-question dock | Shared side-question service; bare form dismisses the dock | Not certified per command |
| `/new` | New conversation | Replaces focused tab with a draft; archives its saved session | Not certified per command |
| `/stop` | Interrupt current reply | Stops the focused session's reply | Not certified per command |
| `/session` (`/resume`) | Search/select native saved history in the current folder | Lists App Solo threads by folder and effective account; `all` widens only within that App list | PAR-008: separate catalogs; no native-history path opening; not certified |
| `/history` (`/tree`) | Navigate branches in the current native session | Calls `session.navigate` with stable native entry ID; same-session navigation, optional summary, no fork fallback | Route uses Harness `sessions.navigate`; per-command acceptance pending |
| `/fork` | Fork from a user message | Uses session tree/fork and opens the new session | Not certified per command |
| `/remote-control` (`/rc`) | Pairing link, QR code and devices; phone page served by the harness | Stub notice: remote control runs from an `xagent` terminal session | PAR-018; terminal only |
| `/clone` | Clone the current branch | Uses session clone and opens the copy | Not certified per command |
| `/model` | Choose model | App model picker updates session runtime | Not certified per command |
| `/effort` | Choose reasoning effort | Updates session runtime effort | Not certified per command |
| `/thinking` | Toggle thinking display | Toggles transcript thinking visibility | Not certified per command |
| `/name` | Name the native session | Renames the saved session | Not certified per command |
| `/compact` | Compact current context | Runs Harness compact command | Not certified per command |
| `/copy` | Copy last reply | Copies last reply to the clipboard | Not certified per command |
| `/export` | Export HTML or JSONL | Runs Harness session export; relative paths resolve from the project folder | Not certified per command |
| `/trajectory` | Inspect recorded runs | Opens trajectory view for the requested or latest run | Not certified per command |
| `/reload` | Reload trusted resources and keybindings | Reloads Harness resources and refreshes command discovery | Not certified per command |
| `/accounts` | Accounts page | Opens App Accounts | Not certified per command |
| `/permissions` | Permissions page | Opens App approval settings | Not certified per command |
| `/harness` | Harness resource browser | Opens App Harness screen | Not certified per command |
| `/skills` | Skills browser shortcut | Opens Capability skills | Not certified per command |
| `/connections` | Connections browser | Opens App connectors | Not certified per command |
| `/mcp` | Connections browser shortcut | Opens the same App connectors view | Not certified per command |
| `/tools` | Tools page | Opens Capability tools | Not certified per command |
| `/plugins` | Full-screen local Plugins manager | Opens local Plugins manager | Not certified per command |
| `/hub` | Separate full-screen Community Hub catalog | Opens Community Hub | Not certified per command |
| `/components` | Components browser | Opens App Harness components | Not certified per command |
| `/settings` | Terminal settings | Opens App settings | Not certified per command |
| `/doctor` | Doctor checks, including explicitly confirmed live probes | Runs local readiness checks only | Not certified; App route does not expose live checks |
| `/worktree` | Managed-worktree page and actions | Lists worktrees; Solo has no typed create/status/remove methods wired, and no worktree level | PAR-012; management actions unavailable; not certified |
| `/subagents` | Live monitor and roster with the `main` row, restored on reopen | Opens latest run's trajectory, not a dedicated subagent roster | Not certified; surfaces differ |
| `/agents` | Browse/create/edit/copy/delete profiles | Lists profiles only; detail/create/remove methods are not wired into Solo | PAR-010; management actions unavailable; not certified |
| `/log` | Harness diagnostics and current run events | Opens latest run's trajectory, not a separate log reader | Not certified; surfaces differ |
| `/hotkeys` | Keyboard controls | Opens App shortcut settings | Not certified per command |
| `/quit` | Restore terminal and exit | Closes the focused Solo tab; does not exit the App | Not certified per command |

The terminal-only display amendments [PROP-0026](architecture/proposals/PROP-0026-connected-sketch-display.md)
and [PROP-0028](architecture/proposals/PROP-0028-normalize-question-wireframes.md) permit connected
structural glyphs, frame-attached standalone dividers, and high-confidence boundary normalization
through whitespace while retaining literal ASCII persistence and unchanged answers. The App may
keep its literal preview. This does not reopen the expanded metadata contract verified under
PAR-013. Isolated production PTY evidence verifies bounded fixture topology, not every emulator/font
or live-model sketch quality.

## Gaps

| ID | Gap | Planned change |
|---|---|---|
| PAR-018 | Remote control from the App | `/remote-control` drives an `xagent` terminal session from a phone (page 15). App sessions are structured runs, not terminal sessions; the App would need the same pairing over its own session controls, or to present a terminal session's remote control. |
| PAR-017 | Plugin proposal review surfaces | The terminal provides hash-bound review in `/plugins`; the App has no proposal review UI yet. |
| PAR-001 | Todo list not rendered inline in the App | Both surfaces can show the current list: the terminal renders each write as a todo block and `/todo` shows a snapshot; the App's `/todo` shows a read-only list. The App still does not draw an inline block for each write. |
| PAR-002 | Acceptance of terminal-model History/Wiki/skill tools | Source gap resolved: `Terminals.ownTools` registers History/trajectory, Wiki-read and skill tools over the session socket; `xagent-wiki` is a user-facing shell utility, not the model's only route. Acceptance has not been recertified in this documentation pass. |
| PAR-003 | Continuation unused | `/resume` lists interrupted runs and continues one with `continueFrom`; the App offers Continue. |
| PAR-004 | Replaying a turn and switching a conversation's version only in the terminal | The terminal has `/refine` (replay, guidance, review, adopt) and `/variant` (PROP-0052). The App's Harness screen lacks replaying an App turn, guidance, tags, per-component revert and switching an open conversation to another version. |
| PAR-005 | Wiki browsing only in the App | A `/wiki` page over `wiki.*`. |
| PAR-006 | Acceptance of terminal first-party hooks | Source gap resolved: enabled hooks are returned by protected `firstParty.list` and loaded by `terminal/piExtension.ts`. Acceptance has not been recertified in this documentation pass. |
| PAR-007 | Host tools without a complete Harness surface | The opt-in screenshot contract and unregistered interaction adapter exist, but terminal availability reporting, per-action authorization and a conforming backend are not wired. The current macOS host captures a display, not an isolated approved window, and uses global input. Terminal socket execution and native input delivery require a verified authorization boundary before control tools can be exposed. The remaining computer controls are host-owned; the files vault becomes a Harness capability or is dropped. |
| PAR-008 | Separate session catalogs | Proposal approved; shared catalog is not implemented. Terminal `/session` selects native Pi history in the current folder. App `/session` reads Solo `agent.threads`, maps threads through Solo project groups, and filters to the current effective account and folder; `/session all` broadens only within that App catalog. It cannot open an arbitrary native session path. No cross-surface catalog or visibility guarantee exists. |
| PAR-009 | Shared folder/recent-project choice | Terminal starts from its launch `cwd` and can switch through its worktree surface. App Solo uses Project › Session and starts new sessions in the selected project's folder; it has no folder/worktree level or shared recent-folder picker. |
| PAR-010 | Agent profile management in Solo | App Solo `/agents` can list profiles. Although the renderer allowlist includes `agents.get`, Solo does not wrap it; `agents.create/remove` are not exposed there. Profile details and management actions are unavailable, unlike terminal `/agents`. |
| PAR-011 | Web annotations | Harness, terminal and App source done (PROP-0017, PROP-0018, 2026-10-24): the App calls `annotations.*`, imports its old notes once, uses the `page_notes_*` tools, and has the Annotate panel. Open: acceptance of the inspector and selection gestures in the running App's WKWebView. PROP-0038 (2026-10-25): both front ends share the page helper, so open shadow roots work in the terminal's capture browser and the App's tabs alike; composed text capture, save, resolve and reveal were exercised in an isolated App WKWebView, inspector clicks were not. PROP-0048 (2026-10-27): Harness and terminal moved to pending/sent with two popover actions, send-all with an optional request, clear, read-only page-note tools, and DevTools app discovery and launch; the App's Annotate panel still uses the removed queue methods and must follow. |
| PAR-012 | Managed worktree management in Solo | Harness and terminal provide full worktree operations (PROP-0016). Solo `/worktree` lists records only: its renderer adapter does not wire typed `worktrees.create`, `status` or `remove` calls, and Solo session creation stays at the project folder with no worktree level. Handoff, branch, prune, restore and setup-trust actions are also absent from this Solo surface. |
| PAR-013 | Expanded question wireframes and terminal layout | Closed by [PROP-0025 verification](evidence/terminal-question-wireframes/README.md): four-size production PTY acceptance covers aligned compact columns, body scrolling, pinned controls, Shift+arrow sketch panning and live resizing. Host contracts accept 80×24 literal ASCII sketches (1,943 bytes); six isolated browser tests include exact-boundary content, accessible overflow and unchanged selection/answers. This is controlled fixture acceptance, not live-provider or native Tauri evidence. |
| PAR-014 | Connected terminal sketch display | Closed by [PROP-0026 verification](evidence/terminal-connected-sketches/README.md) and extended by [PROP-0028 verification](evidence/terminal-wireframe-normalization/README.md): production PTY fixtures cover connected corners/tees, title-bearing rules, missing and whitespace-shifted side edges, internal table widths, frame-attached dividers, resize/panning and unchanged raw persistence/answers. Harness and host checks passed. Host literal rendering remains permitted; no host implementation change was required. This is fixture verification, not an every-font or live-model guarantee. |
| PAR-016 | Usage analytics and provider limits in the App | The terminal has `/usage:analysis` and `/usage:limit` over `usage.*`. The App presents the same capability: an analytics view and a per-account provider limit view. |
| PAR-015 | Native WebKit browser-tool coverage | The shared browser schema is wider than the native backend. Native WebKit supports navigation, tabs, visible-text reads, page screenshots and scrolling without refs; live screenshot acceptance is pending. Accessibility snapshots, snapshot-ref interactions (including click/type/select/ref-scroll/ref-screenshot), waits and keyboard presses return an explicit `browser_unsupported` refusal before effects; there is no automatic switch to the isolated Harness browser. See page 13 and the native backend's `surfaces` note. |
