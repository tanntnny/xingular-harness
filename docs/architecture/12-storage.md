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
  trash/plugins/       removed packages   (06)
  hub/                 installed documents and provenance   (09)
  runs/<id>/           run.json, events.jsonl, owner.json, subagents.json, context.json, caller.json, capabilities.json, mcp-context.json   (02)
  config/              plugin-attachments.json and settings the harness reads   (06)
  index.sqlite         derived index (FTS5)   (08)
  projects.json        read only: the application owns it

<state dir>/
  accounts/            registry, per-account Pi agent folders, _shared/pi/, audit log   (09)
  secrets.json         default SecretStore, owner-only   (09)
  approvals.json       standing approvals   (07)
  plugin-trust.json, variant-plugin-trust.json, plugin-registered.json, plugin-hooks.json   (03, 06)
  connections.json     connected apps, no secrets   (09)
  hub/catalog.json     catalog cache   (09)
  run/                 the session socket and terminal commands   (11)
  worktrees.json       managed worktree registry   (02, PROP-0016)
  worktrees/<repo>/<name>/   managed worktree checkouts; worktrees/logs/ setup output   (PROP-0016)
  worktree-setup-trust.json  trusted setup-script hashes, owner-only   (PROP-0016)
  browser/             isolated browser settings and profiles   (13)
  notes-bridge.json    the page bridge's port and token, kept so an app's script tag stays valid   (13, PROP-0018)
  harness.log          standalone terminal diagnostics
```

## Invariants

- **INV-STO-1** Device-local state (credentials, approvals, trust, connections, sockets) is never
  written to the data root, and knowledge or history is never written to the state directory.
- **INV-STO-2** Files are the source of truth. `index.sqlite` can be deleted and rebuilt
  (`INV-MEM-5`); its migrations are append-only (`INV-MEM-6`).
- **INV-STO-3** Each folder has one owning module, named on its page. Another module reads it
  through that module's functions. A new top-level folder or a new file in `runs/<id>/` is an
  architecture change.
- **INV-STO-4** `projects.json` belongs to the application; the harness only reads it.
- **INV-STO-5** Migrations of stored data are one-way and safe: the old data is backed up or left
  as it was when a migration fails, and the failure is reported in `Recovery.migrationError`.
- **INV-STO-6** Writes of shared JSON files are atomic (`core/fs.ts::atomicWrite`, `writeJson`).
- **INV-STO-7** Files holding trust or secrets are owner-only (`0600`).

## Source map

`src/harness.ts` (`open`), `src/core/fs.ts`, `src/core/index.ts`, and the store module of each
part, listed on its page.
