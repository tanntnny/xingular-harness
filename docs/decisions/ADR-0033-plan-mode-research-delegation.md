---
id: ADR-0033
title: Keep delegation selective and research-only in plan mode
status: accepted
created: 2026-10-25
updated: 2026-10-25
related: [PROP-0032, INV-RUN-8, INV-GATE-3, INV-CAP-1]
---

# ADR-0033 — Keep delegation selective and research-only in plan mode

## Context

Subagents can reduce the cost of substantial independent work, but a child starts without the
parent's conversation and parallel edits create integration risk. Plan mode must remain read-only;
allowing every profile would let profile overrides expand its effective tools or plugins. Ordinary
subagent guidance also belongs in request context, not the stable system prompt.

## Decision

- In normal mode, recommend delegation only for substantial, bounded, independent work. Prefer a
  fitting specialist, give each child a self-contained brief, parallelize only independent tasks,
  and keep integration and verification with the parent. Simple lookups, tiny edits and tightly
  coupled work stay with the parent.
- In plan mode, allow only a named profile whose resolved tool and plugin allowlists are explicit
  and confined to read-only research. The tool gate checks each spawn's arguments before approvals;
  the subagent service checks again before launch.
- A research child inherits plan mode and can use only the intersection of its profile, the parent's
  frozen capabilities and the plan research set. It has no connectors, user questions, writes,
  commands or nested subagents. Its evidence returns to the parent, which verifies and synthesizes it.
- Put normal delegation guidance in the generated Subagents prompt section and the spawn tool's
  description. Keep plan instructions request-scoped. Do not expand the stable system prompt or add
  a second capability, approval, storage or plan-file mechanism.

## Consequences

Normal runs receive concise advice at the point where profile choices are listed. Plan runs expose
only eligible profiles and enforce the same restriction at both the gate and launch service. The
terminal and hosts share the Harness behavior. Plan outcomes remain in the existing run history and
PlanCard handoff; no protocol or stored-data migration is introduced.

## Verification

Harness tests cover normal prompt guidance, plan-mode profile eligibility and overrides, pre-approval
refusals, child tool/plugin narrowing, plan inheritance and non-nesting. The versioned Evaluation
suite adds one case where research delegation helps and one small case where it should be skipped.
Live model comparisons require explicit authorization and credentials.
