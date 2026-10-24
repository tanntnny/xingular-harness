---
id: ADR-0030
title: Agent profiles, one checklist per agent, and the subagent roster under the status line
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0029, PROP-0006, ADR-0003, INV-RUN-2, INV-CAP-1, INV-PAR-1]
---

# ADR-0030 — Agent profiles, one checklist per agent, and the subagent roster under the status line

## Context

People want to start subagents of a known kind, such as a worker that edits and an explorer that
only reads, and to follow their progress from the terminal. Subagents were copies of the parent
or instruction-only c5 definitions, the terminal did not register the checklist tool, and the
roster sat above the composer with a heading and no indication of each child's kind or progress.

## Decision

- Adopt [PROP-0029](../architecture/proposals/PROP-0029-agent-profiles.md): agent profiles are
  Markdown files (built-in, `<data root>/agents/`, `<project>/.xingular/agents/`, then c5 names)
  that a spawn resolves by name. A profile narrows tools and plugins and may choose a variant,
  model and effort. It never widens the parent's capabilities.
- Progress stays **one checklist per run** (PROP-0006). The parent's list is the plan the person
  watches. Each child keeps its own list, and the roster shows its `n of m tasks`. There is no
  shared, claimable task pool.
- The terminal registers `checklist_write`, shows each write as a checklist block, and the prompt's
  Progress group asks the model to keep it current because the person follows work from it.
- The roster sits under the status line after one blank line, with no heading. Each row reads: status
  mark, profile name in its colour, session name, tasks.

## Consequences

Profiles are a foundation feature, not variant data: refinement does not change them. A project
can carry profiles in its repository. The App gets the same capability through `agents.*` and
`RunRecord.profile`; it has no Agents screen yet (parity `planned`).

## Verification

Unit tests for profiles, narrowing, spawn, the monitor, the roster and the Agents page;
`npm run prove`; and a loopback PTY run that checks the blank row under the status line, the row
order, and the profile colours.
