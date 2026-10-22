---
id: PROP-0007
title: Continue a stopped run as a new run with the same pins
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [INV-RUN-4, INV-RUN-10, 00-overview.md, 02-sessions-and-runs.md, 10-server-protocol.md]
---

# PROP-0007: Continue a stopped run as a new run with the same pins

## Problem

When the process stops mid-run, `open` marks the run `interrupted` (`markInterruptedRuns`) and
reports only a count. An application that wants to carry on has to:

- find the interrupted runs itself;
- locate the native history and pass `resume { sessionFile, nativeSessionId }`;
- remember the account, tree version and capability set the run had, or risk running on a
  different one (INV-RUN-1 is per run, not per continuation);
- and the model is told nothing: it does not know it was cut off, which tool call may have half
  happened, or which approval was never answered.

Gap #4 of `docs/study/feature-gap-review.md`. Every studied peer keeps the same rule as this
harness — a restart never silently restarts model work — and puts continuation on a durable log
plus an explicit request (deepseek-harness's session log and checkpoints, OpenHands' requeue in its
automation layer).

## Affected rules

- **INV-RUN-4** "A restarted harness never restarts model work. On `open`, runs left active are
  marked `interrupted` unless another live process owns them (`owner.json`). Recovery of a
  subagent needs the same account, caller, working folder and history branch."
- **INV-RUN-10** lists the runs that may not carry an initial Bash command.
- 02 Contracts; 10 `runs.*`, `sessions.run`; 00 lifecycle step 2 (`Recovery`).

## Proposal

- INV-RUN-4 keeps its first sentence and gains: continuing is always a new run the application
  asks for with `continueFrom`; it pins the earlier run's account, tree version and capability
  set, and the earlier run's record is never reopened.
- `Recovery.interruptedRunIds: string[]` beside the existing count.
- `continuationOf(root, runId, sessionDir?)` → `Continuation` (`sessions/continuation.ts`), served
  as `runs.continuation`. It is a projection of what is already stored: `run.json`,
  `events.jsonl` (checklist from PROP-0006, pending decisions, last tool), `capabilities.json`,
  `subagents.json`, and the native history in `sessionDir`. No new file is written.
- `SessionRunInput.continueFrom` (run id): the run is refused with `continuation_unavailable` when
  the earlier run cannot be continued, and with `continuation_mismatch` when the caller names a
  different session, history, account or tree. Otherwise the input is filled from the earlier
  run and a dynamic `continuation` section (order 26, budget 2000) tells the model where it
  stopped, what its checklist was, which tool call's effect is unknown, and what to ask again.
  It is a context update, never the stable prefix (INV-PRM-2), and is withdrawn on the next run.
- INV-RUN-10 adds "continuing" to the runs that may not carry an initial Bash command.

No application concept is named. The requeue policy — which interrupted runs to continue, when,
and whether to ask a person — stays with the application.

## Alternatives

- **Restart interrupted runs on `open`.** Breaks INV-RUN-4, spends tokens nobody asked for, and
  repeats side effects. Rejected.
- **Record the history file path in `run.json`.** Would remove the `sessionDir` argument, but
  changes the stored record; the caller already owns and passes `sessionDir`.
- **Do nothing.** Each application re-derives the pins, and the model resumes blind.

## Consequences

- Hosts see one more `Recovery` field, one more method, one more `sessions.run` input and two new
  error codes.
- A continued run is an ordinary run with `resumedFromRunId` set.

## Migration

None. Runs interrupted before this change can be continued too: everything is derived from what
was already stored.

## Checks

`sessions/sessions.test.ts` ("continuing a run that stopped"), `sessions/runStore.test.ts` (ids
returned), `server/server.test.ts` (`runs.continuation`), `npm run prove` (startup changed).
