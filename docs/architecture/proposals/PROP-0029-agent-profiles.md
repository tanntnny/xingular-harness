---
id: PROP-0029
title: Agent profiles that subagents start from
status: Accepted; implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-2, INV-VAR-4, INV-CAP-1, INV-STO-3, INV-SRV-1, 02-sessions-and-runs.md, 03-variants.md, 04-prompt.md, 06-plugins-and-capabilities.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity, ADR-0030]
---

# PROP-0029: Agent profiles that subagents start from

## Problem

A subagent is either a copy of its parent or one of the parent variant's c5 definitions
(`sub_agents/<name>/AGENT.md`). A c5 definition carries instructions only: the child cannot have
its own tools, plugins, variant, model or effort (`subagentService.ts`, `spawn`). Nothing exists
outside a variant, so a person cannot keep a "worker" or an "explorer" of their own, and a
terminal session without a variant cannot name any subagent at all: the terminal never passed its
variant to `Subagents.register`, so `agent:` always failed with "There is no subagent named …".
The subagent roster could not say which kind of agent a child is.

## Affected rules

- INV-RUN-2: "A child run's set is the intersection of its parent's and what it asked for; it
  never widens."
- INV-VAR-4: "A run resolves its variant once and pins it; a child run or later turn uses the same
  files even if the head moves."
- INV-CAP-1: "A capability set only narrows."
- INV-STO-3: "A new top-level folder or a new file in `runs/<id>/` is an architecture change."
- INV-SRV-1: the method table (a new `agents` group).
- 02 Subagents contract: "`agent` names one of the parent harness's subagents (c5)".

## Proposal

**A profile** is a Markdown file with frontmatter. The body is the role instructions.

| Field | Meaning | Omitted |
|---|---|---|
| `name` | `^[a-z0-9][a-z0-9_-]*$`, equal to the file name | the file name |
| `description` | one line, shown to the model and in `/agents` | required |
| `color` | `blue green yellow red magenta cyan orange purple` | `blue` |
| `tools` | tool allowlist | every tool the parent has |
| `plugins` | plugin ids whose contributions the child keeps; required plugins always stay | all |
| `variant` | `<scope>`, `<scope>@<version>` or `none` | the parent's pinned variant |
| `model`, `effort` | the child's model and effort, on the parent's account | the parent's |

**Sources**, later ones winning by name:
1. Built-ins in code (`agents/builtin.ts`): `worker` and `explorer`.
2. `<data root>/agents/<name>.md` (global).
3. `<project root>/.xingular/agents/<name>.md`, where the project root is the nearest folder above
   the session's working folder that holds `.git`, or the working folder itself.

The parent variant's c5 definitions fill names nobody else took, as instruction-only profiles
(source `variant`), so existing variants keep working. An unreadable file is reported in
`problems` and hides nothing.

**Spawning.** `spawn_subagent { agent }` and `subagents.spawn { agent }` resolve a profile
(`agents/profiles.ts::resolveProfile`).
- Tools: the child's tools are the parent ceiling ∩ the profile's `tools` ∩ the call's `tools`.
  Profile tools the parent lacks are dropped and returned as `unavailableTools`.
- Plugins: the child's contributions are the parent's whose plugin is in `plugins` or required,
  and a tool whose owning plugin was dropped goes with it (`agents/narrow.ts`).
- Gated tools stay the parent's gated tools ∩ the child's, so a worker's edits still ask.
- Variant: a profile with `variant: <scope>[@version]` makes the child resolve and pin that variant
  when it starts. `none` and c5 definitions start the child with no variant; otherwise the child
  keeps the parent's pinned folder.
- The profile body becomes the child's `subagent` section, "Your role: <name>" (order 22).
- `RunRecord.profile` records the profile name on the child; it is absent for a copy.
- The spawn result adds `agent` and, when non-empty, `unavailableTools`.

**Prompt.** When a run may spawn, the compiler receives one `subagents` section (order 64) that
lists every profile with its description (`profileSection`). It replaces the variant's own c5
list, which it includes.

**Methods.** A new `agents` group: `agents.list { cwd? }` → `{ profiles, problems }`,
`agents.get { cwd?, name }`, `agents.create { cwd?, name, scope: global | project, from? }`
(the template, or a copy of `from`; never overwrites), `agents.remove { cwd?, name, scope }` (own
files only). The harness is the only writer of profile files. The terminal reaches the same
functions through `terminal.agents.list|create|remove`.

**Terminal.** `/agents` opens the Agents page: built-in, global, project and variant profiles,
unreadable files, and details. Enter on a row offers edit (opens `$VISUAL`/`$EDITOR`), copy and
delete for a person's own profile, and copy for a built-in. The subagent roster sits under the
status line after one blank line, without a heading; each row is the status mark, the profile
name in its colour (`subagent` for a copy), the child's session name (or its brief), and
`n of m tasks` from the child's own checklist. The terminal passes its pinned variant to
`Subagents.register`, so c5 names work there too.

## Alternatives

- **Profiles as variant data (c5 only).** Refinement could change them, but a person would need a
  variant to have a worker at all, and a variant cannot carry a model or plugin choice per child.
- **Store in `config/`.** One JSON file per data root is harder to edit by hand, cannot live in a
  repository, and would make `config/` a second enablement store (INV-PLG-6).
- **A shared task pool that subagents claim.** Considered with this change and rejected: it needs
  item ids, owners, locking and a new store, and is the delegated work queue the product keeps out
  of scope. Each run keeps its own checklist (PROP-0006); the roster shows each child's progress.
- **Do nothing.** Subagents stay copies, and the terminal cannot name any.

## Consequences

- Hosts see one optional `profile` field on run records, two optional fields on the spawn result,
  and a new `agents` method group.
- A profile can only narrow: a child never gains a tool, connector or contribution its parent
  lacks (INV-RUN-2 and INV-CAP-1 hold unchanged). Choosing another variant or model is not a
  capability and stays within the parent's account.
- A project profile comes from the repository, like `AGENTS.md`: its instructions are as trusted
  as the repository, and it cannot widen access.
- The prompt's subagent list now changes when a profile file changes, at the next run; a run that
  already started keeps its prompt.
- INV-VAR-4 reads: a child run uses the parent's pinned files unless its profile names another
  variant, which the child then resolves and pins itself.

## Migration

None. Existing c5 definitions appear as profiles of source `variant`. Removing the feature means
deleting `src/agents/` and the `agents/` folders; run records keep an unused field.

## Checks

`src/agents/profiles.test.ts`, `src/sessions/subagentService.test.ts` (profiles narrow, pin a
variant, record the name), `src/server/server.test.ts` (`agents.*`), the terminal roster, monitor
and Agents page tests, `npm run prove`, the App's checks, and a loopback PTY run that spawns an
explorer, a worker and a copy and reads the roster under the status line.
