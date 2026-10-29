---
id: ADR-0054
title: A live terminal reply reports a heartbeat and ends when it stops making progress
status: Accepted
created: 2026-10-28
proposal: PROP-0041
---

# ADR-0054: A live terminal reply reports a heartbeat and ends when it stops making progress

## Context

A structured run emits a `heartbeat` every 30 seconds while it works, and the run sweep uses it to
settle a reply that stopped reporting (INV-RUN-14). A terminal reply emitted none: the extension sent
tool, message and usage telemetry, but never a heartbeat. Two consequences followed.

The sweep could not tell a wedged reply from one written before heartbeats existed, so it waited the
full 30-minute silence window, and then recorded `owner_gone` — "the owner process is gone" — while
the owner was alive and its turn was still pending. On 2026-10-28 a `deepseek-v4.1-flash` request in
a terminal session produced a partial tool call and then nothing for 38 minutes; a request earlier in
the same session stayed open for 2 h 13 min and ended only when the person typed the next message.
The run showed as `running` the whole time.

## Decision

A terminal reply reports a `heartbeat` every 30 seconds for as long as its turn is live, with the
counters its work slice already keeps: steps, elapsed time, last tool, compactions, slice and the
call budget. The controller records it on the active run like any other telemetry, so the sweep's
existing five-minute heartbeat rule now applies to terminal replies.

A heartbeat proves the turn is alive, not that it is working, so the terminal controller also ends a
reply that produced no event other than heartbeats for fifteen minutes. It does that by asking the
native turn to abort through the command the extension already polls; the run records `interrupted`
with reason `stalled`. A reply whose oldest running tool has run for thirty minutes is ended the same
way. A reply with an unanswered approval or question is never cut short, because it is waiting on the
person, not on the model.

## Rationale

The two windows are different questions. Five minutes of silence with no heartbeat means the process
stopped reporting, which the sweep settles; fifteen minutes of heartbeats with no progress means the
process is alive but the reply is not moving, which only the controller can end. Keeping both avoids
weakening the rule that protects a live but quiet turn: a long tool or a long reasoning stream still
reports its heartbeat, and the person answering a decision is never timed out.

## Consequences

A model request that never returns is ended after fifteen minutes instead of running for hours, and
the record carries a reason that is true. Terminal replies now write one small event every 30
seconds (about 60 KB an hour), the same as a bounded structured reply. No tool, permission, run-event
schema or stored-data layout changes: `heartbeat` already exists in the stream, and the reason
`stalled` is already part of the contract.
