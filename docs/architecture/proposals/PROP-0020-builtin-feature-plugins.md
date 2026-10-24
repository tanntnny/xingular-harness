---
id: PROP-0020
title: Built-in feature modules and namespaced plugin commands
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-PLG-5, INV-PLG-6, INV-TUI-2, INV-TUI-7, INV-SRV-1, 06-plugins-and-capabilities.md, 11-terminal.md, 13-world-tools.md, 14-surfaces-and-parity.md]
---

# PROP-0020: Built-in feature modules and namespaced plugin commands

**Command namespace note:** The initial decision to prefix every built-in command was superseded by
[PROP-0021](PROP-0021-command-namespaces-and-duplicates.md) and
[ADR-0021](../../decisions/ADR-0021-required-command-namespaces.md). Required built-in commands now
use their bare names; this proposal remains the record of the feature-module architecture.

## Problem

`PluginDescriptor` already describes first-party tools, but runtime ownership is split across the
central `World` constructor, `server/methods.ts`, and the TUI's command switch. TUI plugin commands
are indistinguishable from core commands, while Pi extension commands are exposed under their
unprefixed names. This makes feature ownership hard to follow and allows command-name conflicts to
be resolved by Pi's automatic suffixes instead of a clear owner decision.

Evidence: `src/world/world.ts` directly constructed the web, browser and annotation parts;
`src/server/methods.ts` owned their handlers alongside Wiki, history, worktree and refinement
handlers; `src/terminal/tui/commands.ts` held feature-page dispatch and exposed Pi commands as
`/<name>`.

## Affected rules

- **INV-PLG-5:** Everything model-visible belongs to a plugin. A new prompt section, tool group or
  tool is declared by a `PluginDescriptor` or reported as unattributed.
- **INV-TUI-2:** The Harness owns screen composition, input, scrolling, command routing and plugin
  UI. Pi owns the execution runtime, native history and rich content components.
- **INV-SRV-1:** `src/server/methods.ts` is the contract for every non-Node host. Renaming, removing,
  or changing the params or result shape of a method is an architecture change.

## Proposal

Add one internal typed registry of Harness-managed built-in plugin modules. A module may contribute
its existing descriptor, world part and cleanup, server-method handlers, and terminal command
metadata. The registry checks plugin IDs, terminal command names and built-in server-method names
for duplicates. It does not add category fields to `PluginDescriptor`, plugin responses, or storage.

The TUI uses `/plugin:<command>` for built-in and Pi extension commands. Core terminal commands
remain unprefixed. The built-in commands become `/plugin:doctor`, `/plugin:worktree`,
`/plugin:trajectory`, `/plugin:subagents`, `/plugin:notes`, and `/plugin:annotate`. Their former
unprefixed forms are removed at cutover. Prompt templates and the existing `/skill:<name>` syntax
keep their current behavior.

Pi extension commands are invoked through their registered handler and command context. Duplicate
extension names are omitted from completion and rejected with the owning extension paths when
invoked. A built-in command name is reserved against extension commands; the built-in remains
available and reports the colliding extension owner.

Ownership taxonomy is documentation only:

- **Foundation:** accounts, sessions and run recording, prompt/variant validation, the gate,
  plugin loading/trust/attachments, resource browsing, server and terminal frameworks, and the
  isolated browser engine/network safety.
- **World:** web tools, browser tools and page annotations.
- **Memory:** Wiki, history and trajectory.
- **Automation:** subagents, ask-user, checklist, lessons and refinement.
- **Integrations:** connected apps/MCP and Hub.
- **Operations:** doctor and worktrees.

The generic browser engine stays Foundation-owned. The browser plugin contributes the user-facing
tools through an adapter. Required and switchable plugin availability remains as before. Public
server method names, method schemas, stored data and capability gating do not change.

## Alternatives

- Keep the TUI switch and move only the annotation command. This leaves all feature commands and
  world assembly split across central dispatch points.
- Invoke extension handlers through rewritten user text. This relies on Pi's input parsing and
  would not provide one collision policy or a stable plugin command context.
- Expose plugin categories in the public descriptor. The categories are for ownership and
  documentation, and do not improve current runtime decisions or user flows.
- Do nothing. Feature ownership and command collisions stay implicit.

## Consequences

The built-in registry is the runtime source for first-party descriptors, world parts, server
handlers and command metadata. The terminal adapter still owns page construction and rendering.
Hosts retain the same RPC methods, tools pass through the same capability set and gate, and no
storage migration is needed. People update plugin slash commands to the `plugin:` prefix.

## Migration

Change all current terminal documentation and tests to the namespaced forms. Do not retain aliases
for old plugin command names. Keep the generic browser engine in Foundation and move only the
browser tools adapter under the browser plugin. Record plugin categories as an ownership taxonomy,
not public metadata.

## Checks

- Registry tests cover unique module IDs, command owners, duplicate server handlers and lifecycle
  part construction.
- Terminal tests cover built-in and Pi command completions, argument dispatch, duplicate-owner
  diagnostics and rejection of retired command names.
- Existing attachment tests continue to prove that switchable tool contributions obey the saved
  capability set.
- Run Harness typecheck, tests, build and `npm run prove`; run terminal PTY journeys and the App's
  typecheck, tests, layer check and Rust tests.
