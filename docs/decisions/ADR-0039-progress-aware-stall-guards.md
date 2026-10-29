---
id: ADR-0039
title: Progress-aware stall guards and bounded plan research children
status: Accepted
superseded_by: ADR-0053 (targeted protections only)
created: 2026-10-27
proposal: PROP-0046
---

# ADR-0039: Progress-aware stall guards and bounded plan research children

The targeted repeated-call, repeated-failing-check and edit-churn protections decided here are
superseded by [ADR-0053](ADR-0053-no-repeated-work-guard.md); the rest of the decision stands.

## Decision

Remove the global file-change/check no-progress trigger. Keep the targeted protections for repeated
calls, repeated failing checks, per-path edit churn, compaction thrash, and the independent
work-slice call/time budgets. Count edit churn only from successful native `edit`/`write` results
with a path. A successful edit/write clears failed-check counts, exact Bash-check repetition counts
and the pending nudge, but preserves edit counts and repeats of other calls; a passing check clears
edit churn.

Bound plan-research children with the configured work-slice policy without adding
`checkpoint_write` or any other capability. When that tool is absent, a budget or stall refusal asks
the child to stop and return partial findings; another tool call ends the reply, and the runner
records an evidence-derived checkpoint. Children do not auto-continue. Plan-mode browser and
connected-app restrictions remain unchanged.

## Rationale

Distinct reads are not evidence of a stall, and the former 25-call threshold imposed an arbitrary
file/check-progress boundary. Tool results are the shared, observable signal for whether a native
edit succeeded; treating failed or blocked attempts as edits would consume the churn allowance
without changing code. Resetting check-retry state after a successful edit lets the same check run
against changed input without weakening protection when code is unchanged. A derived checkpoint
bounds read-only research children without widening their frozen capability set.

## Consequences

Long sequences of distinct reads are limited by the configured slice budget and targeted loop
protections, not by missing file/check progress. No run-event schema, stored-data layout or server protocol changes are introduced; the terminal
uses the same guard rules. See [PROP-0046](../architecture/proposals/PROP-0046-progress-aware-stall-guards.md).
