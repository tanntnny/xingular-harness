# Adoption roadmap — implementing these findings in this harness

Derived from `arms/01–10` and `insights.md`. Tiering: **T1** = landed patterns
from battle-tested open harnesses, adopt now; **T2** = adopt after a check or a
measurement; **T3** = park. Every item lands through one of the seven surfaces
(prompt sections, tool providers, `ToolPolicy`, `SecretStore`, `Directory`,
plugin descriptions, `RefineHost`) or the tree/refine machinery already in
`src/`, never by naming an application concept. Check plan: `npm run typecheck`,
`npm test`; `npm run prove` when the server/CLI/startup changes.

## Tier 1 — adopt now

| # | What | Where it lands | Why & source | Verification |
|---|---|---|---|---|
| 1 | **Prompt-section ordering contract**: contributors declare a numeric order; compilation sorts (order, then name), rejects duplicate ids, scoped entries shadow globals | prompt compilation in `src/prompt/compile.ts` + plugin descriptor (`src/plugins/builtin.ts`) | dsh's section contract — deterministic ordering is a *cache* and *reasoning* asset (arm 01, insight 3) | unit tests incl. duplicate-order throws and shadowing either-order |
| 2 | **Tool approval tiers**: every ToolSpec declares `read\|write\|exec`; standing-approval policy wording derives from tiers | `ToolPolicy` + `src/tools/types.ts` (+ tool providers' default rows) | omp's tier×policy legibility (arm 02/07) | the tier is mandatory in the gate path; docs |
| 3 | **Policy-missing ⇒ ask** invariant with tests | gate in `src/` (`ToolPolicy` evaluation) | omp fails closed; dsh bundle default (arm 07) | a gate test per missing-policy shape |
| 4 | **Tool descriptions as template files**: description text lives in `.md` (interpolating `{product}`), imported `type:"text"` — no inline instruction literals in tool definitions | `src/tools/*` | omp's "prompts never in code"; reviewability (arm 02) | build renders identical output; no behavior change |
| 5 | **Subagent receipts self-describe limits** (24k cap, delivery semantics) inside the receipt text | `src/tools/spawnSubagent.ts` | ours — the cap exists but is implicit (arm 03, S2) | receipt content test |
| 6 | **Tree validation adopts harness²'s discard rules** where missing: skill trigger-line presence in always-on text; braces checking; script-existence (re-verify which already hold in `validate()`) | `src/tree/tree.ts` + tests | harness² turns prompt conventions into machine gates (arms 04/10, K2/K3) | a failing-tree test per rule |
| 7 | **Sync refinement prompts with upstream drift**: pull changed sentences from harness² `adapt` pack (pool-anonymity, deliverable-shape rule) into `src/refine/prompts.ts` | `src/refine/prompts.ts` | upstream evolved past our port snapshot (arm 10, R1) | existing refine tests stay green; wording-insensitive assertions |
| 8 | **`<notes>` decision-audit format** added to compose/selection stages (kept\|revised\|dropped → edit → evidence) | `src/refine/prompts.ts` | tts pack's auditability upgrade (arm 10, R2) | schema on notes parse |
| 9 | **Volatile-value placement rule**: no date/cwd/env in the stable prefix ever; supply via `xingular-context` channel or a user-turn injection | `src/prompt/compile.ts` (nothing, if currently absent — confirm) | omp's invalidation lesson (arm 01, A1; **verified**: our compiler injects none today) | a lint-style test asserting the prefix has no volatile lines |
| 10 | **Normative docs**: one-subprocess-service norm and identity-blind transport commitment for any future telemetry-like export | repo README / docs | dsh (arms 08/09, E2/O1) | ADR text only |

## Tier 2 — adopt after a check or measurement

| # | What | Precondition | Landing surface |
|---|---|---|---|
| 11 | Compaction shapes: fixed named-template summary + verbatim tail checkpoint + prune-first ordering | inventory our current compaction behavior first (Pi-native history; no `src/` compaction found) | `RefineHost`/session docs, then prompt sections for restoration text (arm 05, C1–C3) |
| 12 | `toolOrder` validation for pinned tool sets (unknown/rejected/marker rules) | confirm our capability freezing can't already be ordered inconsistently | `sessions.run` freeze path (arm 02, A4) |
| 13 | Restriction masks equivalent to dsh `ctx.tools.restrict` — check whether `capabilities.intersect` already covers scoped narrow-and-lift before adding anything | read `src/capabilities/` | none if covered (arm 02) |
| 14 | Skill-catalog deltas in `xingular-context` when tree versions change mid-run | assess token cost of name+description deltas vs tree sections | context update contents (arm 04, K1) |
| 15 | Substrate-parity test R5: an upstream harness² candidate tree validates under `PI_SURFACE` without edit | none — test only | `src/tree/` tests (arm 10, R5) |
| 16 | **Cache warming** near TTL (omp `cache-warmer.ts`) and the cache-*stable-prefix* probe protocol: engineering lives app-side; the harness may only need to expose request timing in run events | measure with `probe-chat-cache-app.py` from the App repo, with the account owner's permission | nothing harness-side unless events lack durations (arm 01, A5) |
| 17 | Sandbox classes offered as `ToolPolicy` options (read-only/workspace-write) | app-level sandbox plumbing exists | ToolPolicy (arm 08, E1) |

## Evaluation of the harness — suite and sweep items

How the harness itself gets measured over time (STUDY-0001; the mechanism is
`src/refine/`, with frozen tasks and sweeps owned by the Evaluation repo).

| # | What | Where it lives | Status |
|---|---|---|---|
| E1 | **Evaluation matrix** (`runMatrix`): tree × task deliverability records with comparability keys (task-hash, executor, package version, fingerprint); `refine matrix` CLI taking tree dirs or committed scope versions; records beside refinements (`refine/<id>/matrix.json`) | `src/refine/suite.ts`, `refine/cli.ts` | **landed** (05/12 pages updated) |
| E2 | No-model CI lane: the matrix through the demo executor, proved standalone | `scripts/prove-standalone.mjs` | **landed** |
| E3 | Tree-lineage sweep: matrix across every adopted version of a scope | suite `{scope, version}` entries; a driver later | capability landed |
| E4 | Frozen task library: answer-stripped `RefineTask` records + source fixtures + leak globs | Evaluation repo | pending |
| E5 | Commit-range sweep: per commit, git worktree → `refine matrix` → matrix rows | Evaluation repo (drives production code; never fakes a session) | pending |
| E6 | Regression report: flip table (delivered⇄empty), cost-per-delivered between two matrices | Evaluation repo dashboard | pending |
| E7 | Suite-based adoption gate: `adopt` only when the chosen tree wins the frozen suite, else `keep_base` | `refine/service.ts` policy; suite data from Evaluation | pending |
| E8 | Real PiExecutor lane with cost/wall budget stops | Evaluation repo + App; needs the account owner's approval | parked until approved |

## Parked / anti-candidates (recorded, do not build)

- `memory://` protocol over wiki tools (omp mnemopi) — caps/budgets suffice for now (arm 06, M2).
- `fork`-style history-seeded children (dsh) — breaks the fresh-child accounting model (arm 03).
- Free code-as-action for model tools (smolagents) — the per-call gate is a load-bearing contract; revisit only behind a RefineHost-scope opt-in (arm 02).
- In-harness judge module — requires the family-layering decision (Evaluation owns measurement) before any port; if ever ported, port the *decoupling shape* verbatim (arm 10, R4).
- omp's in-process coretools shell environment — an execution detail of
  omp/pi-shell, host-supervised here; not adoptable machinery (arm 08).

## Sequencing

1. Items 1–4 (contract tier: prompt ordering, tiers, fail-closed, template descriptions) — one focused change each, with tests; land first because later items build on the vocabulary.
2. Items 5–9 (mechanical: receipts, validation, prompt sync/notes, placement rule).
3. Item 10 + Tier-2 checks (12–15) as a small batch.
4. Measurement-gated items (11, 16) last, through the App scripts where indicated.

Every landed item updates the relevant arm doc's "adoption candidates" row to
`landed: <path>` and adds an ADR when the change alters a contract (server
methods, tool gate semantics, tree validation).
