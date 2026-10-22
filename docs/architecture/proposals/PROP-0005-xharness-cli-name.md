---
id: PROP-0005
title: Rename the published CLI command to xharness
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [11-terminal.md, package.json#bin, CLI documentation]
---

# PROP-0005: Rename the published CLI command to xharness

## Problem

The published `@xingular/harness` package exposes the `xingular-harness` executable through its
`bin` entry. The requested public command is `xharness`, which should open the existing standalone
OpenTUI terminal when invoked without a subcommand. The CLI already routes a no-command invocation
to that terminal; this proposal changes the published executable name and its documentation, not
the terminal runtime.

The npm registry currently reports `3.0.0` as the latest version. Removing the published command
is a breaking CLI change.

## Affected rules

- `docs/architecture/11-terminal.md` identifies the standalone terminal application as
  `xingular-harness`.
- `package.json#bin` and the package lock expose `xingular-harness` as the installed command.
- CLI help and user documentation use `xingular-harness` for the public executable.

## Proposal

Publish `@xingular/harness` version `4.0.0` with a single `xharness` executable pointing to
`dist/cli.js`. Do not retain `xingular-harness` as an alias, consistent with the requested
replacement. Invoking `xharness` without arguments starts the existing OpenTUI terminal; `terminal`
and the existing subcommands remain available.

Update the CLI help/comments, package manifest and lockfile, terminal architecture page, README,
terminal guide and changelog to use `xharness` for invocations. Add regression coverage for the
published `bin` name and help text. Keep the npm package name `@xingular/harness`, the data and
state directory names, and `XINGULAR_HARNESS_*` environment variables unchanged.

Build and verify the package with the repository CI checks, inspect the packed tarball, install the
local tarball to test `xharness --help` and interactive TUI startup, publish to npm, then verify the
registry metadata and a fresh global install.

## Alternatives

- Keep `xingular-harness` as a compatibility alias while recommending `xharness`. This reduces
  disruption but does not fully replace the command as requested.
- Rename the npm package itself. This is unnecessary: the request concerns the executable, and
  changing the package name would create a separate migration.
- Do nothing. This leaves the published interface unchanged.

## Consequences

- Existing scripts and instructions invoking `xingular-harness` must change to `xharness`.
- Removing the old executable is a breaking change, hence the proposed major version bump.
- Existing Harness data, account state and environment-variable overrides remain in place; no data
  migration is needed.
- The package still requires Node 22.19+ and Bun 1.3.14+ to build and run the standalone TUI.

## Migration

Install `@xingular/harness@4.0.0` and launch the terminal with `xharness`. Update scripts or shell
aliases that invoke `xingular-harness`. Existing `~/.xingular-harness/{data,state}` contents are
reused without conversion.

## Checks

- `npm run ci` passed: typecheck, 742 tests (3 skipped), build and standalone proof.
- `npm pack --dry-run` passed and included the CLI and OpenTUI bundles.
- A temporary global install from the tarball exposed only `xharness`; `xharness --help` showed the
  new usage and a TTY launch rendered the Harness welcome screen.
- Publication was attempted, but npm returned E404. `npm whoami` returned E401, and the registry
  still reports `3.0.0` as latest; `4.0.0` has not been published. Retry after restoring npm
  authentication and package publish permission.

The decision is recorded in [ADR-0009](../../decisions/ADR-0009-xharness-command.md).
