# Capability parity register

**Status:** descriptive register, as of 2026-10-23. The binding rules are
[14 Surfaces and parity](architecture/14-surfaces-and-parity.md) (`INV-PAR-1`–`INV-PAR-4`).

Every capability a person can use is a Harness capability. The standalone terminal (`xharness`)
is the reference front end; a host such as the App presents the same capabilities with a richer
UI. This page lists each capability, where the Harness owns it, how each front end shows it, and
whether both pass. A gap has an ID (`PAR-NNN`) until it is closed.

Host-only surfaces (presentation a terminal cannot show, `INV-PAR-4`) are not listed here; each
host keeps its own register. The App's is
[`App/docs/architecture/app-only-surfaces.md`](../../App/docs/architecture/app-only-surfaces.md).

Status: **parity** (both surfaces pass), **terminal only**, **host only** (a gap), **planned**,
**host-backed** (needs a host object; terminal fallback named).

## Register

| Capability | Harness owner | Method or tool | Terminal surface | App surface | Status | Gap |
|---|---|---|---|---|---|---|
| Sessions and turns | `sessions/` | `sessions.run`, `terminal.*` | the terminal itself | Solo chat | parity | — |
| Plan mode | `sessions/planMode.ts` | `plan: true` | `/plan`, Shift+Tab, plan card | plan request, PlanCard | parity | — |
| Bash command mode | `sessions/sessions.ts` | `initialBashCommand` | `!command` | `!command` in the composer | parity | — |
| Side questions | `terminal/tui/sideQuestion.ts` | — | `/btw` | side-question dock | parity | — |
| Approvals and standing approvals | `sessions/approvals.ts` | `approvals.*` | decision dock, `/permissions` | approvals dock, settings | parity | — |
| Questions (`ask_user`) | `tools/askUser.ts` | `ask_user` | question dock | question form | parity | — |
| Subagents | `sessions/subagentService.ts` | `spawn_subagent`, `subagents.*` | `/plugin:subagents` page and compact live activity widget | reply trajectory | parity | — |
| Run checklist | `tools/checklist.ts` | `checklist_write`, `runs.checklist` | not registered in terminal sessions | not shown | planned | PAR-001 |
| Continuation of a stopped run | `sessions/continuation.ts` | `continueFrom`, `runs.continuation` | not offered (`/resume` reopens history only) | not offered | planned | PAR-003 |
| Accounts | `accounts/` | `accounts.*` | `/accounts` | Accounts | parity | — |
| Models and effort | `accounts/choices.ts` | — | `/model`, `/effort` | composer pickers | parity | — |
| Skills | `plugins/`, `tools/dispatch.ts` | `skill_load` | `$name`, `/skill:name`, browser Skills tab | Capability, composer | parity | — |
| Plugins and Hub | `plugins/`, `hub/` | `plugins.*`, `hub.*` | resource browser | Capability | parity | — |
| Connected apps (MCP) | `mcp/` | `connections.*`, broker tools | resource browser Connections tab | Connections | parity | — |
| Web search and page reading | `web/` | `web_search`, `web_fetch` | world tools | world tools | parity | — |
| Isolated browser | `browser/` | `browser_*` | world tools, headed on request, `/settings` Browser tab | App WebKit tabs (host-backed) | host-backed | — |
| Page annotations | `annotations/` (PROP-0017, PROP-0018) | `annotations.*`, `annotations.capture.*`, `page_notes_*` | `/plugin:annotate` pane (inspector, queue, app windows over DevTools or the page bridge), `/plugin:notes` | website tab Annotate panel (inspector, queue to the focused thread, app windows through `annotations.capture.*`) | parity in the working tree; native WKWebView gestures unaccepted | PAR-011 |
| Managed worktrees | `worktrees/` (PROP-0016) | `worktrees.*` | `--worktree`, `/plugin:worktree`, `xharness worktree` | working group **Create worktree** (`worktrees.create`) | partial | PAR-012 |
| Wiki notes (model tools) | `wiki/`, `tools/` | `wiki_*` | `xagent-wiki` shell command only | tools | host only | PAR-002 |
| History and trajectory (model tools) | `history/` | `history_*`, `trajectory_*` | shell command, `/plugin:trajectory` page | tools, trajectory views | host only | PAR-002 |
| Wiki browsing | `wiki/` | `wiki.*` | none | Wiki | host only | PAR-005 |
| Variants and refinement | `variant/`, `refine/` | `harnesses.*`, `refine.*` | browser Variant tab (read-only), `xharness refine` | Harness screen | host only | PAR-004 |
| Output trim and budget guard plugins | `plugins/firstParty.ts` | — | not loaded in terminals | loaded | host only | PAR-006 |
| Doctor | `doctor/` | `doctor.*` | `/plugin:doctor` | diagnostics | parity | — |
| Run inspection | `sessions/runStore.ts` | `runs.*` | `/plugin:trajectory`, `/log` | run views, analytics | parity | — |
| Session catalog (sessions per folder) | — | — | per-folder history | Solo thread list | planned | PAR-008 |
| Folder choice and recent folders | `core/projects.ts` | — | launch folder only | working groups | planned | PAR-009 |
| Computer control | — | `computer_*` (host tools) | unavailable, with reason | macOS bridge (host-backed) | host-backed | PAR-007 |
| Shared files vault | — | `files_*` (host tools) | none | Files | host only | PAR-007 |

## Gaps

| ID | Gap | Planned change |
|---|---|---|
| PAR-001 | Checklist absent from the terminal and the App | Add the checklist tool to terminal sessions and render a checklist block; the App renders it too. |
| PAR-002 | Wiki, history and trajectory reach terminal models only through a shell command | Register the harness tools in terminal sessions; retire the shell commands (drift D-4). |
| PAR-003 | Continuation unused | `/resume` lists interrupted runs and continues one with `continueFrom`; the App offers Continue. |
| PAR-004 | Refinement and adoption only in the App | Variant tab actions: start, candidates, adopt, trust. |
| PAR-005 | Wiki browsing only in the App | A `/wiki` page over `wiki.*`. |
| PAR-006 | First-party hook plugins not loaded in terminals | Load them through the terminal's trusted selection. |
| PAR-007 | Host tools without a Harness owner | Decide each: computer control stays host-backed (terminal shows unavailable); the files vault becomes a Harness capability or is dropped. |
| PAR-008 | Separate session catalogs | A Harness session catalog per folder, read by both front ends (needs a proposal). |
| PAR-009 | Folder choice | Built on PAR-008: recent folders in both front ends. |
| PAR-011 | Page annotations | Harness, terminal and App source done (PROP-0017, PROP-0018, 2026-10-24): the App calls `annotations.*`, imports its old notes once, uses the `page_notes_*` tools, and has the Annotate panel. Open: acceptance of the inspector and selection gestures in the running App's WKWebView. |
| PAR-012 | Managed worktrees | Harness and terminal done (PROP-0016). The App creates through `worktrees.create`; its groups do not yet offer hand off, prune, restore or managed worktrees per thread. |
