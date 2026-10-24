---
id: PROP-0014
title: Full-screen resource browser with persistent section tabs
status: Implemented
created: 2026-10-23
updated: 2026-10-23
affects: [11-terminal.md, terminal-tui.md]
---

# PROP-0014: Full-screen resource browser with persistent section tabs

Accepted by the user's request to implement the agreed plan on 2026-10-23.

## Problem

The browser's centered panel, section dropdown and wide sidebar consume space and hide
navigation when inspecting a resource. The user requested a full-page screen with component tabs.

## Affected rules

The terminal guide states: “The browser keeps the centered dialog size policy.”
This proposal replaces that browser layout contract. INV-TUI-1 through INV-TUI-6 remain intact.

## Proposal

Every resource-browser command opens the full terminal. Overview, Foundation, Variant, Skills,
Plugins, Connections, Tools and Library occupy a persistent top tab strip. Narrow terminals
show the active tab and previous/next navigation. Tab moves focus; arrows change the focused tab;
mouse selection selects a tab directly. Each section retains search and resource selection.

At 88 content columns, inventory and inspector share the screen; details, actions and content
stay beside the list. Narrow screens show details and content within the active tab. Escape
returns through content, inspection and search before closing. Other command pages retain
centered presentation. Browser actions retain existing confirmations and protected services.

## Alternatives

Keeping the centered browser leaves insufficient working space. Full-width lists with replacement
detail views hide useful context on wide terminals. A c1–c8 primary tab strip was considered;
the user selected resource sections instead.

## Consequences

This is foundation UI behavior. TerminalPage gains optional presentation and direct tab selection.
There is no server protocol, stored data, account, loader or gate change.

## Migration

Existing command destinations and resource state are preserved. No migration is needed.
The UI change is reversible without touching stored data.

## Checks

Cover page geometry, keyboard and mouse tab selection, inspection, scrolling, responsive resize,
shortcut destinations, and draft preservation. Run typecheck, tests, build, the isolated browser
PTY suite and the consuming application's required checks. No real model requests are needed.

Related decision: [ADR-0016](../../decisions/ADR-0016-fullscreen-browser-tabs.md).
