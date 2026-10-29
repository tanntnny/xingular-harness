---
id: ADR-0057
title: Structured outcomes for attended plan requests
status: Accepted
---

# ADR-0057: Structured outcomes for attended plan requests

## Context

A reply asking for a decision is not a finished plan. ADR-0055 prescribes one repair for a missing
plan block, but the prior server parser recognized only `<proposed_plan>` and could treat a request
for input as a format failure. The terminal did not run that repair. D-22 records the prior
implementation gap and documentation ambiguity.

## Decision

An attended top-level plan reply has one classified outcome: `plan_ready` for a complete existing
`<proposed_plan>` block, `needs_input` for a complete `<plan_clarification>` block containing the
needed question or explanation, and `invalid` for missing, incomplete, conflicting or malformed
outcome blocks. Only `plan_ready` permits a plan card and Implement. `needs_input` is displayed as
input needed, never as an actionable plan. The same classification and bounded repair belong to the
Harness and apply to both server and terminal, rather than independent surface heuristics.

When `ask_user` is available, it blocks for the person's answer and the same run continues; the
clarification outcome describes input still needed at the end, including when interaction is not
available. The model must not invent a decision. For an eligible run ending in `invalid`, one hidden
repair turn in the same run requests a valid outcome without changing substance or inventing
answers. Either valid outcome ends repair. If repair fails, retain the original text, complete with
a warning, and offer no Implement. Skip repair for unattended or child runs, commands, aborts,
errors and work-slice termination. The plan gate remains in force.

## Compatibility and consequences

This supersedes ADR-0055's plan-only repair criterion, not its bounded same-run mechanism. Existing
`<proposed_plan>` output and cards remain valid; no new tool, mandatory event type, changed stable
prompt prefix or widened permissions are required. Older clients may show clarification as ordinary
text, but must not interpret it as a plan. Historical untagged replies remain visible without being
fabricated into plans. D-22 is resolved by shared classification and bounded repair on both paths.
