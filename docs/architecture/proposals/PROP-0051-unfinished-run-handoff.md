---
id: PROP-0051
title: Unfinished runs must hand off a decision and a next step
status: Implemented
created: 2026-10-30
updated: 2026-10-30
affects: [INV-PRM-2, INV-PRM-8, 04-prompt.md, ADR-0008]
---

# PROP-0051: Unfinished runs must hand off a decision and a next step

## Problem

The `reporting` section tells the model to "Include blockers, risks, or next steps only when they are
concrete and relevant" (`src/prompt/compile.ts:170`). That sentence is permissive, so a run that ends
with work unfinished can satisfy it by naming blockers and never stating what the person must decide
or do next.

Run `55ad7d48-92b0-4d9d-9d80-c93b5112b80b` is the observed case, diagnosed in the run report
`thaivlm/outputs/diagnoses/2026-10-29-55ad7d48.md` in the projects workspace:

- The person asked for a 1,000-SHr training study to be implemented (seq 2).
- The run stopped with two of four todos open — "Implement reproducible mixture and study
  configuration" (in_progress) and "Implement model and optimizer compatibility checks" (pending)
  (seq 119) — and completed (seq 145).
- The final reply listed four changed files and three blockers — an empty OPC source, an in-progress
  document dataset, an HTTP 403 on gated Gemma weights, missing model adapters — then a line about
  tests, and stopped (seq 143). It named no decision, no owner and no next step.

The person's report: "agent said whats blocking which is good but the reply lacks of whats saying what
user has to do next or decision for user to do." The blocking was accurate; the handoff was missing.
A reply that names only blockers leaves the person to reconstruct the decision themselves, which is
the work the run was supposed to reduce.

Prevalence is unknown: no sweep has been run over recent runs, so this is one confirmed case plus the
guidance hole that permits it.

## Proposal

Add one conditional sentence to `REPORTING_GUIDANCE` in `src/prompt/compile.ts:165-176` — the
foundation's stable `reporting` section, not variant data — requiring that a reply which ends with
work unfinished states, in one short block, what the person must decide and what happens next:

- **when:** the run leaves todos open, reports a blocker it could not clear, or stops before the
  requested work is done. Ordinary completed replies are unaffected, so the "do not force a fixed set
  of report headings" rule (`src/prompt/compile.ts:168`) still holds.
- **what:** for each open item, either the decision the person owns (a choice only they can make) or
  the next action with its owner; not a restatement of the blocker.
- **how:** the same content-driven style as the rest of the section — a bulleted list or a short
  table, no mandated heading names.

The text stays stable and conditional. It cannot read live state: `INV-PRM-2` keeps changing state out
of the system prompt, so the clause is written for the model to apply against its own todo list and
blockers, not injected from `todo.updated` events.

Spec page to update in the same change: [`04-prompt.md`](../04-prompt.md), Reporting section — one
sentence saying that guidance also covers how an unfinished reply hands off. `INV-PRM-2` is unchanged
in meaning (the section is still fixed text); it is listed in `affects` because the section's text
changes. `INV-PRM-8` applies: the stable prefix changes once, so sessions miss the provider cache once
after upgrade, exactly as recorded for PROP-0001 and PROP-0004.

## Surfaces

No new capability and no new screen. The section is harness-owned and identical in the terminal
(`xagent`) and the App, because both receive the compiled pack
([`04-prompt.md`](../04-prompt.md) § Reporting; `SECTION_ORDER.reporting = 95`). `docs/parity.md`
needs no row: nothing is added that a host must present. Applications bundling the harness rebuild to
pick up the new text.

## Tests

`src/prompt/compile.test.ts:304` already asserts the section's shape and stability. The test that goes
red today is an added expectation on the guidance text itself, in that same test or beside it:

```ts
expect(REPORTING_GUIDANCE).toContain('ends with work unfinished')
```

plus a guard that the flexibility rule survives — `expect(REPORTING_GUIDANCE).toContain('do not force
a fixed set of report headings')`, already at `compile.test.ts:311`, must stay green.

## Alternatives

- **Do nothing; leave "only when concrete and relevant".** This is the status quo that produced the run
  above. It cannot distinguish "no blockers" from "blockers listed, decision unstated".
- **Inject live todo state into the reporting section.** Rejected: `INV-PRM-2` forbids changing state in
  the system prompt, and dynamic text would break the stable prefix (`INV-PRM-8`).
- **Reinstate a fixed heading list (PROP-0001's original).** Rejected already by PROP-0004 and
  [ADR-0008](../../decisions/ADR-0008-flexible-reporting-guidance.md): mandatory headings produced
  generic sections. This proposal adds a trigger condition, not a template.
- **Handle it in the variant prompt instead.** Rejected on routing: the guidance is foundation-owned
  (`src/prompt/compile.ts:468`), identical for every variant, so a variant edit would not reach the run
  that failed and would have to be redone per variant.

## Consequences

- Unfinished replies carry a decision or next action, at a small cost in length; completed replies are
  unchanged.
- One provider-prefix change, one cache miss after upgrade.
- No stored data, server protocol, gate or tool change.
- It remains guidance, not enforcement: a model can still under-report. A recurring pattern would
  justify a checked run-level signal (for example, a stop code that marks a run unfinished), which is
  out of scope here.

## Out of scope

- Completing the study whose todos stayed open.
- Making the harness judge whether a task is finished, or any change to run status, stop codes or the
  gate.
- Sweeping recent runs to measure how often unfinished replies omit a decision.
