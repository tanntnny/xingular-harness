---
id: ADR-0035
title: One launch and command contract for every front end
status: Accepted
created: 2026-11-19
proposal: PROP-0040
---

# ADR-0035: One launch and command contract for every front end

## Decision

The owner approved Complete App parity and Solo tabs; accepted
[PROP-0040](../architecture/proposals/PROP-0040-one-launch-path.md) records the Harness contract.
The foundation owns one interactive launch policy, not a policy per renderer:

- `Launch.standard` supplies shared role, working-folder and connection guidance. Hosts add only
  attributed context, policy and declared add-ons through existing extension points.
- `commands/registry.ts` defines core commands; `commands.list` adds effective plugin commands,
  prompts and skills. Session history controls use `sessions.*`; live-session operations use
  `SessionRunInput.command` and the normal run lifecycle.
- Both surfaces load Harness-selected trusted resources and first-party hooks. Pi CLI built-ins
  and the terminal-only question alias are excluded; attended planning uses `ask_user`.
- Interactive defaults (roots, neutral variant scope and credential backend), shared session
  references, browser schemas and frozen capability discovery belong to Harness. Explicit choices
  and historical pins win. Existing profiles are never silently merged or credentials copied.
- Optional `surfaces` metadata describes a host preference and a terminal fallback or unavailability;
  it neither creates a plugin category nor grants permission.

## Consequences and alternatives

Separate front-end defaults and command implementations make identical labels promise different
behavior. A shared contract permits richer presentation without a second loader, gate or state owner.
Host-backed tools must refuse unsupported semantics honestly. Matching roots alone does not share
credentials when the backends differ.

This is an accepted design, not release or acceptance evidence. Shared-default adoption, actual
runtime pins, native browser behavior, actionable command pages and cross-surface session discovery
remain subject to implementation and both-surface acceptance. The [parity register](../parity.md)
tracks source status and gaps; compiler-only equality tests do not establish runtime parity.
