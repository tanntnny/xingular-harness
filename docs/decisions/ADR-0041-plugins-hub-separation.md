---
id: ADR-0041
title: Separate local plugin management from Community Hub discovery
status: Accepted
created: 2026-10-27
proposal: PROP-0047
---

# ADR-0041: Separate local plugin management from Community Hub discovery

## Decision

- `/plugins` is the dedicated local installed-plugin manager: switching, code trust, settings, and
  local package install, update and removal. It does not browse the public catalog.
- `/hub` is a distinct public-catalog page. Its Catalog view shows Community entries across active
  supported types; its Installed view shows receipts from every channel with the channel visible.
  The broad `/harness` resource browser remains available.
- Opening Hub shows cached or bundled entries first, then refreshes remotely. The page retains the
  data origin, last-refresh time and any fallback/error status. Registry/document entries keep a
  bounded payload Preview; Pi packages have no payload Preview.
- A Hub-owned package cannot be silently floated by `plugins.update`. Removing it through
  `plugins.remove` delegates to Hub's exact-receipt uninstall operation; Hub remains the writer of
  its receipt and owned resources. Replacing it requires an explicit, exact catalog version.
- Host presentations use the same filtering, refresh and receipt lifecycle while choosing their own
  layouts. No new capability, loader, storage format or server response schema is introduced.

## Rationale

Local plugin management and public catalog discovery have different owners and different safety
contracts. Separating the direct pages makes that visible without duplicating the services: local
packages use the plugin manager, while Hub installs are pinned catalog releases with receipts. A
Community-only catalog view also avoids presenting official items as community submissions, while
retaining existing Official receipts for management.

## Consequences

The direct terminal and host routes have distinct screens, but `/harness` stays a broad resource
browser. Catalog filtering is presentation-only; `hub.list` remains unfiltered for other callers.
Existing receipts and plugin settings need no migration. The current public catalog has no
Community Pi-package entry, so no Community plugin appears until a publisher adds one. See
[PROP-0047](../architecture/proposals/PROP-0047-plugins-hub-separation.md).
