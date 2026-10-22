# Google Harness²

Harness² is the recursive-harnessing approach described in the [Harness² paper](https://arxiv.org/abs/2610.14224)
(Apache-2.0, Google LLC). The Harness applies the idea to improve agent behavior while keeping
model weights fixed: runs produce evidence, refinement proposes changes to a Harness Variant, and
a person decides whether to adopt them.

## Harness Variant (HV)

**HV** is the short name for **Harness Variant**. An HV is a validated, versioned set of eight
components for one scope. A run pins a version so its behavior does not change mid-run.

| Component | What it controls |
|---|---|
| c1 — System prompt | Agent instructions |
| c2 — Guardrails | Behavioral constraints |
| c3 — Memory | Always-on memory guidance |
| c4 — Tool guidance | Guidance for using available tools |
| c5 — Subagents | Named subagent instructions |
| c6 — Skills | On-demand skills and their scripts |
| c7 — Scripts | On-demand scripts |
| c8 — Plugins | Plugin extensions in the tool loop |

An HV changes agent guidance and selected resources, not the foundation. It cannot change the prompt
compiler, tool gate, run recorder, accounts, or trust rules. A candidate is not used until a person
adopts it as the scope's head version.

## The Propose–Probe–Compose loop

1. Run the current HV on a task in isolated workspaces and capture evidence.
2. Improver sessions propose edits to copies of the HV from two perspectives: **INV** (how the agent
   works) and **DOM** (what a practitioner knows).
3. Probe candidates, then compose behavior from observed contrasts.
4. Select a final output blindly from anonymized candidates. Improvers and the selector never receive
   scores, rubrics, or reviewer verdicts.
5. Return a candidate for a person to adopt; refinement never updates the active HV by itself.

Parallel mode explores more alternatives; sequential mode refines more deeply. Both follow the
method's budget identity of **R = 4k executions** and **P = 3k improver sessions**.

## Experience across tasks

Each scope has an experience library containing adopted HVs and evidence-backed lessons about their
edits. Future task improvers can consult that library. The library preserves the variants themselves
rather than only summaries.

## Further reading

- [03 Variants](../../architecture/03-variants.md) — component surface, validation, versions, and trust.
- [05 Refinement](../../architecture/05-refinement.md) — full method, evidence contract, budgets, and selection.
- [ADR-0011](../../decisions/ADR-0011-foundation-and-variants.md) — the fixed-foundation/mutating-variant decision.
- [Harness² paper](https://arxiv.org/abs/2610.14224).
