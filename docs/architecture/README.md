# Harness architecture specification

**Status:** binding. **As of:** 2026-10-27, checked against `src/` on branch `release/1.0.0`.

This folder is the core specification of `@xingular/harness`. Code must conform to it. A change
that alters what it says must update the affected pages in the same change (see
[Changing the architecture](#changing-the-architecture)). Proposals are optional design records,
not prerequisites or approval gates.

Other documents explain and record; this folder decides. Where another document disagrees with a
page here, this page wins, and the disagreement is listed under [Known drift](#known-drift).

## How to read it

Each page describes one part of the harness in the same order:

1. **Purpose** — what the part is for, in one paragraph.
2. **Components** — the modules and their main types.
3. **Contracts** — the public API, server methods and file formats other code relies on.
4. **Invariants** — numbered rules (`INV-<AREA>-<n>`). Cite them by ID in reviews and proposals.
5. **Data** — what the part stores, and where.
6. **Source map** — the files that implement it.

Types named in a page are declarations in `src/`. Where a page describes a logical role that is
not one class (a set of functions in one module, say), it says so.

## Pages

| Page | Covers | Invariant prefix |
|---|---|---|
| [00 Overview](00-overview.md) | What the harness is, the foundation/variant split, layers, module map, ETCLOVG ownership | `INV-BND` |
| [01 Extension points](01-extension-points.md) | The seven surfaces an application extends the harness through | `INV-EXT` |
| [02 Sessions and runs](02-sessions-and-runs.md) | A session turn, run records and events, approvals, questions, subagents, plan mode, usage | `INV-RUN` |
| [03 Variants](03-variants.md) | The eight components, validation, versions, pinning, plugin-code trust; the rule that only a variant mutates | `INV-VAR`, `INV-FND` |
| [04 Prompt](04-prompt.md) | The compiler, the stable prefix, context updates | `INV-PRM` |
| [05 Refinement](05-refinement.md) | Propose–Probe–Compose, evidence, budget, selection, the experience library | `INV-REF` |
| [06 Plugins and capabilities](06-plugins-and-capabilities.md) | What a session loads, attachments, hooks, capability sets | `INV-PLG`, `INV-CAP` |
| [07 Tools and the gate](07-tools-and-gate.md) | The harness's own tools, tool providers, the per-call gate, standing approvals | `INV-GATE` |
| [08 Memory and history](08-memory-and-history.md) | Wiki notes, recall, trajectories, the rebuildable index | `INV-MEM` |
| [09 Accounts and connectors](09-accounts-and-connectors.md) | Isolated accounts, secrets, connected apps (MCP), the Hub | `INV-ACC`, `INV-MCP` |
| [10 Server protocol](10-server-protocol.md) | The newline-delimited JSON protocol and the method table | `INV-SRV` |
| [11 Terminal](11-terminal.md) | The Harness-owned terminal frontend and its process boundary | `INV-TUI` |
| [12 Storage](12-storage.md) | The data root and state directory, and who writes what | `INV-STO` |
| [13 World tools](13-world-tools.md) | Generic web and isolated browser backends, host boundary and diagnostics | — |
| [14 Surfaces and parity](14-surfaces-and-parity.md) | Every capability is a Harness capability with a terminal surface; host-backed capabilities; host-only surfaces | `INV-PAR` |
| [15 Remote control](15-remote-control.md) | Continuing a terminal session from a phone or iPad: pairing, sealed frames, the bind policy | `INV-RC` |
| [Proposals](proposals/README.md) | Architecture change proposals and their status | — |

Related records, not binding by themselves:

- [`../terminal-tui.md`](../terminal-tui.md): terminal detail and verification evidence. Page 11
  states which parts of it are binding.
- [`../system-prompt-design.md`](../system-prompt-design.md): a draft prompt design (DESIGN-0001).
  Only what page 04 states is binding.
- [`../decisions/`](../decisions/): accepted decisions (ADRs). Each binding consequence of an
  accepted ADR is stated on a page here.
- [`../../README.md`](../../README.md): the embedding guide for application authors.
- [`../../../App/docs/architecture/overview.md`](../../../App/docs/architecture/overview.md): the
  application side of the boundary.

## Glossary

These words are used the same way across architecture pages and, for implemented concepts, in code
and the data layout. Terms marked as planned are future vocabulary only; they do not describe
current behavior.

| Word | Meaning |
|---|---|
| **Foundation** | The fixed half of the harness: code and invariants that no edit, improver or adoption can change. Changes by release; contract changes update the specification and may use an optional proposal as a design record. |
| **Agent Mode** | A planned foundation-level work style, with at most one mode active at a time. Plugins remain independently stackable contributions. This is distinct from plan mode and existing `mode` fields; it is not a runtime contract ([FW-0001](../future-work.md#fw-0001-agent-modes-starting-with-router-agent-mode)). |
| **Variant** | The mutating half: one tree of eight components (c1–c8) for one scope. Formerly "harness tree". |
| **Component** | One of c1–c8 inside a variant (system prompt, guardrails, memory, tool guidance, subagents, skills, scripts, plugins). |
| **Surface** | The foundation's definition of what a variant may contain (`PI_SURFACE`): paths, patterns, the always-on cap. |
| **Scope** | The opaque id a variant belongs to. The application decides what it stands for. |
| **Version** | A recorded variant: immutable, validated, named by its fingerprint. |
| **Head** | A scope's current variant: the version a new run pins. |
| **Lineage** | The parent chain of a scope's versions. |
| **Candidate** | A variant that refinement proposed and a person has not adopted. |
| **Adopt** | A person's act of committing a candidate as the head. The only way refinement's output reaches a run. |
| **Trust** | A person's approval of the exact text of a variant's plugin code (c8), by hash. |
| **Run** | One session turn on a pinned variant, recorded by the foundation. |

## Changing the architecture

Every coding agent and contributor follows these steps.

1. **Read first.** Before changing code, read the pages for the modules you touch.
2. **Within the spec: just do it.** If the change fits every contract and invariant, make it. If it
   adds detail without changing a rule (a new server method in an existing group, a new optional
   field), update the page in the same commit.
3. **Outside the spec: implement and update.** If the change alters a contract, an invariant, a
   layer boundary, an extension point, or the storage layout, implement the requested change and
   update affected pages in the same change. A proposal may document the design, but is optional
   and does not gate implementation.
4. **Record lasting decisions.** Add an ADR in `../decisions/` when the choice is a lasting one.
   Proposals may be added to the index when useful; no `Accepted` status is required before work.
5. **Drift is reported, not fixed silently.** If code and a page already disagree, add the item to
   [Known drift](#known-drift) and tell the user. When resolving drift within the requested scope,
   update the code and spec together and record the rationale; do not silently change unrelated
   behavior.

When unsure whether a change alters the architecture, read the affected pages and update them in
the same change. Use a proposal only when it helps explain the design.

## Known drift

Disagreements found while writing this specification. Record their evidence here and report them;
resolve relevant drift by updating the implementation and specification together in the same change.

| ID | Where | What disagrees |
|---|---|---|
| D-34 | The agent's shell commands in a daemon window, `terminal/terminals.ts` (Pi's bash tool) | A window's own harness runs the agent's shell commands with the window's environment. In the long-lived harness they run with the environment of the process that started it (PATH, virtualenv, `SSH_AUTH_SOCK`, proxies), because Pi's bash tool takes `process.env` and the harness builds no per-session spawn hook (Pi offers `BashSpawnHook`). The window's credential variables are removed from its frontend; MCP stdio servers and plugins keep the daemon's environment. Mitigation: `--no-daemon`, or `xagent daemon stop` before work in a different environment. Fix: a per-session environment snapshot in `terminal.prepare`, applied through `BashSpawnHook`. |
| D-33 | The long-lived harness as the default — resolved 2026-11-05 | ADR-0085 made it the default for the terminal and the App's sidecar, with fallbacks, kill switches and the Windows exclusion. Still not tested: a hung plugin in the daemon, and a day of use with several windows and the App (the person's soak). |
| D-32 | Ordered and nested list wrapping, `opentui/markdown.ts` (`alignListItems`) | The transcript renderer was written to keep a list item's wrapped lines beneath its text (nested lists and ordered markers wider than one digit). A general OpenTUI `renderNode` drops the blank rows between paragraphs and headings, so the renderer is code-block-only (`codeBlockOnly`) and lists no longer reach `alignListItems`: they wrap as in the previous release, continuation rows at column 4 where 7 was wanted. The verifier no longer checks it. Open; needs either structured lists with the block spacing restored, or OpenTUI support for both. |
| D-31 | `scripts/verify-terminal.py --markdown-only` — resolved 2026-11-04 | The fixture sent 100 list items and its checks read the 40 visible rows. It now sends three short lists (starting at 1, 10 and 100) on a 120x72 screen. The suite also found the blank rows between paragraphs and headings missing with the new renderer, which is why that renderer is now code-block-only (D-32). |
| D-30 | `scripts/verify-terminal.py` focused suites — resolved 2026-11-04 | The `browser`, `palette`, `accounts` and `trajectory` suites asserted layouts the terminal no longer draws; the product was right. Browser: the skill's description wraps in the 40-column completion column ("Inspect a" / "browser fixture."). Palette: command names carry their owner (ADR-0061) and wrap, and a narrow palette shows three lines per row. Accounts at 120x40: the search field holds the typed text, so its placeholder is not shown. Trajectory at 120x40: a wide event row shows its summary, not the event type. The script now reads the name column down its rows, matches wrapped text and compares columns. |
| D-29 | `scripts/verify-terminal.py`, approval titles — resolved 2026-11-03 | The script expected `Approve ask_user?` and `Approve workspace-write?`; the terminal titles dialogs with display names (`AskUser`, `WorkspaceWrite`), and a harness run asks `ask_user` questions without an approval. The script now accepts either title, and the question with or without an approval. |
| D-28 | Client terminal record contract — resolved 2026-11-03 | The script asserted that a terminal run's `nativeSessionId` is a history file. Client terminal runs record Pi's session id, as host runs do (page 11, Identity); the script resolves either to the history file, and `/session` takes either. |
| D-27 | Subagent compaction, pages 02 and 04 | A subagent compacted at the context threshold (run `5cd1d8aa`, 2026-11-01) produced a summary whose `## Goal` read "No specific research question or task was provided" while its split-turn section kept the brief. The model that continued still had the task through the turn context, but the summary's headline contradicts it. Not resolved here; the cause (the brief sits in the split part of the turn) is not confirmed. |
| D-26 | App browser tool catalog, pages 13 and 14 (PAR-015) — rechecked with ADR-0082 | Brave mode now supplies all shared Harness browser tools except the App-only upload through `browserToolsForSession` (`agent-app/sidecar/src/app.ts:172-177`, `appTools.ts:91-126`); WebKit still filters unsupported snapshot/ref operations. The Rust `app.capabilities` response remains backend-agnostic (`src-tauri/src/app_tools.rs:111-123`), while its `TOOL_IDS` and shared contract contain the new Browser tools (`shared/contracts.ts:557-562`, `src-tauri/src/agents.rs:90-103`). Thus a connected Brave backend implements the advertised refs, but the capability catalog can still mark WebKit-unsupported tools available. Partly resolved; backend-aware capability reporting remains open. |
| D-25 | Native WebKit interaction, page 13 — rechecked with ADR-0082 | The Brave adapter now uses the shared ref-based definitions, but the App's Rust backend still routes `browser_click`, `browser_type` and the App-only `browser_upload` by CSS `selector` (`agent-app/src-tauri/src/browser_workspace.rs:1493`, `agent-app/shared/appTools.ts:20`). The shared provider refuses those WebKit operations and never maps refs to selectors. Open: extend the contract to selectors or remove the native selector paths. |
| D-24 | Plan instruction delivery, pages 02 and 04 — resolved | The plan instruction exceeded its 4,000-character section budget, and the compaction checkpoint separately clipped it at 4,000 characters, risking loss of outcome rules. Both bounds are increased and covered by delivery tests so the complete current instruction survives compilation and compaction. |
| D-23 | Terminal model-tool caller identity, pages 07 and 08 — resolved | `ownTools` used the session caller without the active run id, so `trajectory_read` with `run: 'current'` failed over `tools.call`. It now derives the caller on each execution and clears the identity after settlement. |
| D-1 | `AGENTS.md` (before this spec), `INV-RUN-6` | The old rule said only `sessions/runStore.ts` writes `runs/<id>/`. In code, four other harness modules also write side files there: `prompt/compile.ts` (`context.json`), `sessions/sessions.ts` (`caller.json`), `capabilities/runSnapshot.ts` (`capabilities.json`), `mcp/service.ts` (`mcp-context.json`). The spec states the rule the code keeps (see `INV-RUN-6`); whether to route all of them through `runStore.ts` is open. |
| D-2 | Plugin proposal review surfaces | `plugin_propose` and hash-bound proposal APIs now exist; a terminal review UI is pending and no App review UI is claimed. See [PAR-017](../parity.md#gaps). |
| D-3 | `README.md` "External curation" | Describes `externalMaintenance`, `vaultAccess`, `MAINTENANCE_PLUGIN`, `maintenance.*` methods and tools. None exist in `src/`. |
| D-4 | `INV-BND-2` | Several names carry an application's name: the context message type `xingular-context`, the approval extension `xagent-approvals`, the MCP client name `xagent`, and the terminal commands `xagent-wiki` / `xagent-mcp`. The default product name `Xingular Agent` is allowed; these are not. |
| D-5 | `INV-BND-2` | `RunRecord` carries `worktreeId` and `handoffId`, which are application concepts. They are stored and returned, never read, and are documented as the application's fields. Since PROP-0016 (2026-10-23) `worktreeId` has Harness meaning when it names a registered worktree; only `handoffId` remains an application field. |
| D-6 | `INV-BND-2` | Plan-mode instructions (`sessions/planMode.ts`) name a managed browser and computer controls, which the harness does not provide. |
| D-7 | `INV-MEM-3` | `wiki/notes.ts::remove` keeps a version but does not call `noteChange`, so hooks hear saves but not removals. |
| D-8 | old `AGENTS.md` | Listed `work` among the sections delivered as updates. The compiler's built-in dynamic sections are only `references` and `wiki`; `work` is dynamic only when the application marks it so. `INV-PRM-3` states the code's rule. |
| D-9 | World/browser implementation | Resolved for the 1.0.0 candidate by PROP-0012/ADR-0014 and page 13: the Harness owns a generic isolated browser; App browser UI, tab sharing and computer integration remain with the host. |
| D-10 | OpenTUI skill completion | At the start of PROP-0013, documentation claimed skill completion, but OpenTUI only rendered slash-command completions. The skill helper had no frontend caller. PROP-0013 explicitly resolves this drift. |
| D-11 | `INV-RUN-5`, unattended approval and question paths | Source inspection on 2026-10-23 found that `SessionRunInput.automatic` disables resource discovery and extension dialogs (`sessions/runner.ts:574`), but the general gate does not receive that flag. `Sessions.gate` explicitly refuses approvals for `probe`, `improver` and `reflection` triggers, then otherwise calls `requestApproval` (`sessions/sessions.ts:198`). `ask_user` was also constructed independently of `automatic` when harness tools were enabled (`sessions/sessions.ts:397`, `tools/askUser.ts:69`). That question-tool gap is resolved for newly resolved runs by PROP-0022/ADR-0022 (2026-10-24); an unattended continuation of a run pinned with that tool is rejected. Thus the flag alone does not establish the invariant that every unattended run refuses human interaction; host policy and capability selection can narrow these paths. This is a static source finding, not a live reproduction. See [proactive autonomy research](../study/proactive-autonomy.md#current-foundation-and-the-missing-loop). |
| D-12 | 12-storage layout | The isolated browser keeps device-local profiles and settings under `<state dir>/browser/` (`browser/config.ts`, `browser/session.ts`); page 12's layout did not list it. Resolved 2026-10-23: page 12 lists it. |
| D-13 | `docs/study/feature-gap-review.md` row 8 | Says browser and computer interaction are not built in. Page 13 (PROP-0012) records a generic isolated browser in the foundation; computer interaction needs a host surface. |
| D-14 | 12-storage layout — resolved with ADR-0082 | Page 12 now distinguishes `<state dir>/browser.json` (`BrowserConfig`) from `<state dir>/browser/` (profiles, downloads and owner-only extension pairing state), matching `browser/config.ts` and `browser/extension/bridge.ts`. |
| D-15 | Terminal sketch verification status — resolved 2026-10-24 by PROP-0028 | Pages 11 and 14 and `terminal-tui.md` said connected-sketch implementation verification was pending, while retained PTY evidence and PAR-014 recorded it as verified. Updated the docs to distinguish deterministic fixture verification from owner visual acceptance, every-emulator rendering and live-model sketch quality. |
| D-16 | Terminal slash-command highlighting — resolved 2026-10-24 | `terminal-tui.md` specified accent coloring for recognized leading commands while typing, but the OpenTUI composer only styled attachment labels. User-message bubbles also lacked command-token styling. The renderer now uses the active command registry for both surfaces. |
| D-17 | `PROP-0039`, `ADR-0036`, `INV-GATE-3/8` | Implementation is in progress in the 1.2.0 worktree: native writes revalidate canonical targets and atomically replace files under an OS write scope; default Bash fails closed on external hard-link aliases and runs in a sandbox that prevents new cross-boundary links; outside-scope Bash requires approval before one execution and command output never triggers approval or replay. The filesystem root is rejected as a workspace, and approval details expose the complete command. Launcher selection uses fixed system paths. Same-user peer processes remain outside this boundary. Focused macOS tests, full Harness CI, App compatibility checks, and PTY verification at 40x20, 80x24, and 100x30 pass. Linux sandbox integration remains unverified locally because this Darwin host has no `bwrap` and Colima is stopped; both CI workflows now install bubblewrap and `scripts/ci.sh` fails if it is absent, but an Ubuntu run is still required. No candidate, tag, or publication exists. |
| D-20 | Terminal pending queues, page 11 — resolved | The terminal now projects native and deferred pending messages above the working line. |
| D-19 | Provider limits layout | Page 09 describes a centered Limits dialog; page 11 and `src/terminal/tui/pages/usagePage.ts` describe and implement a full-screen page. |
| D-18 | `core/index.ts` migration 5 | The `run_stats` table has no writer in the Harness. PROP-0042's `usage_requests` ledger is the analytics source; whether to drop the older table is open. |
| D-21 | `terminal-tui.md`, per-mode model and effort | The terminal page says the App reads and writes the per-mode choices through `accounts.choices` and `accounts.choose`. The App's source calls neither method: its account, model and effort are saved on the App Thread (App ADR-0023), and plan mode shares that Thread's tuple. Whether the App should adopt the Harness's per-mode store is an owner decision. |
| D-22 | Plan outcomes, pages 02 and 11; ADR-0055 — resolved | Page 02 previously described a missing-block repair without distinguishing paths: the runner repaired but the terminal only warned, and neither classified clarification. ADR-0057 adds shared outcome classification and a bounded repair in both paths. |
