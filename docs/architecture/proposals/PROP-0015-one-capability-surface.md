---
id: PROP-0015
title: One capability surface — the Harness terminal and every host offer the same capabilities
status: Accepted
created: 2026-10-23
updated: 2026-10-23
affects: [INV-BND-2, new INV-PAR-1..4, 00-overview.md, 11-terminal.md, new 14-surfaces-and-parity.md, AGENTS.md]
---

# PROP-0015: One capability surface

Accepted by the user's approval of the parity plan on 2026-10-23. Related decision:
[ADR-0017](../../decisions/ADR-0017-one-capability-surface.md).

## Problem

Two front ends sit on the same harness: the Harness-owned terminal (`xharness`) and the App.
Capabilities a person uses grew in the App alone (web annotations, managed worktrees, agent
organizations, delegated work), so the terminal cannot do what the App does, and a reader cannot
tell which repository owns a feature. The App also carried an orchestration layer (agents as
product objects, routed chats, group chats, a reporting tree, delegated work queues) that no other
host could reuse and that was never verified in a running app.

The owner decided on 2026-10-23 that the App is a richer presentation of the Harness and that the
terminal and the App offer the same capabilities, with room reserved for future host-only
surfaces such as interactive agent output ("OpenUI").

## Affected rules

- 00-overview "Stays in the application: agents, groups, conversations, tasks and coordination,
  projects and worktrees, App browser UI and tab sharing, computer use, windows, the PTY, the
  keychain, and application UI."
- `INV-BND-2` lists "worktree" among application concepts.
- 11-terminal describes the terminal as one frontend, with no parity obligation.

## Proposal

A new page, [14 Surfaces and parity](../14-surfaces-and-parity.md), states four invariants:

- **INV-PAR-1** Every capability a person can use in a host is a Harness capability: a foundation
  service, a `WorldPart`, or a first-party plugin, reachable through server methods. The standalone
  terminal surfaces it. A host is a presentation of it.
- **INV-PAR-2** A capability is complete only when its terminal surface and its host surface both
  pass acceptance. It lands in the Harness first, together with its terminal surface.
- **INV-PAR-3** A host-backed capability needs an operating-system object only a host has (a
  WebKit tab, a native computer bridge, a keychain). The Harness defines its generic contract and a
  terminal fallback. Without a fallback, the terminal shows the capability as unavailable with the
  reason, in `/doctor` and `/tools`.
- **INV-PAR-4** A host-only surface is presentation that cannot exist in a terminal. It owns no
  capability: its actions are Harness methods or tools, its data lives in Harness records, the
  terminal shows a text fallback, and each one is listed in the host's register by an owner
  decision. A generic rich-output event for such surfaces needs its own proposal; the name is
  reserved, nothing is designed.

00-overview changes:

- "Belongs in the harness" gains managed worktrees (PROP-0016) and page annotations (PROP-0017).
- "Stays in the application" becomes: windows, the PTY, the keychain, native operating-system
  bridges (WebKit tabs, computer control), presentation, and registered host-only surfaces.
- `INV-BND-2` no longer lists "worktree" as an application concept once PROP-0016 lands.

A non-binding register, [`docs/parity.md`](../../parity.md), lists every capability with its
Harness owner, its terminal surface, its host surface and its status.

## Alternatives

- **Keep the App as the full product and the terminal as a developer tool.** Rejected by the owner:
  it keeps two products and the ownership confusion.
- **Strict identity of the two front ends.** Rejected: some presentation (rich panes, interactive
  output) cannot exist in a terminal. INV-PAR-4 bounds that category instead.
- **Do nothing.** The gap grows with every App feature.

## Consequences

- New user capabilities are Harness work first, with their terminal surface.
- Hosts may still add tools through `ToolProvider`, but a tool a person relies on is either a
  Harness capability or a declared host-backed capability (INV-PAR-3).
- The server protocol gains method groups only through the proposals that add each capability.

## Migration

No stored data changes. Existing gaps are recorded in `docs/parity.md` with IDs (`PAR-NNN`) and
closed one at a time.

## Checks

Documentation change. Link check of the edited pages; each later capability brings its own tests
on both surfaces.
