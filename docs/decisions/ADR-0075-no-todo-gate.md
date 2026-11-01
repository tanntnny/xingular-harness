---
id: ADR-0075
title: No todo gate; a reply ends when the model ends it
status: accepted
created: 2026-11-01
updated: 2026-11-01
supersedes: ADR-0069 (its stop gate), ADR-0072 (its "the todo gate stays")
related:
  - ADR-0069
  - ADR-0072
  - STUDY-0004
---
# ADR-0075 — No todo gate; a reply ends when the model ends it

> **Supersedes the todo gate of [ADR-0069](ADR-0069-stop-gate-and-finish.md)** and the line in
> [ADR-0072](ADR-0072-codex-prompts-and-goal.md) that kept it. The goal loop and its claim check
> stay.

## Context

ADR-0069 added the stop gate: in an attended top-level reply, an item still `pending` or
`in_progress` at Pi's `agent_before_settle` boundary sent the reply back with a displayed
`xingular-stop-gate` message, up to three nudges, and then settled the run
`interrupted{unfinished}` with a harness-written checkpoint.

In use the messages read as noise. "Harness stop gate (1/3): your reply ended with 2 open todo
items…" appears in the transcript of a person's own session, and a stale item the model forgot to
close marks the run unfinished even when the work is done. The person asked for the nudges and the
unfinished status to go, and for the prompt to relax instead.

The peer check on 2026-11-01 does not make this an obvious outlier either way:

| Harness | Todo nudge at the end of a turn | Evidence |
|---|---|---|
| omp | **Yes.** `TodoTracker.checkCompletion()` appends "You stopped with N incomplete todo item(s)… Please continue" as a developer message and schedules a continuation, up to `todo.remindersMax` (default 3); it skips a reply awaiting the person and also nudges mid-run after 12 mutating tools | `external/omp/packages/coding-agent/src/session/todo-tracker.ts:221`, `src/tools/settings.ts:360-380` |
| Claude Code | No bounce. A gentle reminder to use TodoWrite ("This is just a gentle reminder - ignore if not applicable"); a `Stop` hook is user configuration | Extracted prompt `system-reminder-todowrite-reminder.md`, `ccVersion` 2.1.139 |
| Codex | No bounce. `update_plan` is opt-in since 0.152 and enforces nothing at the end of a turn | STUDY-0004; 0.152 release notes |
| Kimi CLI | No bounce. A todo tool and instructions only | `external/kimi-cli/src/kimi_cli/tools/todo/set_todo_list.md` |
| OpenHands, SWE-agent, smolagents | No todo gate | No todo tool or no end-of-turn enforcement |

So this harness had copied a real design, but it is the minority design among the studied peers,
and its messages are the thing the person objected to.

## Decision

Remove the gate:

- Delete the nudge extension, its state, `nudgeText`, `stopGateNotice`, `MAX_STOP_GATE_NUDGES`, and
  the `XINGULAR_STOP_GATE` switch.
- A reply the model ends settles `completed`. The harness does not send it back and does not
  overwrite its status from the todo list.
- A person's interrupt, the work-slice guard (INV-RUN-13) and a goal's stop (INV-RUN-16) keep their
  statuses and checkpoints. A blocked goal settles `needs_person`; a goal on a limit, a pause or a
  stall settles `unfinished`.
- The goal/checkpoint helpers move to `sessions/goalStop.ts`; the goal check's model helper moves to
  `completionCheck.ts`.
- The prompt keeps the work-slice sentence as `WORK_SLICE_GUIDANCE`, and `TODO_GUIDANCE` is relaxed:
  the list is a progress aid, the request is the scope, and a step left open is explained in the
  reply. No text says a reply is sent back.
- A login that blocks the work is answered with the exact command the person must run (see
  `04-prompt.md` § Reporting).

## Consequences

- An early stop is no longer caught by the harness. The prompt is the only layer that asks the model
  to finish the request, and a person reading the reply has to notice a stop with work left.
- The App no longer shows an interrupted-run notice for open todo items; it still does for a slice,
  a goal and a person's interrupt.
- The stable prefix loses the old `STOP_GATE_GUIDANCE` sentence and gains the credential rule in the
  reporting section; existing sessions miss the provider cache once after the upgrade.
- `XINGULAR_STOP_GATE` is retired and ignored if set. No data or protocol change; run records
  written before this change keep their statuses.

## Alternatives

- **Keep the gate and only make it opt-in, off by default.** Rejected: the machinery and its
  messages would still exist for the default path people read, and the harness would carry a
  capability nobody turns on.
- **Keep one reminder.** Rejected: the person asked for the nudges to go, and one reminder still
  writes a harness message into their reply.
- **Remove the message but keep the `unfinished` status.** Rejected: the status comes from a list the
  model may not maintain, so a stale item would mark finished work unfinished with no way to fix it.
- **Keep the gate.** Rejected: it is the thing the person objected to, and the majority of the
  studied peers leave the end of a turn to the prompt.
