# Harness architecture specification

**Status:** binding. **As of:** 2026-10-24, checked against `src/` on branch `release/1.0.0`.

This folder is the core specification of `@xingular/harness`. Code must conform to it. A change
that would alter what it says needs a proposal the user approves first (see
[Changing the architecture](#changing-the-architecture)).

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
| **Foundation** | The fixed half of the harness: code and invariants that no edit, improver or adoption can change. Changes by release, and by proposal when a contract moves. |
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
3. **Outside the spec: propose and stop.** If the change would alter a contract, an invariant, a
   layer boundary, an extension point, or the storage layout, do not change code or pages yet.
   Write `proposals/PROP-NNNN-<slug>.md` from the [template](proposals/README.md#template) with
   status `Proposed`, add it to the proposals index, and ask the user to review it.
4. **After approval.** The user sets or confirms status `Accepted`. Then implement it, update the
   affected pages in the same change, and add an ADR in `../decisions/` when the choice is a
   lasting one. A rejected proposal keeps its file with status `Rejected`.
5. **Drift is reported, not fixed silently.** If code and a page already disagree, add the item to
   [Known drift](#known-drift) and tell the user. Do not change either side to match without
   asking; resolving drift that changes a rule is itself a proposal.

When unsure whether a change alters the architecture, treat it as if it does and write the
proposal.

## Known drift

Disagreements found while writing this specification. Each needs a decision from the user (a
proposal, or a correction to the other document).

| ID | Where | What disagrees |
|---|---|---|
| D-1 | `AGENTS.md` (before this spec), `INV-RUN-6` | The old rule said only `sessions/runStore.ts` writes `runs/<id>/`. In code, four other harness modules also write side files there: `prompt/compile.ts` (`context.json`), `sessions/sessions.ts` (`caller.json`), `capabilities/runSnapshot.ts` (`capabilities.json`), `mcp/service.ts` (`mcp-context.json`). The spec states the rule the code keeps (see `INV-RUN-6`); whether to route all of them through `runStore.ts` is open. |
| D-2 | `README.md` "Plugins" | Describes a `plugin_propose` tool and an Inbox for proposed plugins. No such tool exists in `src/`. |
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
| D-14 | 12-storage layout | Page 12 lists browser settings under `<state dir>/browser/`, while `browser/config.ts` stores configuration in `<state dir>/browser.json`; browser profiles and downloads use the `browser/` directory. The layout needs an owner decision before either side is changed. |
| D-15 | Terminal sketch verification status — resolved 2026-10-24 by PROP-0028 | Pages 11 and 14 and `terminal-tui.md` said connected-sketch implementation verification was pending, while retained PTY evidence and PAR-014 recorded it as verified. Updated the docs to distinguish deterministic fixture verification from owner visual acceptance, every-emulator rendering and live-model sketch quality. |
| D-16 | Terminal slash-command highlighting — resolved 2026-10-24 | `terminal-tui.md` specified accent coloring for recognized leading commands while typing, but the OpenTUI composer only styled attachment labels. User-message bubbles also lacked command-token styling. The renderer now uses the active command registry for both surfaces. |
