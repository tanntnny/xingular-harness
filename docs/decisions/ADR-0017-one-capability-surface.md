# ADR-0017 — One capability surface for the terminal and every host

Status: Accepted (owner approved the parity plan, 2026-10-23).
Related: [PROP-0015](../architecture/proposals/PROP-0015-one-capability-surface.md),
[PROP-0016](../architecture/proposals/PROP-0016-managed-worktrees.md),
[PROP-0017](../architecture/proposals/PROP-0017-page-annotations.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

Capabilities grew in the App alone, so the Harness terminal could not do what the App did, and
ownership between the repositories was unclear. The owner wants the App to be a richer
presentation of the Harness, with the same capabilities as the terminal, and room for future
host-only surfaces such as interactive agent output.

## Decision

Every user capability is a Harness capability with a terminal surface (INV-PAR-1, INV-PAR-2).
Capabilities that need an operating-system object only a host has define a generic contract and a
terminal fallback (INV-PAR-3). Host-only surfaces own no capability and are registered by the host
with an owner decision (INV-PAR-4). Managed worktrees and page annotations move into the Harness
under PROP-0016 and PROP-0017. Orchestration across agents (organizations, routed chats, group
chats, delegated work queues) is not a Harness capability; the App removes it and keeps it only in
an archived version.

## Alternatives

Keeping the App as the full product leaves two products. Identical front ends cannot accommodate
presentation a terminal cannot show. Doing nothing lets the gap grow.

## Consequences

New user features start in the Harness with a terminal surface. The register `docs/parity.md`
tracks gaps until both surfaces pass. Hosts keep native bridges, windows and presentation.
