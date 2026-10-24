# TUI resource browser study

Status: source study completed, 2026-10-22. Runtime acceptance is recorded separately.

## Current gaps

`/components` browses registry resources and compares them with the latest variant head;
it does not enumerate the session loader. `/plugins` controls attachments and trust while
`/hub` installs into separate destinations. The OpenTUI palette accepts slash commands only;
`skillCompletions` exists but has no OpenTUI caller. `$name` expansion works on submission.

## Local reference evidence

| Reference | Inspected source | Adopted pattern | Harness adaptation |
|---|---|---|---|
| OMP | `external/omp/packages/tui/src/overlays/extensions/extension-dashboard.ts`, `inspector-model.ts` | Inventory, owner/provider and inspector in one browser | Inspect before changing state; existing loader and gate remain authoritative |
| OpenCode | `external/opencode/packages/tui/src/component/dialog-skill.tsx`, `dialog-mcp.tsx`, `command-palette.tsx` | Searchable skills, explicit loading/errors, actionable MCP states | Use inserts a draft; cached MCP checks are labelled with dates |
| Kimi CLI | `external/kimi-cli/src/kimi_cli/ui/shell/slash.py`, `mcp_status.py` | Skills in help and server/tool relationships | Link relationships inside the browser rather than requiring a second command |
| OpenHands | `external/openhands/src/components/features/plugins/build-plugins-view-model.ts`, `routes/skills-plugins.tsx` | Reconcile catalog, installed and ambient resources | Preserve distinct owners/paths for duplicate names; runtime proves availability |
| DeepSeek | `external/deepseek-harness/apps/web/tests/expected/plugin-manager/manager.expected.md` | Descriptive built-in settings and explicit plugin details | Foundation descriptions and configuration links; no web card layout in the terminal |
| Harness² | `external/harness2/harness2/core/tree.py` | Explicit editable surface and eight components | Read-only c1–c8 inspection with pinned/latest versions |

These are bounded source observations, not claims of runtime visual equivalence.
The other checkouts (Orca, OpenHands SDK, smolagents, SWE-agent) are not primary terminal
layout references for this change. No reference implementation is copied into the runtime.

Inspected checkout revisions (source observations above):

- OMP: `63a7ba5dcc74cca2cb0ecb710770eb756102035d`
- OpenCode: `94bc5662c4ad3b983276021ce9df7f0bc1b11d5c`
- Kimi CLI: `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`
- OpenHands: `9057a57f4a7b5a74e93989090edaffc21e3554ff`
- DeepSeek Harness: `687f282e8625c6b8d11ff58211a90524be2e4317`
- Harness²: `1cfe254e8d25b15f37048c3730134686abe60335`

## Navigation decision

`/harness` is the main browser. `/skills`, `/plugins`, `/connections` (`/mcp`) and `/tools`
are direct section shortcuts; `/hub` selects Discover, `/components` selects Library.
Installed includes locally present resources and labels their effective state. Discover uses
the existing Hub with All/Community/Official filters. Built-in and foundation are different axes:
foundation is a runtime ownership boundary; built-in is provenance.

## Responsive wireframes

Wide (inner width >=88):

```text
Harness > Skills       Installed | Discover       All | Community | Official
Overview        Search skills...             | Selected skill
Foundation      Review        Available now  | Description, owner, origin
Variant         Review        Library only   | Availability, path, scope
Skills          Another       Disabled       | Inspect / Use / Manage
Plugins                                      |
Connections                                  |
Tools                                        |
Library                                      |
```

Compact (80-column terminal):

```text
Harness > Skills [choose section]
Installed | Discover
Search skills...
Review                    Available now
Another                   Library only
Enter details; Tab controls; Ctrl+F search
```

At 40 columns, controls truncate or wrap into the bounded frame. Detail replaces the list;
Escape returns without losing query/selection. Wide and compact modes share the same state.

## Acceptance journeys

Find and invoke a skill; import a local bundle; install a Hub skill and add it to a future
variant; review/trust a local plugin; configure local/remote MCP; inspect web_fetch ownership;
compare pinned/latest variant files; recover from offline/empty discovery and failed sign-in.
