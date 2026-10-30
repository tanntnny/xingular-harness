---
id: ADR-0070
title: A terminal reply continues across work slices in place
status: accepted
created: 2026-10-31
updated: 2026-10-31
supersedes: partial — ADR-0069 (item 3, "neither auto-continues" for a budget-ended terminal reply), PROP-0041 (terminal replies hand every boundary to the person)
related:
  - PROP-0041
  - ADR-0069
---
# ADR-0070 — A terminal reply continues across work slices in place

## Context

A headless run that stops at its work-slice budget already continues on its own (`continueSlice`,
up to `maxSlices`). A terminal reply did not: at 320 tool calls or 60 minutes it settled
`slice_complete` and waited for the person. In a recorded two-hour design-system handoff the reply
was cut mid-command at step 221, sat idle nine minutes until the person typed "continue", and the
next request re-sent about 200k tokens uncached. The guard's own text already told the model "the
next slice continues from it", which was false in the terminal.

## Decision

1. **Continue in place.** When a terminal reply ends at its budget, `sliceContinuation`
   (`sessions/workSlice.ts`) returns a continuation from Pi's `agent_before_settle`: a
   `xingular-slice-continue` message naming the next open todo item, in the same run, so the cached
   prompt stays warm. The counters and clock restart; compactions carry over, so a reply that keeps
   compacting still ends.
2. **The same stops as `continueSlice`.** No continuation after a fruitless slice (no successful
   `bash`, `edit` or `write`), a `finish` declaring `blocked` or `needs_decision`, a provider
   failure, an abort, a plan reply, a todo list with every item done, or `maxSlices` (8 by default).
   Then the reply settles `slice_complete` as before and the person decides.
3. **One checkpoint per slice.** Each boundary sends a harness-written `checkpoint` with its real
   slice number and a notice; the heartbeat reports the live slice. A person's message starts again
   at slice 1.
4. **Launch control.** `XINGULAR_WORK_SLICE=off` still removes the boundary; key=value pairs
   (`maxToolCalls=15,maxSlices=3`, the run-policy fields and bounds) set a launch policy, mainly for
   testing. A malformed value falls back to the defaults.

## Consequences

- A long terminal task runs up to eight slices without a person, and Esc still stops it at once.
- A continued terminal reply is one run record with several checkpoints, where a headless one is a
  chain of runs; `sliceOf` keeps counting the headless chain.
- The stop gate stays silent at a slice boundary and resumes in the next slice.
