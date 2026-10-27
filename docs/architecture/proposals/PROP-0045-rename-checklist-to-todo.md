---
id: PROP-0045
title: Rename the run checklist to todo and add the /todo command
status: Accepted; implemented
created: 2026-10-26
updated: 2026-10-26
affects: [02-sessions-and-runs.md, 04-prompt.md, 06-plugins-and-capabilities.md, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, parity.md, terminal-tui.md, README.md, PROP-0006]
---

# PROP-0045: Rename the run checklist to todo and add the /todo command

## Problem

One run concept is named "checklist": the `checklist_write` tool, its `checklist.updated` event,
`ChecklistItem`, `checklistOf`, the `todo` list's `runs.checklist` method, the `checklist` field of
`runs.continuation`, the `checklist` plugin, and the terminal's checklist block and `checklist`
telemetry. Every agent framework a person meets elsewhere calls the same idea a todo list, and
Claude Code's `/todos` made the word familiar: `todo`, `todo_write`, `/todo`. PROP-0006 chose
"checklist" explicitly to avoid an application concept (`PROP-0006-run-checklist.md:28`), but
"todo" is generic vocabulary, not a product name, and the current name makes the tool harder to
recognise for both the model and the person.

The list is also only visible where the model last wrote it: the terminal transcript and (nowhere) in
the App. A person who scrolled past a write, resumed a session, or is watching a long reply has no
way to ask for the current list. The terminal already has a slash-command surface for this kind of
read (`/help`, `/subagents`, `/trajectory`); there is no `/todo`.

## Affected rules

- **02-sessions-and-runs.md, Data** defines `checklist.updated` and `checklistOf(events)`.
- **04-prompt.md** defines the Progress paragraph that names `checklist_write`.
- **07-tools-and-gate.md** defines `checklistTool` and its event.
- **10-server-protocol.md** defines `runs.checklist`.
- **11-terminal.md** defines the checklist block, the telemetry call and the terminal's tool.
- **14-surfaces-and-parity.md** and **parity.md** (PAR-001) define the terminal and App surfaces.
- No invariant's rule changes: the tool remains read-only and plan-safe, the event remains a
  whole-list replacement, and the list remains one bounded run event. Only the names and one added
  read command change.

## Proposal

### 1. The concept is named todo

| Was | Becomes |
|---|---|
| tool `checklist_write` | `todo_write` |
| event `checklist.updated` | `todo.updated` |
| `ChecklistItem`, `checklistItemSchema`, `MAX_CHECKLIST_ITEMS` | `TodoItem`, `todoItemSchema`, `MAX_TODO_ITEMS` |
| `checklistOf`, `describeChecklist`, `checklistTool` | `todoOf`, `describeTodo`, `todoTool` |
| plugin id `checklist`, title "Checklist" | plugin id `todo`, title "Todo" |
| method `runs.checklist { runId }` | `runs.todo { runId }` |
| `Continuation.checklist` | `Continuation.todo` |
| terminal telemetry `checklist` | `terminal.todo` |
| transcript kind `checklist`, header "Checklist" | kind `todo`, header "Todo" |
| `TerminalSubagentActivity.checklist` | `.todo` |

The tool keeps its behaviour: the model sends the whole list, the latest event replaces every
earlier one, at most 50 items, `pending`, `in_progress` and `completed`, read-only for the gate and
allowed in plan mode. The prompt's Progress paragraph asks for a todo list in the same places.

### 2. `/todo` shows the current list

`/todo` is a core command (`src/commands/registry.ts`), `group: 'Inspect'`, `kind: 'session'`,
`methods: ['runs.todo']`, with `/checklist` as a compatibility alias for one release.

- It reads the latest non-side-question run of the current native session and returns that run's
  latest todo. It makes no model request, asks for no approval, and is available in plan mode.
- The terminal appends a snapshot card to the transcript: `Todo · n of m done`, then one row per
  item with the existing glyphs and colours (`✓` completed, `●` in progress, `○` pending). An empty
  list is a one-line notice, not an empty card.
- The App offers the same read through `runs.todo` as a read-only picker with the same marks. It does
  not render each `todo_write` in its transcript; that presentation difference is recorded in
  PAR-001.

### 3. Compatibility

Stored run events are never rewritten. For one minor release:

- `runEventTypeSchema` accepts `checklist.updated` beside `todo.updated`, both with the same payload;
  `todoOf` reads both. New events are written only as `todo.updated`.
- A replayed native history whose tool call is `checklist_write` still renders the todo card.
- `runs.checklist` remains as a deprecated alias returning the same list as `runs.todo`.
- `runs.continuation` returns `todo` and keeps `checklist` as a deprecated mirror field.
- A pinned capability set containing `checklist_write` is read as `todo_write`, so an interrupted
  run recorded before the rename can still continue with a todo tool.
- The exported `checklistOf` and `CHECKLIST_WRITE` names stay as deprecated aliases for embedders.

The aliases and the legacy event type can be removed in the next major release.

## Alternatives

- **Rename only the labels the person sees.** Rejected: the tool name the model sees, the event, the
  method and the docs would disagree, which is the drift the specification exists to prevent.
- **Keep both names indefinitely.** Rejected: two names for one concept in the prompt and the
  protocol, and a permanent compatibility branch. One release is enough for stored data that is
  never rewritten.
- **Rewrite stored events to the new type.** Rejected: `events.jsonl` is append-only evidence; a
  read alias is enough and cannot corrupt a run.
- **Make `/todo` a live panel or a full-screen page.** Rejected for this change: a transcript
  snapshot matches `/help`, reuses the existing block, and leaves the person's scrollback intact.
  A live panel can be a later presentation change; it is not needed to show the list.
- **Do nothing.** Rejected by the owner's request and by the missing read surface.

## Consequences

- One tool name and one prompt paragraph change, so the compiled tool manifest and the provider
  cache prefix change once. The cost is measurable only with real requests (`INV-PRM-8`), and the
  change does not alter any model-visible behaviour besides the name.
- Applications built on the harness keep working through the method, field and capability aliases;
  they should move to the new names. The App's event schema accepts both event types, so old run logs
  keep displaying.
- Runs created before the rename keep their recorded events. `todoOf` and the terminal renderer read
  them without a rewrite.
- PAR-001 narrows: both surfaces can now show the current todo; the App still does not draw an inline
  block for each write.

## Migration

No data migration and no file rewrite. Old events, old pinned capability sets and old native
histories are read through the aliases above. Rolling back is reverting the commit; new
`todo.updated` events would then need a reverse alias if they were already written, so the rollback
is safe only before new runs write the event.

## Checks

- `npm run typecheck`, `npm test`, `npm run prove`.
- New tests: the todo tool, a legacy `checklist.updated` read, a legacy pinned capability, the
  `runs.todo` method and its alias, the terminal `/todo` card, and a replayed `checklist_write` call.
- `python3 scripts/verify-terminal.py --todo-only` at 80x24 and 100x30: the card, the alignment of
  wrapped rows, and no model request for `/todo`.
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`,
  `cd src-tauri && cargo test`.
