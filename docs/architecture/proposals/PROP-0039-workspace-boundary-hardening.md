---
id: PROP-0039
title: Harden workspace writes against inode escapes and unverified retries
status: Accepted
created: 2026-10-26
updated: 2026-10-26
affects: [INV-GATE-3, INV-GATE-8, INV-TUI-8, 02-sessions-and-runs.md, 07-tools-and-gate.md, 11-terminal.md, 14-surfaces-and-parity.md, parity]
---

# PROP-0039: Harden workspace writes against inode escapes and unverified retries

## Problem

PROP-0037 promises that model-controlled writes stay inside the pinned workspace unless a person
approves an escape. The current implementation checks canonical pathnames, but Pi performs native
`write` and `edit` operations afterward using ordinary filesystem calls. A hard link keeps an
in-workspace pathname while sharing an outside inode, and a parent symlink can change after the
check. Source review found both cases can bypass the intended approval boundary.

The Bash sandbox also exposes the live workspace as a writable path. A macOS integration
reproduction created a hard link from a file outside the workspace to a name inside it, then ran a
sandboxed Bash write through the in-workspace name. The command succeeded and the outside alias
contained the new content. Linux behavior has not yet been reproduced locally.

Finally, `workspaceSandbox.ts` infers a sandbox denial from matching text anywhere in captured
stdout/stderr. A command controls that output; the text can prompt for an unconfined retry even when
no sandbox denial occurred. Approval is still required, but the prompt's reason is not verified and
approval replays the entire command.

A separate launcher-selection issue was fixed in the 1.2.0 working tree: the sandbox launcher now
comes only from fixed system paths, with a fake-PATH regression test. This does not resolve the
remaining findings. No candidate, tag, or publication has been created.

## Affected rules

- **INV-GATE-3**, as it stands: “Bash first passes the gate's scope and authorization, then executes
  only inside the OS sandbox; a detected write denial may enter a separate one-shot approval before
  retry. The policy may tighten or deny a call, but cannot waive the boundary. Outside file writes
  and sandbox-denied Bash retries cannot use remembered per-tool approval; only the eligible Full
  Permission switch can answer automatically.” The output-triggered retry is replaced by an
  explicit pre-execution scope request.
- **INV-GATE-8**, as it stands: “Native reads are bounded by process and operating-system
  permissions, not by the workspace root; absolute and `~` paths are valid. Every run pins its
  canonical `workspaceRoot`. Native `edit` and `write` targets must resolve inside it by default,
  with symlink escapes refused; outside targets require one-call approval and cannot use remembered
  tool grants. Bash, including the initial `!` command, is OS-sandboxed to write only inside that
  root while retaining broad reads. Sandbox denial permits at most one retry after explicit
  approval. Full Permission is the only standing boundary bypass and remains subject to host
  policy, authorization, and read-only, plan, unattended, probe, improver and reflection
  restrictions. Missing enforcement fails closed.” The rule must define containment by the actual
  filesystem effect, not just the path string.
- **INV-TUI-8**: the terminal must present the same safe write and pre-execution approval behavior
  as SDK sessions.

## Proposal

1. **Keep workspace-only as the default.** Each run continues to pin its canonical workspace root.
   Reads remain broad as today.
2. **Enforce native writes at the operation.** Harness supplies the `write` and `edit` tools with
   safe filesystem operations instead of delegating their mutations to Pi's default in-place
   `fsWriteFile`. The operation revalidates the pinned target and performs an atomic replacement
   under the OS-enforced workspace boundary. Replacing the in-workspace directory entry rather
   than truncating a shared inode prevents a hard-link alias from changing an outside file. A
   symlink or parent-directory swap cannot widen the operation's OS write scope. Outside targets
   retain their existing human-only, one-call approval; the helper receives only that approved
   canonical target. Tool names and model-facing schemas stay the same.
3. **Fail closed on external hard links for sandboxed Bash.** Before a default Bash call, inspect the
   workspace for regular-file inodes whose link count exceeds the names found inside the workspace.
   If the scan is incomplete or finds a possible outside alias, do not run the command; explain that
   the alias must be removed or copied. The OS sandbox must also prevent the model's sandboxed
   processes from creating a cross-boundary hard link. If a backend cannot establish both
   conditions, it fails closed. A local process outside Harness with the same user's filesystem
   permissions is not controlled by this rule; if protection from such peer processes is required,
   that needs a separate inode-isolated workspace/snapshot design.
4. **Ask before broad Bash writes, never infer from output.** Add an explicit
   `workspaceWriteScope` choice to the Harness-owned Bash call, defaulting to `workspace`. A call
   requesting `outside` is approved before it runs, as a human-only, nonrememberable operation; the
   approval presentation must expose the complete command (scrollable in the terminal). The
   eligible Full Permission switch may answer only under its existing restrictions. After approval,
   run that exact command once with broader filesystem access. stdout/stderr text never triggers
   approval or an automatic retry, and a denied command is never replayed after partial effects.
5. **Keep other gates intact.** Plan, read-only, unattended, probe, improver and reflection
   restrictions, host policy, authorization, and the tool capability set remain in force. Outside
   writes and broad Bash calls cannot use remembered per-tool grants.

## Alternatives

- **Keep pathname checks and the output regex.** Rejected: hard links are invisible to `realpath`,
  native operations race after validation, and command output is not evidence of a sandbox event.
- **Only reject files with `nlink > 1` for native writes.** Rejected: a link can be added after the
  check, and the native operation remains subject to path swaps.
- **Run every shell call in a private copy-on-write workspace and commit changes back.** This gives
  stronger inode isolation, including against peer processes, but changes shell visibility,
  writeback/conflict behavior, metadata, storage use, and performance. It remains the alternative
  if protection from same-user processes outside Harness is required.
- **Remove all outside-write capability.** Rejected for now: the existing contract intentionally
  supports explicitly approved escapes. The proposed pre-execution request preserves that choice
  without guessing from output.
- **Do nothing.** Leaves the default workspace boundary bypassable.

## Consequences

- The public server protocol and stored `RunRecord` layout need no new fields. The Bash tool schema
  gains an optional scope choice; existing calls default to the current workspace-only behavior.
- SDK sessions and the standalone terminal must register the same safe native tools and apply the
  same pre-execution Bash gate. Terminal approval remains available through its existing inbox.
- Atomic replacement changes the inode for a written path. The implementation must preserve normal
  file mode behavior where possible and document any platform metadata that cannot be retained.
- Reject the filesystem root as an active workspace; otherwise every path is inside the pinned root
  and the boundary provides no containment.
- A workspace containing a possible external hard link cannot use default sandboxed Bash until it
  is repaired. Explicit outside scope remains a separate, visible approval, not a way to silently
  reuse remembered grants.
- The boundary protects model-controlled operations inside Harness. Other local processes running
  with the same user's filesystem permissions remain outside this proposal's protection. On macOS,
  the OS sandbox denies all hard-link creation by sandboxed Bash, including links entirely inside the
  workspace.

## Migration

No stored runs or workspace data are rewritten. Old sessions continue to pin the same workspace
root. Existing Bash calls omit `workspaceWriteScope` and therefore remain workspace-only; a command
that needs broader writes must be issued again with an explicit outside scope and approved before
execution. Existing outside-write approvals remain per-call and are not migrated into standing
grants.

## Checks

- Add adversarial tests for native hard-link writes, symlink/parent swaps between validation and
  mutation, shell writes through pre-existing external hard links, and cross-boundary hard-link
  creation on macOS and Linux.
- Verify command output containing denial-like text cannot request approval or rerun a command;
  verify explicit outside scope asks before execution and runs at most once after approval.
- Verify the complete requested command is visible in outside-scope approval details, and Full
  Permission and all read-only, plan, unattended, refinement, authorization, and host policy
  restrictions remain intact in SDK and terminal paths.
- Run Harness `npm run typecheck`, `npm test`, and `npm run prove`; run the App compatibility checks
  and inspect the relevant terminal behavior. Exercise the sandbox integration tests on macOS and
  Linux before release.
