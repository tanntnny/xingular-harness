---
id: PROP-0030
title: A parent-set title for each subagent, shown in the roster
status: Accepted; implemented
created: 2026-10-24
updated: 2026-10-24
affects: [02-sessions-and-runs.md, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, terminal-tui.md, 14-surfaces-and-parity.md, parity]
---

# PROP-0030: A parent-set title for each subagent, shown in the roster

## Problem

A live subagent row shows the child's `session_name` once the child calls it successfully, and
otherwise the whole brief (`subagentsWidget.ts`, `safe(item.name) || safe(item.goal)`). The brief
can run to 4000 characters, so the row shows a paragraph of instructions cut to the terminal width.
In a live run of two explorers, neither had a name, and both rows showed their briefs.

The child is the only one asked to name itself. The "six words at most" rule is in the
`session_name` tool description and the prompt, and nothing checks it. A child may skip the call,
or its call may fail, and the row then shows the brief for the whole run. The parent, which wrote
the brief, knows the purpose in a few words and names nothing.

## Affected rules

No invariant changes. The contracts that change are:

- `spawn_subagent` (page 07): a `title` parameter. The model must supply it.
- `subagents.spawn` (page 10): an optional `title`.
- The run record (page 02): an optional `title`, stored like `profile` (PROP-0029).
- The live roster and `/subagents` (page 11, `terminal-tui.md`): the row title is the parent's title.
- Parity (page 14, `parity.md`): the Subagents row names the title, not the child's session name.

## Proposal

- `spawn_subagent` takes `title`, a required string: one short imperative of at most six words,
  such as "Map the auth flow". It is checked the way `session_name` is: whitespace collapses, and
  control characters and empty values are refused with a message the model can act on.
- `subagents.spawn` takes an optional `title` with the same check. A host or script that omits it
  gets `briefTitle(brief)`: the first non-empty line of the brief, collapsed and capped at 60
  characters. The model cannot omit it.
- The child run record stores `title`, an optional text field (`RunRecord.title`). The spawn sets it
  before the child launches, and a startup failure keeps it. A record written before this change
  has no title and reads as `briefTitle(goal)`.
- The terminal roster, the `/subagents` label and its search read the title. The row no longer
  reads the child's `session_name`. The child still names its own Pi session with `session_name`,
  and that name stays in the child's session history.
- The transcript's `spawn_subagent` row shows the title, and the brief only when no title is given.

## Alternatives

- **Require the child to name itself.** This is the current design. The child must be prompted,
  and the rule is not checked. The screenshot shows it was skipped.
- **Make `title` optional in the tool.** A model skips an optional field the same way it skipped the
  child's name. Rejected: the tool requires it, and only programmatic callers may omit it.
- **Generate the title with an extra model call.** It costs a call and adds latency to every spawn.
  Rejected.
- **Keep the child's name first, then the parent's title.** A child that names itself would still
  replace the title the parent chose. Rejected: one source keeps the roster stable.
- **Do nothing.** Rows keep showing briefs whenever the child does not name itself.

## Consequences

- Applications built on the harness get a new required argument in `spawn_subagent`, and an
  optional one in `subagents.spawn`. A model that omits `title` gets an error and retries.
- The run record gains an optional field. Readers that ignore unknown fields are unaffected. The
  App reads run records in Rust and does not render the roster.
- The terminal monitor drops the child's `name` field. Its tests change with it.

## Migration

No data moves. Records without `title` read as `briefTitle(goal)`. The change can be undone by
removing the parameter; records written with `title` stay readable, because the field is optional.

## Checks

- `src/sessions/subagentService.test.ts`: the title is stored on the child run, and defaults from the
  brief's first line when omitted. An over-long title is refused.
- `src/tools/spawnSubagent.test.ts` (new): the tool refuses a missing or over-long title before it
  starts a child, and cleaning and the brief fallback behave as stated.
- `src/terminal/subagentMonitor.test.ts`: the row takes the parent's title, and the child's
  `session_name` does not change it.
- `src/terminal/opentui/subagentsWidget.test.ts` and `model.test.ts`: the row and the transcript row
  show the title.
- `npm run typecheck`, `npm test`, and `npm run prove` (the spawn path is server code), then the App's
  checks, because a harness change requires them.
