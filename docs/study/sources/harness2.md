# Source: harness² (Google Research)

- Origin: [google-research/harness2](https://github.com/google-research/harness2)
  (Apache 2.0) and the paper *Harness²: Recursive Agent Harnessing for an Open
  World* — Xu et al., 2026, [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)
  (PDF saved at `external/harness2/harness2-arxiv-2610.14224.pdf`). Project page:
  [harness2.github.io](https://harness2.github.io/). Site: 11.5 pts WorkBuddy-Bench
  etc. — verify exact numbers from the paper before citing.
- Local clone: `external/harness2` (Python). Note: substrate adapters include
  `opencode.py` and `codex.py` — harness² wraps other harnesses.
- Why studied: the conceptual core of this study. A harness = everything around a
  frozen model (prompts, tools, memory, skills, orchestration); harnessing =
  optimizing that system recursively, at task level (edit → probe → compose) and
  harness level (experience reflector → improvement harness).

## Verified layout

`harness2/core/`: `prompts.py`, `proposer.py`, `recursion.py`, `selection.py`,
`judge.py`, `library.py`, `ledger.py`, `tree.py`, `context.py`, `spec.py`,
`schedule.py`, `runmark.py`, `report.py`.

`harness2/substrate/`: `base.py`, `codex.py`, `opencode.py`.

`harness2/cli/`: `bridge.py`, `judge.py`, `run_sweep.py`, `check.py`, `report.py`,
`setup.py`, `demo.py`.

Docs: `docs/BENCHMARKS.md`, `docs/EXPERIMENTS.md`, `docs/SETUP.md`.

## Map to arms

- Arm 10 (refinement ⭐ — primary): `proposer` (harness editor: invariant vs domain
  edits), probes/executor for candidates, `selection` (composer choosing among
  candidates), `recursion` (two levels), `judge` (answer-free self-labelling of
  rollouts), `library` (experience library), `ledger` — compare against this
  harness's Propose–Probe–Compose, answer-free selection, experience library,
  refine/ledger identity, and `RefineHost` isolation.
- Arm 01 (prompt): `tree.py` + `context.py` — what their harness tree/editable
  files look like vs this harness's versions never, only superseded.
- Arm 06 (memory): `library.py` — cross-task experience write-back policy.

## Open questions for the audit

1. What is editable in their harness tree, what is invariant, and how does
   "invariant" map to this harness's capped/validated c1–c4?
2. How does their self-judge stay answer-free — is its label visible to proposer
   and composer, and does its error bar matter?
3. How are candidate probes isolated (workspace, approvals refused)?
4. What does the experience reflector write back, with what schema and trigger?
5. Which substrate contract does `substrate/opencode.py` actually need — is one
   substrate adapter for this harness feasible via `RefineHost`?
