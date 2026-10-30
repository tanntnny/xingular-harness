---
id: ADR-0068
title: Scope of the work and two required completion headings
status: accepted
created: 2026-10-30
updated: 2026-10-30
supersedes: partial — ADR-0008
---
# ADR-0068 — Scope of the work and two required completion headings

## Context and decision

ADR-0008 removed the fixed heading list from the `reporting` section and kept every heading
optional. Two problems followed from a prompt that only described output:

1. Every run of the last seven days that ended with work left (207 of 822, 25 %) did so at a median
   of 17 tool calls; the model treated the literal request as the whole assignment
   (`outputs/diagnoses/2026-10-30-sweep.md`). Nothing in the prompt said the work extends to what the
   request implies.
2. A person reading the final reply could not tell what had been done beyond their request, nor what
   would finish the run. `README`-style prose hid both.

The `role` paragraph of a standard session now states the scope of the work — the job the request
implies, not only its literal words, inside the working folder and away from what a person must
decide (a deploy, a secret, remote data, money), without asking first inside those bounds — and the
`reporting` section requires two headings when they apply:

- `## Beyond what you asked` — anything done beyond the request, each piece with why the work needed it.
- `## What would make this complete` — the concrete remaining steps in order, naming the ones only
  the person can decide.

`REPORTING_BUDGET` rises from 2,000 to 2,400 characters to hold them without cutting
(`prompt/compile.ts`).

## Consequences

- A run may do and report adjacent work that the person did not name; the second heading is what
  makes that auditable and rejectable rather than silent.
- The stable prefix changes once per session for the three texts (`role`, `reporting`,
  `TODO_GUIDANCE`). Measured with real requests only, under INV-PRM-8.
- Applications bundling the harness need a rebuild before any new session sees the wording; an
  existing session keeps the prefix it compiled (observed: `context.json` `compiledAt` 16:33:36Z
  reused by a run at 17:21Z).
- No stored data or protocol changes. Bounded autonomy is still enforced by the tool gate and the
  workspace boundary; the prompt does not grant new reach.

## Alternatives considered

- Keep every heading optional (ADR-0008 as it stood): rejected — the two facts above were invisible
  in the reply, so the person could not see either the extra work or the gap.
- One combined heading ("Summary"): rejected — extra work and remaining work are different decisions
  for the person, and merging them hides which is which.
- Make autonomy a runner feature (continue when a todo is open): deferred, not rejected. The prompt
  is the cheapest lever and was not yet in effect; `docs/research/2026-10-30-turn-end-controls.md`
  records what other harnesses do and when a stop-hook style continuation is worth adding.
