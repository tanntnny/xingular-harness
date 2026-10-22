---
id: PROP-0006
title: A run checklist the model writes, recorded as a run event
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 07-tools-and-gate.md, 10-server-protocol.md]
---

# PROP-0006: A run checklist the model writes, recorded as a run event

## Problem

A run has no structured record of progress. `goal` on a run is opaque text, and plan mode ends
with a `<proposed_plan>` block that lives only in message text (`sessions/planMode.ts`). An
application that wants to show "step 3 of 5", and a later run that wants to pick up where an
earlier one stopped, can only read prose. Every studied peer with long work has a model-written
list for this: deepseek-harness `todo_write` (whole-list replace, three statuses, a log-only
session event, replay projection), OpenCode `todowrite`, and Claude Code's descendant of it.
Gap #2 of `docs/study/feature-gap-review.md`.

## Affected rules

- 02 Contracts, the run-event list (`runEventTypeSchema`).
- 07 The list of harness tools ("Harness tools: `history_search`, … `ask_user`").
- 06 `HARNESS_PLUGINS` ("`pi`, `harness`, `subagents`, `wiki`, `history`, `ask-user`, `connected-apps`").
- INV-PLG-5: anything the model can see is declared by a plugin.
- INV-BND-2: no application concept — the tool is named "checklist", not "task" or "todo list
  of tasks".

## Proposal

- New run event `checklist.updated`, payload `{ items: { text, status }[] }`, `status` one of
  `pending`, `in_progress`, `completed`; at most 50 items of 1–500 characters. The latest event is
  the whole checklist (last write wins); items have no ids.
- New harness tool `checklist_write` (`tools/checklist.ts`), given with `ask_user` whenever
  `harnessTools` is not `false`. It emits through the live run, so the event is validated,
  persisted and then relayed (INV-RUN-3). It is `readOnly` for the gate: it changes only the
  run's own record, so plan mode allows it. Its description carries the usage rules (three or
  more steps, exactly one `in_progress`, complete immediately), following "tool interfaces are
  where public instruction lives" (study insight 4).
- New built-in plugin `checklist` declares the tool.
- `checklistOf(events)` projects the latest list; the server exposes it as `runs.checklist`.
- Terminal sessions do not get the tool yet.

## Alternatives

- **A side file `runs/<id>/checklist.json`.** A new writer under `runs/<id>/` (INV-RUN-6) and a
  second source of truth beside the events. Rejected; the event log already replays.
- **Parse `<proposed_plan>`.** Only plan mode produces it, and it carries no status.
- **Leave it to the application as a tool provider.** Every application would rebuild the same
  generic tool, and continuation (PROP-0007) could not read it. Do nothing was rejected for the
  same reason.

## Consequences

- Applications see one more event kind; hosts that validate event types must accept it.
- One more tool in every session's default list, after `ask_user`.

## Migration

None: old runs have no `checklist.updated` events and read as an empty list. Removing the tool
later leaves old events readable.

## Checks

`tools/checklist.test.ts`, `sessions/sessions.test.ts` (default list, plan mode, `harnessTools:
false`), `plugins/catalogue.test.ts`, `server/server.test.ts` (`runs.checklist`).
