---
id: PROP-0023
title: Rename the published CLI command to xagent
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [11-terminal.md, package.json#bin, CLI documentation, ADR-0009]
---

# PROP-0023: Rename the published CLI command to xagent

## Problem

The package currently publishes `xharness` as its only executable, and invoking it without a
subcommand starts the Harness-owned OpenTUI terminal. The requested launch command is `xagent`.
The command name is a public CLI contract, so replacing it must update the package bin mapping,
help text, command examples, smoke checks, and the terminal specification.

## Affected rules

- Page 11 names `xharness` as the published executable and standalone terminal command.
- `package.json#bin`, the package lock, CLI usage, and command-specific help publish and document
  `xharness`.
- ADR-0009 records `xharness` as the sole published executable.

## Proposal

Publish `xagent` as the sole executable mapped to `dist/cli.js`. Invoking `xagent` without a
subcommand starts the existing OpenTUI terminal; `terminal` remains an explicit alias and the
existing subcommands remain available. Do not keep `xharness` as a compatibility alias. Keep the
npm package name, terminal runtime, data/state directory names, and environment-variable names
unchanged. Update command examples and regression/smoke checks to use `xagent`.

## Alternatives

- Keep `xharness` as an alias. This avoids disruption but does not replace the requested launch
  command.
- Rename the npm package. This is unrelated to the executable name.
- Do nothing. This leaves the requested command unavailable.

## Consequences

- Scripts and shell aliases using `xharness` must change to `xagent`.
- The rename is a breaking CLI change. It is included before publication of the 4.0.0 candidate;
  if `xharness` has already been released, the rename requires a new major release.
- No account, data, state, or server-protocol migration is required.

## Migration

Install `@xingular/harness` and launch the terminal with `xagent`. Update invocations of the former
`xharness` command. Existing `~/.xingular-harness/{data,state}` contents are reused unchanged.

## Checks

- `npm run typecheck` passed.
- `npm test` passed: 137 test files, 1,036 tests passed, 3 skipped; the focused CLI test also passed (2 tests).
- `npm run prove` passed, including the standalone server lifecycle.
- `node dist/cli.js --help` printed usage beginning with `xagent`.
- `npm pack --dry-run` passed and included the CLI, TUI bundle, and updated decision records.

The lasting decision is recorded in [ADR-0024](../../decisions/ADR-0024-xagent-command.md).
