# ADR-0031 — Plugin commands use owner-qualified namespaces

Status: Accepted (PROP-0031, 2026-10-25).
Supersedes: The command-namespace decision in [ADR-0021](ADR-0021-required-command-namespaces.md).
Related: [PROP-0031](../architecture/proposals/PROP-0031-plugin-command-owner-namespaces.md),
[11 Terminal](../architecture/11-terminal.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md),
[06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md).

## Context

The generic `/plugin:<command>` form hid command ownership for optional built-ins and Pi extensions,
while required built-ins used a separate bare-command rule. Both forms left a global collision surface
and made help, completion and invocation inconsistent across owners. Annotation routes also used the
generic plugin prefix despite the plugin's annotation-focused purpose.

## Decision

Every plugin-owned terminal command is invoked as `/<owner-prefix>:<command>`, regardless of whether
the owner is a required built-in, optional built-in or Pi extension. Core terminal commands remain
unprefixed, and `/skill:<name>` remains reserved for skill invocation. Built-in plugins use stable
prefixes; Pi packages may set `harness.commandPrefix` and otherwise derive the prefix from normalized
package identity, while loose extensions use normalized extension names. Prefixes identify owners and
must be unique; duplicate commands within an owner and owner-prefix collisions are rejected with
source diagnostics.

A built-in plugin module may choose a default command for its namespace root. Web annotations uses `/annotate:` for
capture, `/annotate:annotate` as an equivalent alias, and `/annotate:notes` for saved annotations.
For one release, the previous `/plugin:<command>` and bare required-plugin forms remain hidden
compatibility aliases when unambiguous. They are omitted from help and completion.

## Consequences

The namespace rule applies uniformly to completion, help, highlighting and dispatch. Plugin packages
may opt into a stable custom prefix with `harness.commandPrefix`. The compatibility aliases expire
after one release and should not be used for new scripts or keybindings. This changes no server method,
capability identifier, account data or annotation storage format.
