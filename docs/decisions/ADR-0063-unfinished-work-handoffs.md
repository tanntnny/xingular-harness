---
id: ADR-0063
title: Actionable handoffs for unfinished work
status: accepted
created: 2026-10-30
updated: 2026-10-30
---
# ADR-0063 — Actionable handoffs for unfinished work

> **Amended by [ADR-0069](ADR-0069-stop-gate-and-finish.md):** this guidance now applies only when the work stopped on a blocker or a decision (`finish`), never as a way to end a reply with work left.

## Context and decision

A reply can accurately report blockers yet leave the person unable to tell what decision or
action would resolve them. [PROP-0051](../architecture/proposals/PROP-0051-unfinished-run-handoff.md)
records an example. Extend the stable, harness-owned reporting guidance: when work remains
unfinished, identify the concrete decision the person must make or the next action and its owner
for each material blocker. Do not simply restate the blocker or invent a human decision.

This preserves [ADR-0008](ADR-0008-flexible-reporting-guidance.md): use only helpful structure,
without a fixed heading. It does not change approval controls, run status or the stable/dynamic
prompt boundary; no live todo state is injected into the system prompt.

## Consequences

- All packs receive the same conditional guidance; completed replies need no handoff boilerplate.
- The stable prefix changes; cache behavior requires real-request measurement under INV-PRM-8.
- This is model guidance, not enforced behavior; tests cannot guarantee the model follows it.

## Alternatives considered

- Only list blockers: rejected because it can leave the person without an actionable next step.
- Require a fixed heading or inject live todo state: rejected to preserve flexible reporting and
  the stable prompt boundary.
