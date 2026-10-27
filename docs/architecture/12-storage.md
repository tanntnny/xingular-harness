# 12 Storage

## Purpose

The harness keeps two folders. The **data root** holds knowledge and history that may be shared
or synced: variants, refinements, the library, the Wiki, runs. The **state directory** holds
device-local state that must never travel with the data: accounts, secrets, approvals, trust,
connections, sockets. Files are the source of truth everywhere; the only database is a derived
index.

## Layout

```text
<data root>/
  variants/<scope>/   versions/<fingerprint>/{variant/, version.json}, head.json, lineage.jsonl, restores.jsonl   (03)
  refine/<id>/         summary.json, task.json, variants/, rollouts/, sessions/, context/, selection/, reflection/, improver/, or matrix.json + suite.json for evaluation matrices   (05)
                       rollouts/<label>/workspace/ only when started with retainWorkspaces
  library/<scope>/<area>/   INDEX.md, variants/<task>/{variant/, EXPERIENCE.md}   (05)
  annotations/<id>.json   page notes   (13, PROP-0017)
  wiki/                home.md, library/ (library/lessons/ from the lessons plugin), projects/<slug>/   (08)
  reflection/improver/lesson-<run id>/   a reflection's native history and reply   (08)
  wiki-history/        earlier versions of notes   (08)
  legacy/              an earlier Wiki's data, moved once   (08)
  registry/            skills/, prompts/, rules/: the component library   (03)
  plugins/<name>/      packages kept with the data   (06)
  plugin-proposals/<id>.json   pending and decided proposal text, hash and status; owned by plugins/proposals.ts   (06)
  trash/plugins/       removed packages   (06)
  hub/                 installed documents and provenance   (09)
  runs/<id>/           run.json (including optional legacy-compatible workspaceRoot), events.jsonl, owner.json, subagents.json, context.json, caller.json, capabilities.json, mcp-context.json   (02)
  # `checkpoint` and `heartbeat` are run events in the same events.jsonl; a bounded reply emits one
  # heartbeat per 30 seconds (about 60 KB an hour) and no side file (PROP-0041).
  config/              plugin-attachments.json and settings the harness reads   (06)
  agents/<name>.md     a person's global agent profiles; agents/profiles.ts owns it   (02, PROP-0029)
  index.sqlite         derived index (FTS5, recall, usage ledger)   (08, PROP-0042)
  projects.json        read only: the application owns it

<state dir>/
  accounts/            registry, per-account Pi agent folders, _shared/pi/, audit log   (09)
  secrets.json         default SecretStore, owner-only   (09)
  approvals.json       standing approvals   (07)
  plugin-trust.json, variant-plugin-trust.json, plugin-registered.json, plugin-hooks.json   (03, 06)
  connections.json     connected apps, no secrets   (09)
  hub/catalog.json     catalog cache   (09)
  run/                 terminal commands, and one session socket per Harness process,
                       harness-<pid>-<random>.sock; files of ended processes are pruned   (11)
  worktrees.json       managed worktree registry   (02, PROP-0016)
  worktrees/<repo>/<name>/   managed worktree checkouts; worktrees/logs/ setup output   (PROP-0016)
  worktree-setup-trust.json  trusted setup-script hashes, owner-only   (PROP-0016)
  browser/             isolated browser settings and profiles   (13)
  notes-bridge.json    the page bridge's port and token, kept so an app's script tag stays valid   (13, PROP-0018)
  harness.log          standalone terminal diagnostics
```

The interactive profile is a credential-free, versioned selection file at
`~/.xingular-harness/profile.json`, owned by `src/core/interactiveProfile.ts`. It selects the
interactive defaults: data root, state directory, default variant scope, and a credential-backend
descriptor. With no selected profile, the defaults are `~/.xingular-harness/data`,
`~/.xingular-harness/state`, scope `default`, and the state directory's owner-only file secret
store. A host may provide a stable host-backed secret adapter instead; the profile stores only its
identifier, never credentials. If that adapter is unavailable, startup fails rather than falling
back to a different store.

Explicit roots or variant scopes take precedence over the selected profile; the selected profile
precedes caller-supplied legacy defaults. Explicit adoption creates the profile file without
replacing an existing selection and does not create, copy, merge, or migrate data roots or
credentials. Existing account, variant, and session pins remain authoritative for their saved
runs; the profile selects defaults for new interactive work. `scripts/dev.mjs` and a development
interactive profile use `~/.xingular-harness-dev/{data,state}` and a separate profile file, not the
production defaults. The standalone development launch always selects a file SecretStore under its
resolved development state directory, even if that profile names a host backend; it does not use or
alter host credentials.

Side-question runs use the ordinary `runs/<id>/` records. Their temporary Pi native history is
created under the operating system temporary directory and removed when the run ends; it is not
retained in the data root or state directory.

## Invariants

- **INV-STO-1** Device-local state (credentials, approvals, trust, connections, sockets) is never
  written to the data root, and knowledge or history is never written to the state directory.
- **INV-STO-2** Files are the source of truth. `index.sqlite` can be deleted and rebuilt
  (`INV-MEM-5`); its migrations are append-only (`INV-MEM-6`).
- **INV-STO-3** Each folder has one owning module, named on its page. Another module reads it
  through that module's functions. A new top-level folder or a new file in `runs/<id>/` is an
  architecture change.
- **INV-STO-4** `projects.json` belongs to the application; the harness only reads it.
  Project agent profiles live in the repository at `<project>/.xingular/agents/<name>.md`; the
  harness writes them only through `agents.create` and `agents.remove` (PROP-0029).
- **INV-STO-5** Migrations of stored data are one-way and safe: the old data is backed up or left
  as it was when a migration fails, and the failure is reported in `Recovery.migrationError`.
- **INV-STO-6** Writes of shared JSON files are atomic (`core/fs.ts::atomicWrite`, `writeJson`).
- **INV-STO-7** Files holding trust or secrets are owner-only (`0600`).
- **INV-STO-8** `core/interactiveProfile.ts` owns the credential-free selection of interactive
  roots, default variant scope, and credential-backend descriptor. Explicit roots/scopes win; a
  selected profile wins over legacy defaults. Adoption never replaces a selection or merges roots,
  and a missing host credential adapter never silently downgrades to a file store. The standalone
  development launch explicitly selects its isolated file store; this is not a fallback for normal
  interactive profiles. Profile defaults do not replace the account, variant, or other pins on saved
  runs.

## Source map

`src/harness.ts` (`open`), `src/core/fs.ts`, `src/core/index.ts`, and the store module of each
part, listed on its page.
