# ADR-0019 — Managed Git worktrees are a Harness capability

Status: Accepted (owner approved the parity plan, 2026-10-23).
Related: [PROP-0016](../architecture/proposals/PROP-0016-managed-worktrees.md),
[02 Sessions and runs](../architecture/02-sessions-and-runs.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

Worktrees isolate source changes, but an App-only implementation leaves terminal users without
that capability and lets each host invent its own lifecycle and safety rules.

## Decision

The Harness owns the worktree registry, lifecycle, session leases, and server methods. Managed
worktrees are disposable detached checkouts in device-local state; permanent worktrees are retained.
Creating a worktree disables repository filters, carries source changes only under the defined
copy/apply rules, and runs setup scripts only after exact-text trust. Leases prevent concurrent
removal; removal snapshots recoverable work before deleting a checkout. Hosts call `worktrees.*`
rather than managing these records independently, and the terminal provides the reference surface.

## Alternatives

Keeping the feature in the App breaks terminal/host parity. Putting large worktree checkouts inside
source repositories pollutes them and makes the data visible to tools and editors. Platform-specific
copy-on-write clones were deferred in favor of Git's portable linked-worktree behavior.

## Consequences

`worktreeId` identifies a Harness-managed worktree in a run. Worktree state is device-local under
the Harness state directory. Hosts can present richer controls but do not own lifecycle or safety.
