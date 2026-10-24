# ADR-0015 — One terminal browser for resources and discovery

Status: Accepted (user requested implementation of the agreed plan, 2026-10-22).
Related: [PROP-0013](../architecture/proposals/PROP-0013-resource-browser.md),
[source study](../study/tui-resource-browser.md).

## Context

Skills, plugins, Hub items and variant additions have different entry points and misleading
availability labels. Users need to identify what exists, what this session can use, and what changes later.

## Decision

Use a shared responsive browser with section shortcuts, Installed/Discover views, provenance and
inspection before management. Join saved configuration with actual runtime resources; never infer
loaded state from attachment settings or the latest variant head. Keep the loader, gate and service
ownership intact. Show foundation and variant as different ownership layers.

## Alternatives

Separate pages retain navigation fragmentation. A single combined remote/local list confuses
installation with availability. A full editor expands the task beyond browse/manage.

## Consequences

The browser adds a protected service adapter and focused navigation state. Resource reads are bounded,
credentials stay masked, and installing does not activate resources. Existing commands remain shortcuts.
Implementation and verification evidence belong in the terminal guide, not in this decision record.
