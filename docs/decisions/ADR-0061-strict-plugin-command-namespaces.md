# ADR-0061 — Strict owner namespaces for plugin commands and prompts

Status: Accepted; implementation and surface acceptance not certified.
Amends: [ADR-0031](ADR-0031-plugin-command-owner-namespaces.md) and
[ADR-0034](ADR-0034-first-class-harness-terminal-commands.md) for plugin-owned routes.
Related: [06 Plugins and capabilities](../architecture/06-plugins-and-capabilities.md),
[10 Server protocol](../architecture/10-server-protocol.md),
[11 Terminal](../architecture/11-terminal.md), [parity register](../parity.md).

## Context

An owner-qualified extension command can coexist with a bare package prompt or alias, leaving
ownership unclear and allowing discovery order to decide what a person invokes. Package templates
and extension commands need one predictable namespace without changing standalone prompts, skills
or first-class Harness commands.

## Decision

Plugin-owned commands, including plugin-owned prompt templates, use
`/<owner-prefix>:<name>` only. No bare plugin command or template alias is offered in listing,
completion or dispatch. Existing core commands and their core aliases remain core; standalone
prompt templates retain their existing forms, and `/skill:<name>` remains reserved for skills.
Built-in default commands continue to use their namespace roots.

A package may set `harness.defaultPrompt` to the name of its own prompt template. The explicit,
valid and unambiguous selection makes `/<owner-prefix>:` invoke that template; no root is inferred
from an undeclared, missing, ambiguous or foreign template. Prefixes remain stable owner identities,
using `harness.commandPrefix` or the existing normalized fallback. When owners claim the same
prefix, or contributions within one owner claim the same route, including a template and an
extension command, the collision fails closed with owner diagnostics; discovery order never selects
a winner. The same rules apply to `commands.list`, completion, recognition and dispatch.

## Consequences

Plugin users must update bare plugin invocations to owner-qualified routes; standalone templates,
skills and core command routes are not renamed. Ownership does not grant attachment, code trust or
permission. The decision changes command routing and discovery, not protocol framing or persisted
run data. A listing is not evidence of surface acceptance. This record approves the contract; it
is not evidence that source or either surface has implemented it.

Page 14 states the same package-versus-standalone distinction.
