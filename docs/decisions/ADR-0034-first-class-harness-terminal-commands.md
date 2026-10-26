# ADR-0034 — First-class Harness terminal commands

Status: Accepted (PROP-0036, 2026-10-25).
Supersedes: The plugin-command ownership rule of ADR-0031 only for the Harness terminal commands listed below.
Related: [PROP-0036](../architecture/proposals/PROP-0036-first-class-harness-commands.md),
[06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md),
[11 Terminal](../architecture/11-terminal.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md),
[ADR-0031](ADR-0031-plugin-command-owner-namespaces.md).

## Context

The required `subagents`, `history`, `doctor` and `worktrees` feature modules currently contribute terminal commands through `BuiltinPluginRegistry`. These features are not optional plugin toggles, and their terminal pages are first-class Harness surfaces. `/history` already means session-branch navigation, while `/mcp` already opens the Connections browser as a core command.

## Decision

The terminal's core command registry owns these canonical routes: `/doctor`, `/worktree`, `/trajectory [run-id]`, `/subagents` and `/agents`. `/history` and `/tree` continue to navigate session branches. `/mcp` and `/connections` continue to open Connections.

The underlying required feature descriptors, tools, server methods and services remain registered by `BuiltinPluginRegistry`; they no longer own the terminal command metadata for these routes. Other plugin-owned built-in and Pi extension commands remain `/<owner-prefix>:<command>`, including the annotations namespace.

For one release, the prior owner-qualified and `/plugin:<command>` routes for the promoted commands remain accepted as hidden compatibility aliases. They are omitted from help and completion. Core command names remain reserved under the normal collision policy.

## Consequences

The core terminal command table owns help, completion, highlighting and dispatch for the promoted routes. Plugin namespace collision checks and extension command ownership are unchanged. No server method, capability contract or stored data changes.
