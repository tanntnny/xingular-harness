---
id: PROP-0036
title: First-class Harness terminal commands
status: Implemented
created: 2026-10-25
updated: 2026-10-25
affects: [INV-PLG-10, INV-TUI-7, 06-plugins-and-capabilities.md, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md, parity, ADR-0031]
---

# PROP-0036: First-class Harness terminal commands

## Problem

Harness-owned pages for subagents, agent profiles, recorded-run inspection, diagnostics and worktrees are currently exposed through `BuiltinPluginRegistry` command metadata. This couples their terminal command namespace and discoverability to a feature-plugin registry even though these required features are not optional plugin toggles. It also makes ordinary Harness commands appear as plugin commands in help and completion.

Evidence: `src/plugins/builtin.ts` registers these commands on the `subagents`, `history`, `doctor` and `worktrees` modules; `src/terminal/tui/pluginCommands.ts` maps them to pages; `src/terminal/tui/commands.ts` builds canonical namespaced completion and dispatch from `BuiltinPluginRegistry`.

## Affected rules

- **INV-PLG-10** currently couples a built-in feature's descriptor, tools, server methods and terminal command metadata to one registry owner. Plugin-owned commands should remain with their feature modules, but Harness core commands should be owned by the terminal's core command registry.
- **INV-TUI-7** requires every plugin-owned command to use an owner prefix. The commands in this proposal become Harness core commands, not plugin-owned commands; all other plugin and extension commands retain owner-qualified routes.
- **14 Surfaces and parity, Contracts** describes the current terminal command namespace. The command changes are presentation only and add no capability or server method.

## Proposal

Register these routes directly in the core terminal command table and dispatch them to the existing Harness pages:

- `/doctor` opens readiness diagnostics.
- `/worktree` opens managed worktrees.
- `/trajectory [run-id]` opens recorded runs and events.
- `/subagents` opens the subagent roster; `/agents` opens agent profiles.

Keep `/history` (and its `/tree` alias) for session branch navigation. Keep `/mcp` and `/connections` as first-class entries into the Connections browser. All other core commands stay unprefixed. Plugin-owned built-in and extension commands continue to use `/<owner-prefix>:<command>`; annotations retain their `annotate` namespace and default route.

The `doctor`, `worktrees`, `history` and `subagents` feature descriptors remain registered and required. Their services, server methods, tools and capability behavior do not move. Only their terminal command metadata and dispatch move to the core command registry. Core commands reserve their names under the existing terminal command collision policy.

For one release, accept the prior owner-qualified and `/plugin:<command>` forms for the routes being promoted as hidden compatibility aliases. Do not show aliases in help or completion. Remove them after the compatibility release.

## Alternatives

- Keep these routes under owner prefixes. Rejected: it keeps core terminal actions classified as plugin commands and exposes redundant namespaces for required Harness features.
- Remove the feature descriptors from `BuiltinPluginRegistry`. Rejected: those descriptors still own Harness tools, server methods and capability contributions; only terminal command ownership needs to change.
- Replace `/history` with the trajectory page. Rejected: `/history` already navigates the current session's branches. Keep it and expose the run trajectory as `/trajectory`.
- Do nothing. Rejected: help, completion and dispatch continue to treat these core pages as plugin-owned commands.

## Consequences

Help, completion, slash recognition and dispatch use the core command table for the promoted commands. The `/mcp` command remains in that table and keeps its Connections behavior. Plugin command-prefix collision checks remain in force for plugin-owned commands. No capability set, server protocol, account data, run record or stored resource changes.

## Migration

No stored-data migration. Accept the previous qualified forms as hidden aliases for one release; scripts and keybindings should use the bare canonical names. `/history` remains the branch picker and `/trajectory` is the recorded-run page.

## Checks

- Registry and terminal tests cover bare routes, help, completion, slash recognition, compatibility aliases, prompt-name collisions, `/history`, `/mcp` and unchanged plugin namespace routing.
- Harness `npm run typecheck`, `npm test` (150 files; 1,143 passed, 3 skipped) and `npm run prove` passed.
- Xingular Agent `npm run typecheck`, `npm test` (App and sidecar suites: 634 passed; signing tests: 7 passed, 1 skipped), `npm run check:layers` and `cargo test` (167 passed, 1 ignored) passed.
- Isolated terminal PTY checks passed for `/help`, composer modes, and the `/trajectory` Runs/Events page. `/help` screen-layout assertions were skipped because optional `pyte` is unavailable.
