---
id: PROP-0021
title: Required built-in commands and duplicate command suppression
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-TUI-7, INV-PAR-1, 11-terminal.md, 14-surfaces-and-parity.md, ADR-0021]
---

# PROP-0021: Required built-in commands and duplicate command suppression

Accepted by the user’s request to implement this plan on 2026-10-24; implemented in the working tree and recorded in ADR-0021.

## Problem

PROP-0020 put every built-in plugin command behind `/plugin:`. This makes required Harness features
less direct to invoke, and stale bridge registrations create duplicate `/plugin:accounts`,
`/plugin:hub`, and `/plugin:plugins` entries beside their core commands. Loaded extension commands can
also duplicate an existing bare command or prompt, as with `/plugin:mcp` or `/plugin:llama`.

Evidence: the required `subagents`, `history`, `doctor`, and `worktrees` plugin descriptors own
`subagents`, `trajectory`, `doctor`, and `worktree` terminal commands in `src/plugins/builtin.ts`.
`src/terminal/tui/commands.ts` prefixes every registry command and does not check extension names
against core commands or prompt templates. `src/terminal/piExtension.ts` separately registers
`hub`, `plugins`, and `accounts`, although the owned terminal already routes those names. `/mcp` is a
core alias for Connections. `/llama` is resource-dependent rather than a Harness core command; when
a matching prompt is loaded, it is the bare command that takes precedence.

## Affected rules

- **INV-TUI-7:** A plugin command is invoked as `/plugin:<command>`, dispatched to its registered
  owner and shown that way in completion and help. Duplicate names are rejected with owner
  diagnostics. Old unprefixed plugin command forms are not aliases; core commands stay unprefixed.
- **INV-PAR-1:** Every capability a person can use in a host is a Harness capability; the standalone
  terminal surfaces it.
- **14 Surfaces and parity, Contracts:** Plugin-owned terminal commands use `/plugin:<command>`;
  Foundation commands remain unprefixed.

## Proposal

Use an explicit namespace on each built-in terminal command. Commands owned by a required
`PluginDescriptor` use the bare terminal namespace; optional built-in plugin commands use
`/plugin:<command>`. This yields:

| Plugin | Command | Invocation |
|---|---|---|
| `subagents` (required) | `subagents` | `/subagents` |
| `history` (required) | `trajectory` | `/trajectory` |
| `doctor` (required) | `doctor` | `/doctor` |
| `worktrees` (required) | `worktree` | `/worktree` |
| `annotations` (switchable) | `notes`, `annotate` | `/plugin:notes`, `/plugin:annotate` |

Keep core `/accounts`, `/hub`, `/plugins`, and `/mcp` unprefixed. Remove the Pi bridge's duplicate
`accounts`, `hub`, and `plugins` command registrations.

A bare core command, alias, required built-in command, or loaded prompt owns that bare name. Do not
show or execute `/plugin:<name>` when its name collides with one of those commands; direct use reports
the bare command to use. The same rule handles dynamic duplicates such as `/plugin:mcp` or
`/plugin:llama` without special-casing installed packages. Pi extension commands with no bare-name
collision remain `/plugin:<name>`. Namespace collisions between core and required built-in commands
are rejected rather than silently overwritten. Old prefixed forms of required built-in commands are
not aliases.

Command routing, pages and existing account/plugin methods remain Harness-owned. No server method,
capability gate, storage layout, or plugin availability changes.

## Alternatives

- Keep all built-in commands namespaced. This preserves the duplicate entries and makes required
  Harness operations less direct.
- Unprefix every built-in plugin command. This also changes the optional, switchable Annotations
  commands even though the request targets required plugins.
- Hide only the five currently named duplicate entries. A general same-name rule would still allow
  future extensions or prompts to create duplicates.
- Do nothing. The current prefixed required commands and duplicate entries remain.

## Consequences

Completion, help and dispatch use the namespace declared by the built-in registry. Bare names for
required plugins participate in the core command collision checks. Optional built-in and third-party
plugin commands retain the plugin namespace. When a bare prompt or command conflicts with a Pi
extension command, the bare command wins and the extension's slash command is unavailable under that
name; the extension must choose another name to expose both.

## Migration

Use `/subagents`, `/trajectory`, `/doctor`, and `/worktree` in place of their `/plugin:` forms. Keep
`/plugin:notes` and `/plugin:annotate`. Use `/accounts`, `/hub`, `/plugins`, and `/mcp` for their
existing core commands. No stored data or server methods migrate.

## Checks

- Registry tests cover the explicit namespace derived for required and optional plugin commands.
- Terminal tests cover bare command routing, optional/plugin-prefixed routing, help/completion,
  bridge registration removal, extension duplicates, and extension collisions with bare commands,
  aliases, and loaded prompts.
- Update parity and command documentation, including Doctor, trajectory, subagents and worktrees.
- Run Harness typecheck, tests, build and terminal proof; then run the App typecheck, tests, layer
  check and Rust tests.
