---
id: ADR-0066
title: Refinement replays a typed turn from its snapshot, and a person's guidance reaches improvers only
status: Accepted
created: 2026-10-30
---

# ADR-0066: Refinement replays a typed turn from its snapshot, and a person's guidance reaches improvers only

## Context

Refinement needs a task it can run several times from the same start. For a request a person made
in their repository, the folder as it is now already holds the agent's answer, and the repository's
HEAD lacks the person's uncommitted work. People also know where their agent goes wrong and want to
point improvers there (PROP-0052).

## Decision

- **Snapshot each typed turn.** In a git repository, before the agent acts, the harness writes a
  commit of the working tree through a throwaway index (tracked edits, deletions, and untracked
  files within 5 MB each, 100 MB and 10,000 files) and records it on the run. It never touches the
  working tree, the real index, HEAD or refs, and it gives up after two seconds. The temporary index
  keeps the real index's time, so git still sees an edit made in the same second that kept a file's
  size.
- **Replay in a shared clone.** Each execution works in a temporary `--shared` clone checked out at
  the snapshot, with HEAD and the index at the turn's starting commit. Ignored files named by
  `.worktreeinclude` are copied from the repository.
- **Guidance directs improvers, not choices.** `task.guidance` is checked like work prompts (no
  measurement words) and capped at 2,000 characters. It is added to the INV, DOM, aggregate and
  compose missions as where to look first; an edit must still trace to a trajectory and `KEEP_BASE`
  stays valid. The selector and the reflector never see it (`INV-REF-1`, `INV-REF-2`).

## Consequences

A replay cannot reach what the snapshot left out (ignored files not listed for worktrees, large
untracked files, attachments); `refine.fromRun` says so before the person confirms. Repositories gain
unreferenced objects that git collects in time.
