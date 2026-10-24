# ADR-0016 — Full-screen browser with persistent resource tabs

Status: Accepted (user requested implementation of the agreed plan, 2026-10-23).
Related: [PROP-0014](../architecture/proposals/PROP-0014-fullscreen-browser-tabs.md),
[ADR-0015](ADR-0015-resource-browser.md).

## Context

The unified browser's centered layout and nested section/detail navigation leave little space
for inventory and inspection. The user wants one full-page workspace with resource-section tabs.

## Decision

Resource-browser commands use a full-screen surface with persistent section tabs. Wide terminals
show inventory beside an inspector containing metadata, actions and content. Compact terminals
show inline detail views under the same tab strip. Tab moves focus, arrows change a focused tab,
and mouse tab selection targets the section directly.

TerminalPage declares its presentation and optionally supports direct tab selection. Centered
presentation remains the default for other pages. Resource services keep their existing ownership.

## Alternatives

Keeping the centered panel restricts working space. Replacing the list with details at all widths
loses inventory context. Variant c1–c8 tabs do not match the selected resource-navigation intent.

## Consequences

The browser owns responsive inventory/inspector focus and preserves section search and selection.
Small terminals use compact tab navigation. There are no storage or protocol changes.
Verification belongs in the terminal guide and its automated page and PTY checks.
