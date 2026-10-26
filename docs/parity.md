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
| Plan mode | `sessions/planMode.ts` | `plan: true` | `/plan`, Shift+Tab, plan card; bounded plan/checklist context is restored after compaction | plan request, PlanCard; shared Harness checkpoint behavior | parity | — |
| Capability discovery | `tools/getCapabilities.ts` | read-only `get_capabilities` | terminal extension reports Pi's active tools and schemas; shared plan allowlist includes it | structured Harness run uses the same tool; no duplicate App-owned tool | implemented; acceptance not recertified | — |
| Bash command mode | `sessions/sessions.ts`, `sessions/initialBash.ts` | `initialBashCommand`; Bash `workspaceWriteScope` | `!command` defaults to workspace; `!outside command` asks before running once | same `!command` and `!outside command` composer semantics | parity | — |
| Workspace-scoped writes | `core/workspace.ts`, `sessions/workspaceBoundary.ts`, `core/workspaceBashTool.ts`, `core/workspaceSandbox.ts`, `core/workspaceWriteOperations.ts` | pinned non-root `RunRecord.workspaceRoot`; native `edit`/`write`; Bash scope | revalidated atomic native writes; external-hard-link scan and Bash sandbox; complete escaped outside command in scrollable approval details (deny if too small); no output-triggered retry | same Harness gate and full approval action in scrollable App details; App policy can tighten scope; Full Permission remains the eligible explicit bypass | parity | — |
| Side questions | `sessions/sideQuestions.ts` | `sideQuestions.start/read/interrupt`; terminal `terminal.sideQuestions.*` | `/btw` contextual dock with scroll and copy | side-question dock through the shared service | parity | — |
| Approvals and standing approvals | `sessions/approvals.ts` | `approvals.*` | decision dock, `/permissions` | approvals dock, settings | parity | — |
| Questions (`ask_user`) | `tools/askUser.ts` | shared `ask_user` tool | plan-mode dock: strict aligned columns, bounded body scroll, 80×24 source sketch viewport; connected structural projection with high-confidence boundary normalization (PROP-0026, PROP-0028) | plan-mode form accepts the same 80×24 ASCII source contract with literal preview and accessible overflow; no typography change required | parity; terminal projection verified in isolated fixtures | — |
| Subagents | `sessions/subagentService.ts` | `spawn_subagent` (requires `title`, PROP-0030), `subagents.*`; plan mode allows only named eligible read-only research profiles | `/subagents` page and live rows under the status line (mark, profile, parent-set title, `n of m tasks`); plan-mode research delegation uses the same Harness gate | reply trajectory; plan-mode research delegation uses the same Harness gate | parity | — |
| Agent profiles | `agents/profiles.ts` | `spawn_subagent { agent }`, `agents.list/get/create/remove`; terminal `terminal.agents.*` | `/agents` page: browse, create, edit in `$EDITOR`, copy, delete | Solo `/agents` lists profiles; profile details and management are not wired | partial | PAR-010 |
| Run checklist | `tools/checklist.ts` | `checklist_write`, `runs.checklist`; terminal `checklist` telemetry | registered in terminal sessions and their subagents; each write shows as a checklist block in the transcript; a subagent row shows its `n of m tasks` | not shown | terminal done; App planned | PAR-001 |
| Continuation of a stopped run | `sessions/continuation.ts` | `continueFrom`, `runs.continuation` | not offered (`/resume` reopens history only) | not offered | planned | PAR-003 |
| Bounded replies and checkpoints (PROP-0041) | `sessions/workSlice.ts`, `tools/checkpoint.ts`, `sessions/runner.ts` | `checkpoint_write`, `workSlice`, `runs.continuation.checkpoint`, `checkpoint`/`heartbeat` events | guard on every terminal reply with the shared tool; the handoff is recorded on the run; no checkpoint card or slice control yet | not wired | implemented; terminal card, App presentation and `/slices` open | PAR-004 |
| Accounts | `accounts/` | `accounts.*` | `/accounts` | Accounts | parity | — |
| Models and effort | `accounts/choices.ts` | — | `/model`, `/effort` | composer pickers | parity | — |
| Skills | `plugins/`, `tools/dispatch.ts` | `skill_load` | `$name`, `/skill:name`, browser Skills tab | Capability, composer | parity | — |
| Plugins and Hub | `plugins/`, `hub/` | `plugins.*`, `hub.*` | resource browser | Capability | parity | — |
| Connected apps (MCP) | `mcp/` | `connections.*`, broker tools | resource browser Connections tab | Connections | parity | — |
| Web search and page reading | `web/` | `web_search`, `web_fetch` | world tools | world tools | parity | — |
| Isolated browser | `browser/` | shared `browser_*` schemas | isolated world tools, headed on request, `/settings` Browser tab | native WebKit: navigate, tabs, visible-text read and page scroll without refs; unsupported operations refuse explicitly | partial; native backend gap | PAR-015 |
| Web annotations | `annotations/` (PROP-0017, PROP-0018, PROP-0038) | `annotations.*`, `annotations.capture.*`, `page_notes_*` | `/annotate:` pane (also `/annotate:annotate`), `/annotate:notes` saved list | website tab Annotate panel (inspector, queue to the focused thread, app windows through `annotations.capture.*`) | parity in the working tree; native WKWebView gestures unaccepted | PAR-011 |
| Managed worktrees | `worktrees/` (PROP-0016) | `worktrees.*` | `--worktree`, `/worktree`, `xagent worktree` | Solo `/worktree` lists records only; Solo starts sessions in the project folder and has no worktree level | partial | PAR-012 |
| Wiki notes (model tools) | `wiki/`, `tools/` | `wiki_*` | `Terminals.ownTools` registers Wiki-read tools through the session socket; `xagent-wiki` remains a person-facing shell utility | structured Harness tools | implemented on both; acceptance not recertified | PAR-002: acceptance not recertified |
| History and trajectory (model tools) | `history/` | `history_*`, `trajectory_*` | `Terminals.ownTools` registers model tools through the session socket; `/trajectory` page; `/history` navigates session branches | structured tools and trajectory views | implemented on both; acceptance not recertified | PAR-002: acceptance not recertified |
| Wiki browsing | `wiki/` | `wiki.*` | none | Wiki | host only | PAR-005 |
| Variants and refinement | `variant/`, `refine/` | `harnesses.*`, `refine.*` | browser Variant tab (read-only), `xagent refine` | Harness screen | host only | PAR-004 |
| Output trim and budget guard plugins | `plugins/firstParty.ts` | trusted first-party hooks | `firstParty.list` loads enabled hooks in `terminal/piExtension.ts` | structured Harness sessions load enabled hooks | implemented on both; acceptance not recertified | PAR-006: acceptance not recertified |
| Doctor | `doctor/` | `doctor.*` | `/doctor` | diagnostics | parity | — |
| Run inspection | `sessions/runStore.ts` | `runs.*` | `/trajectory`, `/log` | run views, analytics | parity | — |
| Usage analytics | `usage/` (PROP-0042) | `usage.summary`, `usage.sync` | `/usage:`, `/usage:analysis` page (Analysis tab) | not wired | terminal implemented; host planned | PAR-016 |
| Provider limits | `usage/limits/` (PROP-0042) | `usage.limits` | `/usage:limit` page (Limits tab) | not wired | terminal implemented; host planned | PAR-016 |
| Session catalog (sessions per folder) | `sessions/` saved-history controls; shared catalog not implemented | `sessions.*` controls; no cross-surface catalog method | `/session` selects native Pi histories in the current folder | `/session` reads `bridge.agent.threads(SOLO_ID)`, maps each thread to its project folder, and filters by current effective account; `all` broadens only this App list | planned; catalogs differ | PAR-008 |
| Folder choice and recent folders | project/worktree selection remains surface-specific | launch `cwd`, `--worktree`, `/worktree` | starts in launch folder; explicit worktree commands | Solo sidebar is Project › Session; new sessions use the project's folder, with no folder/worktree level | planned; no shared recent-folder picker | PAR-009 |
| Computer control | — | `computer_*` (host tools) | unavailable, with reason | macOS bridge (host-backed) | host-backed | PAR-007 |
| Shared files vault | — | `files_*` (host tools) | none | Files | host only | PAR-007 |

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
| `/plugins` | Plugins page | Opens Capability plugins | Not certified per command |
| `/hub` | Hub browser | Opens Capability Hub | Not certified per command |
| `/components` | Components browser | Opens App Harness components | Not certified per command |
| `/settings` | Terminal settings | Opens App settings | Not certified per command |
| `/doctor` | Doctor checks, including explicitly confirmed live probes | Runs local readiness checks only | Not certified; App route does not expose live checks |
| `/worktree` | Managed-worktree page and actions | Lists worktrees; Solo has no typed create/status/remove methods wired, and no worktree level | PAR-012; management actions unavailable; not certified |
| `/subagents` | Live monitor and roster | Opens latest run's trajectory, not a dedicated subagent roster | Not certified; surfaces differ |
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
| PAR-001 | Checklist absent from the App | The terminal registers the tool and renders a checklist block; the App renders it too. |
| PAR-002 | Acceptance of terminal-model History/Wiki/skill tools | Source gap resolved: `Terminals.ownTools` registers History/trajectory, Wiki-read and skill tools over the session socket; `xagent-wiki` is a user-facing shell utility, not the model's only route. Acceptance has not been recertified in this documentation pass. |
| PAR-003 | Continuation unused | `/resume` lists interrupted runs and continues one with `continueFrom`; the App offers Continue. |
| PAR-004 | Refinement and adoption only in the App | Variant tab actions: start, candidates, adopt, trust. |
| PAR-005 | Wiki browsing only in the App | A `/wiki` page over `wiki.*`. |
| PAR-006 | Acceptance of terminal first-party hooks | Source gap resolved: enabled hooks are returned by protected `firstParty.list` and loaded by `terminal/piExtension.ts`. Acceptance has not been recertified in this documentation pass. |
| PAR-007 | Host tools without a Harness owner | Decide each: computer control stays host-backed (terminal shows unavailable); the files vault becomes a Harness capability or is dropped. |
| PAR-008 | Separate session catalogs | Proposal approved; shared catalog is not implemented. Terminal `/session` selects native Pi history in the current folder. App `/session` reads Solo `agent.threads`, maps threads through Solo project groups, and filters to the current effective account and folder; `/session all` broadens only within that App catalog. It cannot open an arbitrary native session path. No cross-surface catalog or visibility guarantee exists. |
| PAR-009 | Shared folder/recent-project choice | Terminal starts from its launch `cwd` and can switch through its worktree surface. App Solo uses Project › Session and starts new sessions in the selected project's folder; it has no folder/worktree level or shared recent-folder picker. |
| PAR-010 | Agent profile management in Solo | App Solo `/agents` can list profiles. Although the renderer allowlist includes `agents.get`, Solo does not wrap it; `agents.create/remove` are not exposed there. Profile details and management actions are unavailable, unlike terminal `/agents`. |
| PAR-011 | Web annotations | Harness, terminal and App source done (PROP-0017, PROP-0018, 2026-10-24): the App calls `annotations.*`, imports its old notes once, uses the `page_notes_*` tools, and has the Annotate panel. Open: acceptance of the inspector and selection gestures in the running App's WKWebView. PROP-0038 (2026-10-25): both front ends share the page helper, so open shadow roots work in the terminal's capture browser and the App's tabs alike; composed text capture, save, resolve and reveal were exercised in an isolated App WKWebView, inspector clicks were not. |
| PAR-012 | Managed worktree management in Solo | Harness and terminal provide full worktree operations (PROP-0016). Solo `/worktree` lists records only: its renderer adapter does not wire typed `worktrees.create`, `status` or `remove` calls, and Solo session creation stays at the project folder with no worktree level. Handoff, branch, prune, restore and setup-trust actions are also absent from this Solo surface. |
| PAR-013 | Expanded question wireframes and terminal layout | Closed by [PROP-0025 verification](evidence/terminal-question-wireframes/README.md): four-size production PTY acceptance covers aligned compact columns, body scrolling, pinned controls, Shift+arrow sketch panning and live resizing. Host contracts accept 80×24 literal ASCII sketches (1,943 bytes); six isolated browser tests include exact-boundary content, accessible overflow and unchanged selection/answers. This is controlled fixture acceptance, not live-provider or native Tauri evidence. |
| PAR-014 | Connected terminal sketch display | Closed by [PROP-0026 verification](evidence/terminal-connected-sketches/README.md) and extended by [PROP-0028 verification](evidence/terminal-wireframe-normalization/README.md): production PTY fixtures cover connected corners/tees, title-bearing rules, missing and whitespace-shifted side edges, internal table widths, frame-attached dividers, resize/panning and unchanged raw persistence/answers. Harness and host checks passed. Host literal rendering remains permitted; no host implementation change was required. This is fixture verification, not an every-font or live-model guarantee. |
| PAR-016 | Usage analytics and provider limits in the App | The terminal has `/usage:analysis` and `/usage:limit` over `usage.*`. The App presents the same capability: an analytics view and a per-account provider limit view. |
| PAR-015 | Native WebKit browser-tool coverage | The shared browser schema is wider than the native backend. Native WebKit supports navigation, tabs, visible-text reads and scrolling without refs. Accessibility snapshots, snapshot-ref interactions (including click/type/select/ref-scroll), browser screenshots, waits and keyboard presses return an explicit `browser_unsupported` refusal before effects; there is no automatic switch to the isolated Harness browser. See page 13 and the native backend's `surfaces` note. |
