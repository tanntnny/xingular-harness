---
id: PROP-0047
title: Separate local plugin management from Community Hub discovery
status: Implemented
created: 2026-10-27
updated: 2026-10-27
affects: [INV-MCP-4, INV-TUI-2, INV-TUI-4, INV-PAR-1/2, 06-plugins-and-capabilities.md, 09-accounts-and-connectors.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md, parity.md]
---

# PROP-0047: Separate local plugin management from Community Hub discovery

## Problem

`/plugins` and `/hub` currently open the same `BrowserPage` (`src/terminal/tui/commandPages.ts`),
with different initial filters. That page combines local plugin controls with public catalog
browsing. Separate `PluginsPage` and `HubPage` implementations already exist but are not routed by
the commands. The App similarly presents local plugins and the public catalog in one Capability
Hub view.

The distinction matters operationally: direct plugin operations use `plugins.install`,
`plugins.update` and `plugins.remove`; catalog installs use exact Hub versions and create receipts
through `Hub.install`. A direct `plugins.remove` currently removes the package without updating a
Hub receipt (`src/server/methods.ts`, `src/plugins/install.ts`), whereas `Hub.uninstall` owns both
package removal and receipt cleanup (`src/hub/hub.ts`). Pi packages also have no JSON payload to
preview (`Hub.preview` rejects them), and a failed remote refresh must not make cached catalog data
look current or successful.

The requested product behavior is: `/plugins` manages local installed plugins and their package
lifecycle; `/hub` is a separate public-catalog page showing Community entries across supported
catalog types. Hub's Installed view retains receipts from every channel, labeled by channel. Opening
Hub first shows cached/bundled entries and then refreshes remotely, retaining visible origin and
stale/error status.

## Affected rules

The current terminal-page contract says that `/plugins` and `/hub` are shortcuts into the unified
resource browser (`docs/architecture/11-terminal.md`, “Resource browser”):

> `/skills`, `/plugins`, `/connections` (`/mcp`), `/tools`, `/hub` and `/components` are shortcuts into that browser.

The terminal guide also says the resource sections share Installed/Discover and source filters, and
that `/hub` selects Discover (`docs/terminal-tui.md`, “The Harness resource browser”). This proposal
replaces those two route-specific statements; the broad `/harness` browser remains available.

Receipt handling must continue to obey **INV-MCP-4**:

> Hub installation grants no attachment, trust, credential or permission. Writes are serialized;
> existing registry files are never overwritten; uninstall removes only the exact receipt's
> resources and revokes its attachment choices.

The proposal does not weaken **INV-PLG-3**: package installation runs no code and grants no
attachment, trust, credential or permission. Nor does it change **INV-TUI-4**: terminal mutations
continue through the control-key-protected routes. **INV-PAR-1/2** continue to require the same
capabilities and acceptance on terminal and host surfaces.

## Proposal

1. Route the direct terminal commands to distinct pages: `/plugins` to the local plugin manager and
   `/hub` to the public Hub catalog. Keep `/harness` as the broader resource browser. The pages are
   distinct presentations, not new capabilities or loaders.
2. The Plugins page manages local installed packages and their contributions: inventory, switching,
   code trust, settings, direct package installation, update and removal. Public catalog discovery
   is not part of this page. Ordinary local packages use the existing `plugins.*` services.
3. A package recorded in a Hub receipt is owned for removal by Hub: a `plugins.remove` request for
   that package must go through Hub's receipt-aware uninstall path so the package and its exact
   receipt cannot diverge. Do not use a floating `plugins.update` for a Hub-managed package. Its
   replacement must be an explicit operation against an exact catalog version and must retain
   receipt ownership; if no safe replacement operation exists, require uninstall then install of the
   selected exact version.
4. The Hub page's Catalog view contains Community entries only, across catalog types supported by
   the active product. This does not restore the deprecated agent-template application flow. The
   Installed view contains receipts from all channels with the entry's channel visible; existing
   Official receipts therefore remain reviewable and uninstallable. The underlying catalog and
   `hub.list` contract remain unfiltered for other callers.
5. On Hub entry, load cached/bundled content first, then request a remote refresh. Keep the last
   known entries and show whether they are remote, cached or bundled, when they were refreshed, and
   any refresh error. An explicit refresh remains available. Keep bounded payload Preview for
   registry/document entries, but do not expose Preview for Pi packages; install and uninstall
   remain pinned to the selected receipt/catalog version.
6. Host surfaces use the same catalog filtering, receipt, refresh and lifecycle semantics in their
   own page layouts. No host-only surface, new loader, data store or server response schema is added.

## Alternatives

- **Keep the shared browser for both commands.** Rejected: it leaves local management and public
  discovery coupled, contrary to the requested ownership and page distinction.
- **Make `/hub` Community-only but keep `/plugins` as the browser's Installed/Discover shortcut.**
  Rejected: public discovery would remain inside the command meant for local plugin management.
- **Hide non-Community receipts in Installed.** Rejected: it would strand existing Official Hub
  installations from the dedicated management view.
- **Do nothing.** Rejected: it retains the current refresh-status and package-lifecycle gaps.

## Consequences

- The terminal and host frontends need separate Plugins and Hub presentations, but continue to call
  the same Harness-owned services. Their layouts need not match.
- `plugins.remove` behavior changes only for a package owned by a Hub receipt: Hub remains the sole
  writer that removes that receipt. Its method shape and response schema need not change.
- Community filtering is a presentation rule. Catalog metadata, receipts, and the unfiltered Hub
  service remain unchanged. Existing official receipts require no migration.
- The public catalog currently has a Community skill but no Community Pi-package entry. This change
  does not publish or invent a package; the Community plugin list stays empty until a publisher adds
  a valid entry.

## Migration

No data migration. Existing receipts from all channels remain in storage and appear in Installed with
their channel label. Existing plugin trust, attachment, settings and package data remain unchanged.
The command names and protected service routes remain stable; only the direct-page routing and
receipt-aware removal behavior change. `/harness` retains its broad browser.

## Checks

- Harness route and page tests: distinct command destinations; Community-only catalog results;
  all-channel Installed receipts; cache-first refresh and visible fallback status; bounded
  registry/document Preview with no Pi-package Preview; and receipt-aware removal/update behavior.
- Harness: `npm run typecheck`, `npm test`, and `npm run prove` after changing the server method.
- Host/App tests: matching route, filtering, refresh and receipt behavior; then App
  `npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`, and
  `cd src-tauri && cargo test`.
- Inspect isolated terminal and host screens at compact and wide sizes. Tests use fixtures; do not
  install a real package or make a model request for verification.
