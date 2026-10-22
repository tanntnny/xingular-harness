# Arm 10 — Refinement / self-improvement

Status: **audited (self + upstream, in person)** — this arm's headline finding changes
the shape of the study, see §1.

## Design space

Who is improved (prompt files, tools, tree files), how candidates are made
(dimension-split editors?), how they are probed (isolated, unattended; approvals
refused), how selection stays answer-free, how experience accumulates across
tasks, and what no step may do (act in the world with a person's assets).

## 1. Headline finding: this harness already ports harness²

Every module of `src/refine/` is an explicit port of harness²'s core, by its own
header comments:

| this harness | upstream |
|---|---|
| `src/refine/recursion.ts:5` | `harness2/core/recursion.py` |
| `src/refine/selection.ts:5` | `harness2/core/selection.py` |
| `src/refine/prompts.ts:5` | `harness2/core/prompts.py` (the **adapt** pack only — `prompts.ts:1`) |
| `src/refine/ledger.ts:5` | `harness2/core/ledger.py` |
| `src/refine/library.ts:9` | `harness2/core/library.py` |
| `src/refine/evidence.ts:13` | `harness2/core/context.py` |
| `src/refine/runner.ts:6` | `harness2/core/schedule.py::run_task` (shaped after) |

Identities preserved: R = 4k rollouts / P = 3k sessions per mode
(`src/refine/ledger.ts:7-11`), matching upstream `recursion.py:15-19`; Stage
shape (`Stage {label, dim, tree, keptBase, fellBack…}` `src/refine/recursion.ts:26-37`)
with one-retry-then-inherit upstream `recursion.py` docstring; sequential-round
checkpoint anchoring incl. the "KEEP_BASE means the CURRENT checkpoint" rule
(`src/refine/prompts.ts:316` vs upstream `prompts.py:852-857`); the answer-free
selector (`src/refine/prompts.ts:399` mirrors `prompts.py:791-793`); KEEP_BASE
doctrine (`src/refine/prompts.ts:232` mirrors `prompts.py:333-335`).

The merge the study was asked to plan is therefore **already largely executed**.
What remains is a mature-upstream delta analysis, below.

## 2. Comparison with harness² as it now stands

Converged (ported): parallel/sequential recursion, INV/DOM candidate split with
independent same-evidence samplers, aggregator/composer with MERGE / ADOPT-ONE /
KEEP_BASE, anonymized answer-free selection, per-domain experience library
carrying the **full adopted tree plus an EXPERIENCE.ms-style why/lesson** (ours:
`src/refine/library.ts`; theirs: `external/harness2/harness2/core/library.py:15-23`,
"the whole tree is carried, never a summary"), reflection writing cue/lesson rows
(`src/refine/prompts.ts:418-425` mirrors their `_EXP`-driven reflector).

Deltas (upstream beyond our port):

1. **Second, hardened prompt pack ("tts").** Upstream ships two packs per stage
   (`_tts_propose` / `_tts_aggregate` / `_tts_select` vs the base pack,
   `external/harness2/harness2/core/prompts.py:838-839,896-897`); ours carries
   only the adapt pack (`src/refine/prompts.ts:1`). The tts pack adds: an
   explicit **`<notes>` decision audit format** (`kept|revised|dropped -> edit ->
   evidence`, `.../prompts.py:765-769`), a `yardstick` slot ("WHAT GOOD PROCESS
   LOOKS LIKE HERE", `.../prompts.py:705-706,757-761`), sharper always-on
   economics and on-demand-first framing, and pool-anonymity emphases
   (`PICKING AN UNMODIFIED HARNESS IS VALID`, `.../prompts.py:66-74`).
2. **Screenshot-era surface dialects.** Upstream maintains this c1–c8 tree for
   two substrates (opencode and codex) with per-substrate hook/plugin mechanics
   (`.../prompts.py:617-661`, `tree.py:41-60 SurfaceSpec`) — ours compiles one
   Pi surface (`src/refine/recursion.ts` imports `PI_SURFACE`).
3. **A decoupled judge.** `harness2/core/judge.py:15-19`: measurement of the
   chosen run happens *after selection*, **"Nothing in the method imports this
   module"**; a judge failure is None, excluded from denominators
   (`.../judge.py:37-40`). **Not ported** — `src/refine/` has no judge module.
   This is the one structural piece of upstream we do not have.
4. **Substrate contract vs our RefineHost.** Their substrate wrap is a
   file-level (`context/harness/` editable tree + workspace dirs); ours isolates
   through `RefineHost` (workspace, probe session, deliverable) with probe runs
   as unattended sessions whose approvals are refused (repo contract). Same
   shape, different isolation vocabulary — ours is the stronger primitive, but
   note upstream's `keep_base` inherits untouched files with no re-read
   (`.../prompts.py:186-189`); ours should verify the same semantic survived the
   port (pending test-level confirmation).

## 3. Trade-offs

- **Judge in or out.** Keeping measurement out of the harness (our family rule:
  measurement belongs to Evaluation) preserves layering but forfeits private
  experience labeling — the `<experience>` reflection then rests only on
  trajectory contrast, which ours already guards ("A lesson resting only on
  `confounded` rows is a guess", `src/refine/prompts.ts:425`). Upstream's
  compromise: a judge that labels the *chosen* run only, never feeds forward, and
  is excluded from denominators on failure — it cannot leak into selection
  because selection already happened.
- **Prompt packs.** Two packs cost maintenance but let upstream evolve hardening
  without destabilizing the published method. Ours froze one pack at port time;
  upstream drift since then is invisible to our selectors.
- **One surface vs many.** Ours targets Pi only; upstream's SurfaceSpec proves
  the same method bends to codex/opencode cheaply — a bridge test for whether
  our `RefineHost` boundary is truly substrate-agnostic.

## 4. Adoption candidates

| # | Idea | From | Tier | Land as |
|---|---|---|---|---|
| R1 | Diff the ported prompts against upstream's `adapt` lines and pull changed sentences (e.g. pool-anonymity emphasis, deliverable-shape rule) into `src/refine/prompts.ts` | harness² drift since the port | T1 | in-place prompt text sync (tests measure wording-insensitive behavior) |
| R2 | Add the `<notes>` audit format to compose/selected stages so adoption decisions carry their evidence | tts pack | T1 | our prompts' notes sections |
| R3 | Consider the yardstick slot as an optional, app-supplied `BenchPrompts` field — *only if* an app needs a domain yardstick; it must remain prose, never a score | tts pack via `Spec` | T2 | `RefineHost` launch input, thinking hard before adding |
| R4 | A post-selection judge module, ported with upstream's exact decoupling (not imported by the method; None on failure excluded from denominators) **or** explicitly glued to Evaluation | judge.py | T2 with a layering decision first — see trade-off above | new `src/refine/judge.ts` behind `RefineHost`, or nothing |
| R5 | Re-run upstream-vs-ours substrate parity test: can our tree/validation accept an upstream-authored candidate tree without edits? (`isAllowed`, caps, autotrigger semantics) | both | T1 verification task, no code change | a test |

Anti-candidates, recorded so nobody re-proposes them: do **not** move measurement
or grading into `src/refine/` (family boundary: Evaluation owns measurement);
do **not** let any judge label reach improver or selector (answer-free is
invariant); do **not** carry per-task facts into the durable library without the
cue/lesson narrowing ours already enforces.
