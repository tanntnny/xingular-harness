---
id: PROP-0013
title: Unified terminal resource browser
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [INV-TUI-4, 03-variants.md, 06-plugins-and-capabilities.md, 09-accounts-and-connectors.md, 11-terminal.md]
---

# PROP-0013: Unified terminal resource browser

## Problem

Skills, local resources, variant additions and community discovery are split across commands.
See [source study](../../study/tui-resource-browser.md). The user approved the proposed UX plan
and requested implementation in this session.

## Affected rules

INV-TUI-4 requires a private control key for terminal configuration mutations. Extend that
protected route to browser reads, local imports, package install/remove and connection management.
INV-FND-2 (validated variant commits), INV-PLG-1 (single loader), INV-PLG-3 (installation grants
no trust/attachment) and INV-MCP-4 remain enforced. No extension point is added.

## Proposal

One browser exposes Overview, Foundation, Variant, Skills, Plugins, Connections, Tools and Library.
Resource sections share Installed/Discover. Existing commands become shortcuts. Saved and live
availability remain separate: session loader/tool registry proves current availability; configuration
and variant head describe future sessions. Inspecting never loads extensions or connects MCP.
The private socket adds terminal.browser.* adapters to the existing services. File reads accept
resource IDs and use enumerated owner paths, regular-file checks and bounded previews.

## Alternatives

Do nothing retains fragmented discovery. Separate improved pages still require users to learn
where a resource lives. A combined local/remote list obscures the action and availability differences.

## Consequences

No second loader, enablement store or secret store. The public host RPC framing is unchanged.
Optional install/remove callbacks extend the terminal adapter. Credential inputs are masked.
Hub documents remain inert until a separate explicit connector-setup action validates their shape.

## Migration

No data migration. Existing commands remain valid shortcuts. Existing sessions keep their resource
selection and variant pins. New resources require the same trust/attachment and restart as before.

## Checks

Focused model/page/socket tests, OpenTUI completion tests, isolated PTY journeys at 40x20, 80x24,
120x40, Harness typecheck/tests/build/proof and required sibling App checks. No real model requests.

## Implementation evidence

[Terminal acceptance and limits](../../evidence/terminal-resource-browser/README.md).
Implementation remains in the working tree; no release or publication is claimed.
