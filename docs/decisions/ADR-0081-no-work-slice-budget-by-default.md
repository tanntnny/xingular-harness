---
id: ADR-0081
title: No work-slice budget by default
status: accepted
created: 2026-11-02
updated: 2026-11-02
related: [PROP-0041, PROP-0044, ADR-0070, ADR-0075, INV-RUN-13]
supersedes: null
superseded_by: null
---

# ADR-0081 — No work-slice budget by default

## Context

PROP-0041 bounded a reply at a number of tool calls and minutes, then handed off, and ADR-0070 and
PROP-0044 tuned that to 320 calls and 60 minutes with up to eight continued slices. In practice a
reply that was plainly still working was cut mid-task, told to "stop using tools and write a short
report", and showed as unfinished while a child worker kept the run alive.

## Decision

The foundation default has no tool-call, time or token limit. `DEFAULT_SLICE_POLICY` sets
`maxToolCalls`, `maxMinutes` and `maxNewTokens` to 0, so `sliceLimitReached` never fires and no reply
ends or continues at a budget. The guard, `workSlice` on `sessions.run` and `XINGULAR_WORK_SLICE`
stay for a caller that wants a limit, and the three-compaction guard is unchanged. The model is no
longer told a budget exists, and the standard prompt asks it to keep working until the request is
done or the person interrupts.

## Consequences

- The stable prompt prefix changes once, so the first reply after upgrading is uncached.
- Runaway work is bounded only by the stall watch (ADR-0054), the compaction guard, approvals and
  the person's Esc; a host that wants a ceiling sets `workSlice`.
- The budget code, its protocol field and its heartbeat fields remain, so a later decision can
  delete them without a migration. `heartbeat.maxToolCalls` is 0.
