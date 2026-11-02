---
id: ADR-0078
title: A reply waiting on subagents is judged by its children, and the working row names the wait
status: accepted
created: 2026-11-01
updated: 2026-11-01
related:
  - ADR-0054
---
# ADR-0078 — A reply waiting on subagents is judged by its children

## Context

Run `da1a7e39` ("Fix follow-up steering UX") looked stuck for 19 minutes: a spinner and a random
verb on the working row, a spinning subagent, and a trajectory of 40 identical heartbeats. Nothing
was wrong. The parent was inside `wait_subagents` and its child (run `5cd1d8aa`) did a tool call or
a model request every minute until it finished. The person could not tell that from a hang, and the
harness could not either: the stall watch saw one tool running (30-minute limit) and none of the
child's progress, so a child that really wedged would have held the parent for half an hour and then
ended the parent, not the child.

Two other limits made real outages worse: Pi's default of three retries at 2, 4 and 8 seconds ended a
reply after about fourteen seconds of network trouble, and the retry showed only as a passing toast.

## Decision

- Each subagent the terminal reply waits on has its own stall clock in `TerminalController`: its last
  event other than a heartbeat and the tools it is inside. A child quiet for the reply window (15
  minutes) or inside one tool for the tool window (30) is interrupted with reason `stalled`; the wait
  returns it as `interrupted` and the parent continues without the person.
- While the only running tools of the reply are `wait_subagents` or `spawn_subagent`, the parent's own
  rule is paused as long as a child answers to its own watch. It resumes if no child is tracked or a
  child ignored the stop for five minutes.
- Heartbeats carry `activeTools` and `oldestToolMs`; the trajectory page shows what a beat was
  inside and folds runs of beats into one row.
- The working row names the phase (waiting on subagents, a long tool, a silent model, a retry
  countdown) in place of the verb whenever the verb would hide it.
- Model requests that fail for a transient reason are retried up to eight times over about four
  minutes. A person's own `retry` settings are kept.

## Consequences

A long, healthy wait is no longer cut short, and a wedged child no longer costs the parent. The
retry budget lengthens the time before a real outage reaches the person, and the row shows the
countdown meanwhile. Constants (15 and 30 minutes, five-minute grace, eight retries) are unchanged
or new knobs in `stallWatch.ts` and `retryPolicy.ts`.
