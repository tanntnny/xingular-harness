---
id: ADR-0043
title: A parent continues its stopped subagents; the monitor shows the main agent and survives reopening
status: Accepted
created: 2026-10-27
---

# ADR-0043: A parent continues its stopped subagents

## Decision

- `spawn_subagent { continue: <runId> }` (and `subagents.spawn { continue }`) continues a child that
  stopped before finishing (`interrupted` or `failed`, with saved history). It is a new child run
  with `continueFrom`. It reopens the first link's history folder
  (`<parent sessionDir>/subagents/<first child run id>`) and keeps the earlier child's session id,
  profile, title, goal, account, variant version and frozen capability set. That set must still lie
  within the parent's ceiling; `agent` and `tools` are refused with `continue`. The id may name any
  link of a chain: the newest link is the one continued, and an active or completed newest link is
  refused.
- The model decides. A subagent never continues itself, and a restarted harness never restarts
  model work (INV-RUN-4). Children an earlier reply left stopped are delivered **before** the next
  reply's first request: a hidden `xingular-subagent-results` message with a receipt, which says
  each child can be continued. A stopped child that has a continuation is reported through that
  continuation instead.
- Recovery of an earlier parent's children is keyed on the native history branch: the owner
  marker, the same native history id, account, agent, project and working folder. The Harness
  session id is not compared, because a host may give each launch of one conversation a new one.
- `main` is a reserved profile name. The terminal monitor projects the parent run itself as a
  `main` row: account, model, effort, usage, activity and todo counts, like a child. The
  `/subagents` page shows it pinned first; the rows under the status line omit it.
- The terminal marks every turn's run on the branch (`xingular-subagent-owner`). When a
  conversation opens with no run active, it rebuilds the monitor from the branch's latest parent
  run in that folder and its descendants, by folding their saved events. The rows keep their final
  status until the next run begins.
- Run records carry the launch `model` and `effort` (the opened session's model supersedes the
  selection), so a rebuilt row can show them.

## Rationale

Esc on a parent interrupts every child, and until now the next turn was told to start them again.
That lost work that was saved on disk. Reopening a child's own history keeps every pin a run
already has, so no capability or account can change, and leaving the choice to the model keeps
INV-RUN-4.

## Consequences

The monitor stays a private, read-only terminal projection; no event or public method is added.
Records written before this change have no `model` or `effort`, and their rebuilt rows show `—`.
A person cannot continue a child from the page directly; they ask the parent.
