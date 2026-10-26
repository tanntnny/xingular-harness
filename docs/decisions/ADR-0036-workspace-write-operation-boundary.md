---
id: ADR-0036
title: Enforce workspace writes at the filesystem operation
status: Accepted
created: 2026-10-26
proposal: PROP-0039
---

# ADR-0036: Enforce workspace writes at the filesystem operation

## Decision

The Harness owns one filesystem-effect boundary shared by SDK sessions and the terminal. Each run
pins a non-root `workspaceRoot`; model-controlled native writes and default-scope Bash are confined
to that root by operating-system enforcement, not by prompt guidance or pathname checks alone.

- Native `write` and `edit` calls revalidate the authorized canonical target at mutation and use
  atomic replacement under an OS-enforced write scope. Outside file targets need a one-call
  approval; replacing a directory entry rather than truncating an inode prevents an outside
  hard-link alias from being changed.
- Before default-scope Bash, Harness scans the workspace for regular-file inodes with links outside
  it and blocks the command if the scan is incomplete or an external alias may exist. The OS
  sandbox prevents the command from creating a cross-boundary hard link. On macOS it denies
  hard-link creation entirely, including within the workspace.
- Bash outside scope is an explicit `workspaceWriteScope: 'outside'` request, or terminal
  `!outside <command>`. The complete quoted command is shown in approval details. Approval happens
  before execution, is human-only and nonrememberable, and runs the exact command once. An
  undersized terminal denies the request. stdout/stderr never proves a sandbox denial and never
  triggers approval or replay.
- Full Permission remains the existing explicit boundary bypass for eligible interactive runs; it
  remains subject to hard policy, authorization, read-only, plan, unattended and refinement rules.
- The filesystem root is not a valid workspace. A same-user peer process outside Harness remains
  outside this boundary. Atomic replacement preserves ordinary file mode where possible but does
  not guarantee ACL or extended-attribute preservation.

## Rationale

Canonical path checks alone do not contain effects through hard links and are vulnerable to
pathname changes between authorization and mutation. Atomic replacement avoids writing through a
shared inode, while an OS scope constrains the helper if a path changes. Shell output is controlled
by the command and cannot authenticate a denial event; explicit pre-execution scope requests avoid
replaying partial side effects and make broad writes an intentional decision.

## Consequences and alternatives

Workspaces with external hard-link aliases cannot use default Bash until repaired. Unsupported or
incomplete sandbox enforcement fails closed. Outside writes remain possible through the explicit
one-call approval path. A private copy-on-write workspace would also isolate against same-user peer
processes, but changes visibility, writeback, conflict handling, metadata and performance; it remains
out of scope unless that threat must be covered.

This decision is not release evidence. See [PROP-0039](../architecture/proposals/PROP-0039-workspace-boundary-hardening.md),
[the gate contract](../architecture/07-tools-and-gate.md), [terminal parity](../architecture/11-terminal.md)
and [the release note](../releases/1.2.0.md) for implementation and validation status.
