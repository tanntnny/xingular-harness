---
id: ADR-0009
title: Publish the Harness CLI as xharness
status: accepted
created: 2026-10-22
updated: 2026-10-22
related: [PROP-0005]
supersedes: null
superseded_by: null
---

# ADR-0009 — Publish the Harness CLI as xharness

## Context and decision drivers

The published package used `xingular-harness` as its executable, while the desired short command is
`xharness`. The CLI already starts the Harness-owned OpenTUI terminal when invoked without a
subcommand, so the frontend and session runtime need no changes. The npm registry's latest release
is `3.0.0`; replacing the published executable is a breaking change.

## Decision

Publish `@xingular/harness` `4.0.0` with one binary, `xharness`, mapped to `dist/cli.js`. Do not
ship `xingular-harness` as a compatibility alias. Keep the package name, `terminal` alias, host
subcommands, data/state directory names, and `XINGULAR_HARNESS_*` environment variables unchanged.

## Consequences

- Users and scripts that invoke `xingular-harness` must migrate to `xharness`.
- Running `xharness` with no command opens the existing OpenTUI terminal.
- No account, data, or state migration is required.
- The release requires Node 22.19+ and Bun 1.3.14+ for the standalone terminal build/runtime.

## Implementation and verification

- The `bin` mapping and CLI help are tested by [`src/cli.test.ts`](../../src/cli.test.ts).
- CI, the packed-tarball smoke test and the npm publication blocker are recorded in
  [PROP-0005](../architecture/proposals/PROP-0005-xharness-cli-name.md).
