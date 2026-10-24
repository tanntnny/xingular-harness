# ADR-0021 — Required built-in commands use the bare namespace

Status: Accepted (owner requested implementation of PROP-0021, 2026-10-24).
Supersedes: The command-namespace portion of [ADR-0018](ADR-0018-builtin-feature-plugins.md).
Related: [PROP-0021](../architecture/proposals/PROP-0021-command-namespaces-and-duplicates.md),
[11 Terminal](../architecture/11-terminal.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

The terminal has a set of required built-in features whose pages are part of normal Harness use.
Putting their commands behind `/plugin:` made them less direct to use. Separately, built-in and
loaded extension commands could both appear when their names matched a core command, alias or
prompt. Duplicate bridge registrations also exposed `/plugin:accounts`, `/plugin:hub`, and
`/plugin:plugins` beside their existing core commands.

## Decision

Commands owned by a required built-in plugin use the bare terminal namespace: `/subagents`,
`/trajectory`, `/doctor`, and `/worktree`. Optional built-in plugin commands, currently
`/plugin:notes` and `/plugin:annotate`, and Pi extension commands remain under `/plugin:<command>`.
Core commands `/accounts`, `/hub`, `/plugins`, and `/mcp` remain unprefixed.

An existing bare core command, alias, required built-in command, or loaded prompt reserves its
name. A colliding `/plugin:<name>` is absent from completion/help and direct invocation explains
which bare command to use. Duplicate extension registrations retain owner-path diagnostics. Remove
the bridge registrations that duplicate `/accounts`, `/hub`, and `/plugins`.

## Alternatives

Keeping all built-in commands namespaced preserves duplicate entries and makes required features
less direct to invoke. Unprefixing every built-in plugin command would also change the optional,
switchable Annotations commands. Suppressing only a fixed list of observed duplicate names would
allow the same problem to recur as plugins or prompts are added.

## Consequences

Required built-in command metadata determines the namespace used by terminal completion, help and
dispatch. A third-party extension whose command collides with a bare command or prompt must use a
different command name to expose both. There is no protocol or storage change.
