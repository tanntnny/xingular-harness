---
id: PROP-0016
title: Managed git worktrees as a Harness capability, in the terminal and every host
status: Implemented
created: 2026-10-23
updated: 2026-10-23
affects: [INV-BND-2, D-5, INV-STO-3, INV-SRV-1, 00-overview.md, 02-sessions-and-runs.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md]
---

# PROP-0016: Managed git worktrees

Accepted by the user's approval of the parity plan on 2026-10-23 (PROP-0015, ADR-0017).
Implemented in the working tree on 2026-10-23: `src/worktrees/`, `Sessions.run`, `Terminals`,
`xharness --worktree`, `xharness worktree`, `/worktree`; spec pages 00, 02, 10, 11, 12 updated.
The App source has create integration; remaining App actions are tracked as PAR-012. Harness and
terminal implementation is included in the 4.0.0 candidate. The owner chose the Codex model:
managed, disposable worktrees with automatic pruning and a handoff back to the main checkout.

## Problem

Worktrees exist only in the App (`App/src-tauri/src/projects.rs`: `create_worktree`,
`list_worktrees`), with no removal, so thread, task and Solo worktrees accumulate. The terminal
runs in its launch folder only (`terminal/standalone.ts`), with no way to isolate a session's
edits. `RunRecord.worktreeId` is an opaque App field (drift D-5). Under INV-PAR-1 a capability a
person uses must be a Harness capability with a terminal surface.

## Affected rules

- 00-overview "Stays in the application: … projects and worktrees …".
- `INV-BND-2` lists "worktree" as an application concept.
- Drift D-5: `RunRecord` carries `worktreeId` and `handoffId`, which are application concepts.
- `INV-STO-3`: a new top-level folder is an architecture change.
- `INV-SRV-1`: a new method group.

## Proposal

### Model

A **worktree** is a linked git worktree of a repository (the *source checkout*) that the Harness
created or adopted. It has an id, a repository root, a path, a name, a branch or a detached HEAD,
the ref and commit it started from, a kind and an origin.

- **Managed** worktrees (the default) are disposable, usually one per session, on a detached HEAD.
  They are pruned automatically.
- **Permanent** worktrees are named, may host several sessions, and are never pruned.
- **Create branch** gives a worktree a branch under a configurable prefix (default `wt/`).

### Creation

`create({ repo, name?, baseRef?, kind?, carryChanges? })`:

1. Resolve the source checkout's top level; refuse a folder that is not a git repository with at
   least one commit.
2. `git worktree add --detach <path> <baseRef>` (default `HEAD`), with repository filter drivers
   switched off (`GIT_LFS_SKIP_SMUDGE=1`, `-c filter.lfs.*` cleared), never through a shell.
3. When `carryChanges` (default true for `baseRef: HEAD`), apply the source checkout's
   uncommitted tracked changes (`git diff HEAD --binary` piped to `git apply`) and copy its
   untracked, non-ignored files, as Codex does.
4. Copy ignored files matched by `.worktreeinclude` (gitignore syntax, matched by git itself). A
   file is copied only when it does not exist in the worktree; symlinks are skipped; a per-file
   (5 MB) and total (100 MB) cap applies; the result lists what was copied and skipped.
5. Run the repository's setup script `.xharness/worktree-setup` when it exists and its exact text
   is trusted by hash (`worktrees.setup.trust`). It runs with `HARNESS_WORKTREE_PATH`,
   `HARNESS_WORKTREE_SOURCE`, `HARNESS_WORKTREE_NAME`, a 10-minute timeout, and its output in a log
   file. An untrusted script is reported, never run.

### Lifecycle

- **Lease and lock.** A session that runs in a worktree holds a lease (session id, process id) and
  `git worktree lock --reason`. The lease is released on dispose; a lease whose process is gone is
  released on `open` (recovery).
- **Prune.** `prune({ keep })` keeps the `keep` (default 15) most recently used managed worktrees
  per repository and removes older ones that hold no lease. Permanent, leased and locked-by-others
  worktrees are never pruned.
- **Snapshot before removal.** Every removal of a worktree with uncommitted changes or commits not
  on any other branch first records them: `git stash create` (with untracked files committed into a
  temporary index) and `git update-ref refs/xharness/snapshots/<id> <commit>`. `restore({ id })`
  recreates the worktree from its snapshot.
- **Remove.** `remove({ id, force? })` refuses a leased worktree, and refuses dirty work unless
  `force`, in which case it snapshots first.
- **Handoff.** `handoff({ id, direction: 'toSource' | 'toWorktree' })` moves uncommitted changes
  between the worktree and the source checkout through git (`diff --binary` and `apply --3way`,
  plus untracked files). It refuses when the target has uncommitted changes, when a branch would be
  checked out twice, or when the patch does not apply cleanly; nothing is changed on refusal.
- **Adopt.** `adopt({ path })` registers an existing linked worktree (for example ones a host
  created earlier) with origin `adopted`. It moves nothing.

### Sessions and runs

`SessionRunInput` and `TerminalPrepareInput` accept `worktreeId`. The Harness resolves the working
folder from the registry, takes the lease, and records `RunRecord.worktreeId`, which now has
Harness meaning. A caller that passes a folder without `worktreeId` behaves as before. D-5 narrows
to `handoffId`.

### Storage

```text
<state dir>/worktrees.json                         registry, owner: worktrees/registry.ts
<state dir>/worktrees/<repoKey>/<name>/            checkouts (device-local)
<state dir>/worktrees/logs/<id>.setup.log          setup output
<state dir>/worktree-setup-trust.json              trusted setup-script hashes, owner-only
```

`repoKey` is a slug of the source folder's name and a short hash of its real path. Checkouts are
device-local and may be large, so they live in the state directory (`INV-STO-1`). A host may set
`HarnessOptions.worktrees = { root?, branchPrefix?, keep? }`.

### Server methods

New group `worktrees`: `list { repo? }`, `status { id }`, `create`, `branch { id, name }`,
`handoff { id, direction }`, `remove { id, force? }`, `restore { id }`, `prune { repo?, keep? }`,
`adopt { path }`, `setup.trust { repo, hash }`. Terminal equivalents use the control key
(INV-TUI-4).

### Terminal

- `xharness --worktree [name]` (`-w`) starts the terminal in a new managed worktree of the current
  repository (or reuses the named one).
- `xharness worktree list|new|rm|prune|adopt|restore`.
- `/worktree` opens a page: list with branch, changes and last use; actions new, switch, create
  branch, hand off, remove, restore, prune, trust setup script. Switching uses the terminal
  relaunch loop with the new folder.

### INV-BND-2

"worktree" leaves the list of application concepts; a worktree is now a Harness object.

## Alternatives

- **Keep worktrees in the App.** Breaks INV-PAR-1; the terminal could not isolate a session.
- **Claude Code's opt-in named worktrees only.** The owner chose Codex's managed model; named
  permanent worktrees are kept as the second kind.
- **Inside the repository** (`.claude/worktrees`, `.agents/worktrees`). Puts large device-local
  folders where editors and tools index them; the state directory avoids that.
- **Copy-on-write clones** (omp). Faster for large ignored folders but platform-specific; left for
  a later option.

## Consequences

- Hosts call `worktrees.*` instead of running git themselves. The App's `projects.rs` worktree
  code is replaced; its existing worktrees can be adopted on the person's command.
- New folders in the state directory; no data-root change.
- The terminal gains a command-line flag, a command and a page.

## Migration

Nothing moves automatically. `adopt` registers existing worktrees when a person asks. The change
can be undone by removing the registry; checkouts stay valid git worktrees.

## Checks

Unit tests on temporary repositories: create (detached, branch, carry changes), include copy (no
overwrite, symlink skip, caps), setup trust gate, lease and lock, recovery of a stale lease, prune
order and protection, snapshot and restore, remove refusal, handoff both ways and its refusals,
adopt. Terminal page model tests. `npm run typecheck`, `npm test`, `npm run prove`, and the App's
checks.
