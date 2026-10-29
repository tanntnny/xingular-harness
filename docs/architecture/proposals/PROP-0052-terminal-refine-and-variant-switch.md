---
id: PROP-0052
title: Refine from the terminal, version checkpoints, and switching a conversation's variant
status: Implemented
created: 2026-10-30
updated: 2026-10-30
affects: [INV-VAR-4, INV-RUN-1, INV-REF-1, INV-REF-2, INV-PRM-1, 02-sessions-and-runs.md, 03-variants.md, 04-prompt.md, 05-refinement.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity, ADR-0065, ADR-0066]
---

# PROP-0052: Refine from the terminal, version checkpoints, and switching a conversation's variant

## Problem

The harness has the whole Harness² method (page 05) and versioned variants (page 03), but a person
in the terminal could not use them in the loop they work in:

- Refinement needed a task file (`xagent refine run --task`), and its executions started from a copy
  of a source folder. A request a person had just made in their repository could not be replayed.
- A person could not say where to look. Improvers read every trajectory with no focus, even when the
  person already knew the agent's weak spot.
- The terminal showed versions but could not restore one, name one, or take back one component
  from an earlier version.
- `INV-VAR-4` pinned a conversation's variant for its whole life: an adopted improvement reached only
  a new conversation.
- A version did not say which model it was tuned on, although a variant tuned for one model can
  hurt another.

## Proposal

**Checkpoints (page 03).** A scope gains tags, `name → fingerprint` in `tags.json`: labels that
can move, never versions (`INV-VAR-3` holds). A reference is a fingerprint, a unique prefix, a tag,
or `head`. `revertComponents` makes a new version from the head with chosen components taken from
an earlier version; a selector is a component (`c4`, `toolGuidance`) or one item by path prefix
(`skills/review`). It commits through the validator like any edit. A version made by adopting a
refinement records `tunedFor: { model }`, the model its execution ran on.

**Switching a conversation's version (ADR-0065).** `INV-VAR-4` changes: a later turn of a
conversation uses the conversation's selected version, which changes only by the person's action
(adopt, restore, revert, or choosing a version) and only at a turn boundary. The terminal frontend
receives its compiled prompt, skills and plugins at launch, so a switch restarts the frontend on
the chosen version and resumes the same native conversation, through the relaunch path the account
switch already uses. Every run still pins one version for its whole life (`INV-RUN-1` unchanged);
the prompt pack is compiled again for the new version, which costs the provider cache once.

**Turn snapshots (ADR-0066).** At the start of each turn a person types in a git repository, the
harness records `workspaceSnapshot: { repo, commit, omitted? }` on the run: a commit made through a
throwaway index from tracked edits and bounded untracked files (5 MB a file, 100 MB, 10,000 files),
with the working tree, the real index, HEAD and refs untouched. It is bounded to two seconds; a slow
or failed snapshot records nothing and the turn goes on.

**Replay and guidance (page 05, ADR-0066).** `refine.fromRun` builds a task from a recorded turn
or a session's latest typed turn: its request text, the variant scope it ran, and its snapshot as
`task.workspace`. The default `RefineHost` prepares each execution as a `--shared` clone of that
snapshot in a temporary folder, so the person's repository gains no worktree, ref or file. A task
may carry `guidance` (at most 2,000 characters, refused when it names measurement): a focus block
in the INV, DOM, aggregate and compose missions that directs attention, not conclusions, and keeps
`KEEP_BASE` valid. It never reaches the selector or the reflector. The budget identity is unchanged.

**Terminal.** `/refine [--k N] [--mode m] [--model id] [--executor-model id] [guidance]` shows the
request, focus, run count and models, asks for confirmation, then runs in the background with a
status item; `/refine status | stop | review`. Review lists every candidate with the selector's pick
marked, shows its changes and output, and adopts any one (optionally tagging it), then switches the
conversation. Task runs default to this chat's model. `/variant` lists versions and offers switch,
restore, compare, tag and take-components; `/variant use|restore|tag|untag|diff|revert` are the
typed forms.

## Surfaces

Every capability is a Harness method (`variants.tag`, `variants.untag`, `variants.tags`,
`variants.resolve`, `variants.revert`, `refine.fromRun`, `refine.candidateDiff`,
`refine.candidateOutput`, `refine.adopt` with `tag`) with a terminal surface (`/variant`,
`/refine`). The App's `/refine` and `/variant` open its Harness screen for now; replaying a turn
from the App and switching an App conversation's version are App follow-ups (PAR-004).

## Alternatives

- **Hot reload inside the running frontend.** Pi's `reload` re-reads the paths the frontend was
  launched with, and the harness refuses a changed variant there by design. Restarting on the
  version reuses a tested path and keeps the conversation.
- **Follow the head automatically.** A head moved by another client or another terminal would
  change this conversation under the person. Only this session's own action switches it.
- **Replay from the current folder.** The agent already did the work, so the answer would be in the
  workspace. A HEAD worktree loses uncommitted work. The snapshot is the only honest start.
- **Register a git worktree for each execution.** It writes into the person's repository; a shared
  clone only reads its object store.
- **Let guidance steer the selector.** A person's hunch would then outvote the evidence; the blind
  selector stays answer-free (`INV-REF-2`).
- **Do nothing.** Refinement stays a batch tool nobody runs on their real work.

## Consequences

- Run records gain the optional `workspaceSnapshot`; version records the optional `tunedFor`;
  lineage rows carry `tags`. Existing readers ignore the new fields.
- A git repository used with the harness accumulates unreferenced snapshot objects, which git's
  garbage collection removes in time.
- A terminal's harness session id changes when it restarts on another version; the native
  conversation stays, and `refine.fromRun` also finds a turn by its native session.

## Migration

None. Old runs have no snapshot and cannot be replayed; old versions have no tags or `tunedFor`.
Removing the feature leaves the extra fields unread.

## Checks

Store tests (tags, references, revert, `tunedFor`), snapshot tests (tree, index and HEAD untouched;
racy same-second edits; bounds), replay-host tests (clone leaves the repository alone; deletions
and new files reproduced), mission tests (guidance in improver and composer missions only, in both
modes, with the budget identity), terminal control tests, and a standalone test that a switch
restarts on a version that is not the head. `npm run typecheck`, `npm test`, `npm run prove`, and the
App's checks.
