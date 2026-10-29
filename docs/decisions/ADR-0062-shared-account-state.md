---
id: ADR-0062
title: A launch signs in as the account state it is given, and development shares the installed one
status: Accepted
created: 2026-10-29
---

# ADR-0062: A launch signs in as the account state it is given, and development shares the installed one

## Context

Account identity was welded to the launch's state directory: a registry, one agent folder per
account and the owner-only `secrets.json` that holds their credentials, all under `<state dir>`.
`npm run dev` passes its own `~/.xingular-harness-dev/state`, so it started with no accounts, and a
person had to sign in again — a second OAuth flow, a second set of tokens and, for a subscription
provider, a second live sign-in — before the development terminal could run anything. The
installed `xagent` on the same machine had the sign-in the person actually wanted to use.

Signing in twice is not just friction. A subscription provider's OAuth flow rotates credentials,
and two independently signed-in copies are two sessions the provider sees; keeping them identical
by hand is not something a person can do.

## Decision

The account identity of a launch is a folder, not a fixed child of its state directory:

- `HarnessOptions.accountsDir` selects where the registry, the per-account Pi agent folders and
  their shared settings live. It defaults to `<state dir>/accounts`, so every existing caller is
  unchanged.
- The standalone terminal accepts `--account-state <dir>`, which uses that state directory's
  `accounts/` folder and its `secrets.json`. A launch that shares an account folder must use the
  secret store those account ids belong to; both halves travel together.
- `scripts/dev.mjs` passes `--account-state ~/.xingular-harness/state` unless the person names
  another one, so the development terminal signs in as the installed command's accounts and a
  single sign-in serves both launches.

Development keeps its own data root, state directory, approvals, plugin trust and connections.
Only the account identity is shared.

## Rationale

- **One identity, not a copy.** Two credential files that must stay equal is the failure this
  removes. The registry, the account folders and the credential file are read and written by both
  launches through the same paths and the same credential lock, which is the concurrency two
  windows of the installed command already have.
- **The option belongs to the launch, not to a profile field.** A profile selects defaults; a
  launch that wants another state's accounts names that state explicitly, and the terminal prints
  nothing implicit about it. The host (`serve`) keeps deciding its own account identity, as the
  App does with its own keychain.
- **The development launcher decides the sharing.** Keeping data and approvals separate was the
  point of `~/.xingular-harness-dev`; signing in twice was the accident. Sharing only the identity
  keeps both properties, and `--account-state` restores full isolation in one flag.

## Consequences

- A credential written by either launch is the credential of the other. A sign-out in development
  signs out the installed command too; this is the same account, not a sandbox of it. Pi's native
  sessions under each account folder are shared the same way, while run records stay in each
  launch's own data root.
- Both launches write the one `secrets.json` under the same lock directory, and the one
  `accounts.json` through atomic replacement. That is the concurrency the installed command
  already allows between two of its own windows.
- Accounts created in the dev state before this change are not migrated. Their registry, folders
  and credentials remain under `~/.xingular-harness-dev/state`; signing in to the shared identity
  is the deliberate replacement.
- `docs/architecture/09-accounts-and-connectors.md`, `11-terminal.md` and `12-storage.md` state the
  selected account folder rather than a fixed `<state dir>/accounts`.
