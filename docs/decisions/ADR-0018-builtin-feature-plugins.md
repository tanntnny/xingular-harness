# ADR-0018 — Built-in feature modules and namespaced commands

Status: Accepted (owner requested implementation of the plan, 2026-10-24).
Related: [PROP-0020](../architecture/proposals/PROP-0020-builtin-feature-plugins.md),
[06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md),
[11 Terminal](../architecture/11-terminal.md).

## Context

First-party plugin descriptors existed, but runtime assembly, server handlers and TUI command
dispatch were centralized in separate files. Plugin commands shared the same unprefixed namespace
as core commands. Duplicate Pi extension commands were silently assigned suffixes by the SDK.

## Decision

Use a typed internal registry for built-in plugin modules. Modules own their existing plugin
descriptor and may supply world parts, public method handlers, terminal command metadata and
lifecycle. Foundation keeps plugin loading and trust, capability attachment and gating, the TUI
framework, and the generic isolated browser engine. Plugin commands use `/plugin:<command>`;
duplicate names are rejected with owner diagnostics. The ownership taxonomy is documentation only.

Retire old unprefixed forms for doctor, worktree, trajectory, subagents, notes and annotate at the
cutover. Public server methods and stored data keep their current names and shapes.

## Alternatives

Keeping direct central dispatch preserves the current drift between plugin descriptions and
runtime ownership. Exposing categories in public metadata adds a schema without a runtime need.
Letting the SDK suffix duplicate commands makes their identity depend on extension load order.

## Consequences

New Harness-managed features register through the built-in plugin registry. The terminal owns the
page adapter and UI; feature plugins contribute namespaced command metadata. Embedding hosts see
the existing method table and capability contracts.
