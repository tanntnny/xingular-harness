---
id: PROP-0031
title: Namespace plugin commands by owner
status: Implemented
created: 2026-10-25
updated: 2026-10-25
affects: [INV-TUI-7, 06-plugins-and-capabilities.md, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md, README.md, ADR-0021, ADR-0031]
---

# PROP-0031: Namespace plugin commands by owner

## Problem

The terminal currently uses `/plugin:<command>` for optional built-in and Pi extension commands, but bare names for commands owned by required built-ins. The generic `plugin` prefix does not identify the owner and still requires global command-name collision handling. Annotation commands are exposed as `/plugin:annotate` and `/plugin:notes`, while the plugin is named `Page notes` despite supporting interactive web annotation.

Evidence: `src/plugins/builtinRegistry.ts` selects `unprefixed` or `plugin` from `descriptor.required`; `src/terminal/tui/commands.ts` routes the single `plugin:<name>` namespace; Pi commands are grouped only by command name and `sourceInfo.path`.

## Affected rules

- **INV-TUI-7** currently says required built-in commands use unprefixed names and optional built-in/Pi extension commands use `/plugin:<command>`.
- **14 Surfaces and parity, Contracts** currently says optional built-in and Pi extension commands use `/plugin:<command>`.
- **ADR-0021** records bare required built-ins and the generic `/plugin:<command>` form. This proposal supersedes its command-namespace decision.

## Proposal

Every plugin-owned terminal command uses `/<owner-prefix>:<command>`, whether the owner is a required built-in, optional built-in, or Pi extension. Core terminal commands remain bare. Help, completion, dispatch, and duplicate diagnostics all use the same owner-qualified route. A collision is determined by the complete owner-prefix/command pair; different plugins may use the same command name.

Built-in modules declare a stable command prefix (defaulting to a validated slug derived from the plugin id, with explicit overrides where the public slug differs). Pi package extensions use `harness.commandPrefix` when declared and otherwise a normalized package name; loose extensions use a normalized extension name. Prefix collisions between owners and duplicate commands within an owner are reported with their source paths rather than silently routed. The `skill:` namespace remains reserved for skill invocation.

A built-in plugin module may declare a default terminal command for the owner root. The annotations plugin uses prefix `annotate`: `/annotate:` opens the capture pane, `/annotate:annotate` is an equivalent discoverable alias, and `/annotate:notes` opens the saved-annotations page. Its public plugin title becomes **Web annotations**. The stable plugin id, stored note schema, `annotations.*` methods, and `page_notes_*` tools do not change.

For one release, retain the existing `/plugin:<command>` forms and prior bare required-plugin forms as compatibility aliases when they still resolve unambiguously. These aliases are not shown in help or completion. Core commands keep precedence. Prompt templates and `/skill:<name>` keep their existing behavior.

## Alternatives

- Keep `/plugin:<command>` and only rename the annotations plugin. This leaves plugin ownership hidden and preserves a global collision surface.
- Namespace only optional plugins. This retains two command rules and leaves required plugin commands able to collide with core or prompt names.
- Use each plugin's display title as its prefix. Titles are presentation and can change; route identity must remain stable.
- Do nothing. The generic prefix and current naming ambiguity remain.

## Consequences

The terminal command contract and `BuiltinPluginRegistry` metadata change. A plugin package may optionally declare `harness.commandPrefix`; packages without the field continue to work with a normalized source-derived prefix. No server method, capability set, data root, stored note, or run record changes. Host surfaces continue to use Harness methods; the Web annotations title is part of `plugins.list` metadata.

## Migration

New commands become owner-qualified. Existing generic and bare forms remain temporary aliases for one release, without appearing in completion or help. Scripts and keybindings should migrate to the owner-qualified forms. Removing the aliases later requires a release note; no stored-data migration is needed.

## Checks

- Registry and terminal tests cover prefix validation, owner-qualified routing, default plugin roots, aliases, extension identity, collisions, help, and completion.
- Annotation tests cover `/annotate:`, `/annotate:annotate`, `/annotate:notes`, and the Web annotations title.
- Run Harness typecheck, tests, and `npm run prove`.
- Run Xingular Agent typecheck, tests, layer checks, and Rust tests; inspect terminal completion and the host's annotation/plugin presentation.
