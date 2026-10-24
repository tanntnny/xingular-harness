---
id: ADR-0024
title: Publish the Harness CLI as xagent
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0023]
supersedes: ADR-0009
---

# ADR-0024 — Publish the Harness CLI as xagent

## Context and decision drivers

The Harness CLI's no-subcommand path starts the standalone OpenTUI terminal. The current executable
name, `xharness`, is being replaced by the requested shorter product command, `xagent`. The
published command is part of the package's public interface.

## Decision

Publish `@xingular/harness` with one executable, `xagent`, mapped to `dist/cli.js`. Invoking
`xagent` without arguments starts the existing OpenTUI terminal. Do not retain `xharness` as a
compatibility alias. Keep the package name, `terminal` alias, host subcommands, data/state directory
names, and `XINGULAR_HARNESS_*` environment variables unchanged.

This supersedes ADR-0009's executable-name decision and the `xharness` command-name portion of
ADR-0014. Other release-baseline decisions remain unchanged.

## Consequences

- Users and scripts that invoke `xharness` must migrate to `xagent`.
- No account, data, or state migration is required.
- If `xharness` has already been released, replacing it requires a new major version; this change is
  intended for the unpublished 4.0.0 candidate.

## Implementation and verification

- The `bin` mapping and CLI help are tested by [`src/cli.test.ts`](../../src/cli.test.ts).
- The implementation and migration notes are tracked in
  [PROP-0023](../architecture/proposals/PROP-0023-xagent-cli-name.md).
