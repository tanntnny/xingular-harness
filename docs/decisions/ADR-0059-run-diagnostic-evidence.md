---
id: ADR-0059
title: Record structured refusal and run stop evidence
status: Accepted
created: 2026-10-29
---

# ADR-0059: Record structured refusal and run stop evidence

## Context

A stopped or incomplete run can result from a guardrail, a lifecycle limit, a provider failure, or
model behaviour. Human-readable tool results and terminal reasons alone do not reliably distinguish
these cases, and matching their text binds diagnosis to wording. Historical records cannot establish
an outcome code that was never recorded.

## Decision

The foundation records a `tool.refused` event for a gate or work-slice refusal, with the call id,
tool name, bounded reason and a fixed refusal code. It keeps the existing tool response text. The
terminal relays the same evidence on a best-effort basis; an unreachable controller cannot record its
own loss. Refusals within a running tool are not gate events.

A settled run records a nullable `terminalCode` separate from its human-readable `terminalReason`.
Interrupted status events may carry a code; failed events retain their existing failure code, mapped
to a stop code by the run store. Recovery records its own known cause. Older records without a code
remain unknown, not a guessed cause. Trajectory search and the terminal trajectory view expose the
recorded evidence. Compaction events include available measurements rather than estimates.

## Consequences

Diagnostic clients can distinguish recorded causes without parsing prose, while still examining the
original evidence. Stop codes describe why a run settled, not whether the requested work was actually
finished. Callers must accept the added event and optional record fields, and historical runs retain
less precise evidence. The foundation remains the only writer of run records and events.
