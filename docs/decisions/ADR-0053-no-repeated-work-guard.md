---
id: ADR-0053
title: No repeated-work guard in the work slice
status: Accepted
created: 2026-10-28
supersedes: ADR-0039 (targeted protections only)
---

# ADR-0053: No repeated-work guard in the work slice

## Decision

Remove the repeated-work rules from the shared work-slice guard (`src/sessions/workSlice.ts`). A
reply is no longer refused for calling the same tool with the same arguments three times, for
running a Bash check that failed twice, or for more than four successful `edit`/`write` results on
one path. Nothing ends a reply as `stuck`.

The bounds that remain are the configured tool-call, minute and new-token budget and the
third-compaction thrash rule, both of which still ask for a checkpoint handoff and end the reply on
further calls. A budget-ended reply is `interrupted` with terminal reason `slice_complete` in both
surfaces. Slice continuation, the plan-research child bound and the model-written `blocked`
checkpoint gate are unchanged.

`checkpointReasonSchema` keeps `stuck` so stored `checkpoint` events stay readable and the
`checkpoint_write` argument set does not change; nothing produces it any more.

## Rationale

The rules fired on calls that are ordinary work. Reading a file again, editing one file several
times, or re-running a check after a partial fix are not loops, and a refusal there costs a reply
plus the checkpoint and continuation round trip. Tool arguments are not a reliable signal of a loop:
a changed argument is different work, an identical argument can be legitimate (a poll, a re-read
after an edit, a retried check), and the guard cannot tell them apart. The reply budget already
bounds a model that never stops, which is the failure the guard existed to catch; the compaction
rule covers the other observed thrash.

## Consequences

A reply may repeat any call until its budget, so a genuinely stuck model runs up to 320 calls or 60
minutes instead of being stopped earlier. No run-event schema, stored-data layout, server method or
App presentation changes: `stuck` remains a readable checkpoint reason and `stalled` remains the
watchdog's reason for a silent run. This supersedes the targeted repeated-call, repeated-failing-check
and edit-churn protections in [ADR-0039](ADR-0039-progress-aware-stall-guards.md); the rest of that
decision, including the bounded plan-research child, stands. See also
[PROP-0041](../architecture/proposals/PROP-0041-bounded-work-slices.md).
