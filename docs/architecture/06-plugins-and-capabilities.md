# 06 Plugins and capabilities

## Purpose

A *plugin* is a bundle with a title, a description and contributions: instructions, skills,
commands, tools, connections, code (a Pi extension) and themes. A Pi package is a plugin as it is;
so are the harness's own parts, the application's parts, a person's registry, the folder every
account shares, and what a working folder brings. This part decides what a session loads, who has
what switched on, which code may run, and what reaches one caller. A *capability set* is the
callable result for one run.

## Components

| Type / function | Module | Role |
|---|---|---|
| `Plugin`, `Contribution`, `PluginDescriptor`, `CONTRIBUTION_KINDS`, `PLUGIN_SOURCES` | `plugins/types.ts` | The model of a plugin and what it brings. |
| `Plugins` (`loading`, `loaded`) | `plugins/plugins.ts` | Chooses the paths a session or terminal loads; records what each extension registered. |
| discovery | `plugins/discover.ts` | Finds items with Pi's own resolver, which runs no extension code. |
| attachments (`load`, `save`, `attached`, `decided`, `set`) | `plugins/attachments.ts` | The one store of what is switched on, per scope. |
| `HARNESS_PLUGINS` | `plugins/builtin.ts` | Descriptors of the harness's own parts: `pi`, `harness`, `subagents`, `wiki`, `history`, `ask-user`, `checklist`, `connected-apps`. |
| `FIRST_PARTY_PLUGINS` | `plugins/firstParty.ts` | `output-trim`, `budget-guard`: inline extensions shipped switched off. `lessons`: switched off; its contribution turns on reflection after a run (page 08, PROP-0008) and loads no Pi code. |
| `Hooks` | `plugins/hooks.ts` | Runs a package's hooks file after a write. |
| install / trust | `plugins/install.ts`, `plugins/trust.ts` | Install through Pi's package manager with scripts off; trust code by hash. |
| inventory / api | `plugins/inventory.ts`, `plugins/api.ts` | `plugins.list`, `plugins.inventory`, attach, trust. |
| capability api | `capabilities/api.ts`, `capabilities/types.ts` | `list`, `resolve`, `toolIntersection`, `inventory`, `attach`. |
| run snapshot | `capabilities/runSnapshot.ts` | `freezeRun`, `loadRun`, `capabilitySet`. |

## Contracts

- **Loading.** `Plugins.loading({ cwd, agentDir, caller, contributions, install? })` returns
  `extensionPaths`, `skillPaths`, `promptPaths`, `themePaths`, `builtins` (terminal only), `hooks`,
  `found`, `detached`, `projectCode`, `packageCode`. A session opens Pi with its own discovery off
  and only these paths; a terminal receives them as `--extension`, `--skill`,
  `--prompt-template` and `--theme` after `--no-extensions --no-skills --no-prompt-templates
  --no-themes`. Pi still reads `AGENTS.md` and `SYSTEM.md` itself.
- **Attachments.** `config/plugin-attachments.json` holds `global`, `agents`, `projects` (each
  `{ on, off }`) and `settings` per plugin. The narrowest scope that says something wins: agent,
  then project, then everywhere. With no entry an item keeps its default.
- **Hooks.** A package declares `"harness": { "extends": [...], "hooks": "./hooks.mjs" }`. Events:
  `wiki.page.saved`, `history.run.ended`. A hook has 30 seconds; its errors are kept in
  `plugin-hooks.json`. `ctx.call(connection, tool, args)` reaches only a connected app that is on
  for everyone, and only a tool marked to run without asking.
- **Capability set** (`CapabilitySet`): `{ version: 1, tools, connectors, contributions }`.
  `capabilities.resolve` returns the set available to a caller; `capabilities.intersect` /
  `toolIntersection` narrows it for a child.

## Invariants

- **INV-PLG-1** The harness is the only loader. A session or terminal loads exactly what
  `Plugins.loading` chose, with Pi's discovery switched off. Never pass a session a loader that
  discovers on its own.
- **INV-PLG-2** Code waits for trust. A working folder's `.pi/extensions` and the packages its
  settings name are trusted together; each installed package is trusted on its own. Trust is a
  hash of the files; a changed file asks again. A loose file a person put in the shared
  `extensions/` folder needs no trust. Text contributions always load.
- **INV-PLG-3** Installing runs no code (`npm_config_ignore_scripts`). A package arrives switched
  off and, if it has code, untrusted. Installing grants no attachment, trust, credential or
  permission.
- **INV-PLG-4** The approval gate is the last extension to see a tool call (page 07, `INV-GATE-2`).
  A plugin that changes a call's input does so before the gate sees it.
- **INV-PLG-5** Everything model-visible belongs to a plugin. A new prompt section, tool group or
  tool is declared by a `PluginDescriptor` (`plugins/builtin.ts` for the harness's own), or
  `plugins.inventory` reports it as `unattributed`.
- **INV-PLG-6** One store says what is switched on: `plugins/attachments.ts`. A new kind of
  switchable thing gets a default and is read with `attached`; no second enablement file.
- **INV-PLG-7** A hook is told, never asked. Hooks run after the write, in the background; a write
  never waits for a hook and a hook's failure never reaches it. A new write point that should be
  heard calls `noteChange` (`core/changes.ts`). No hook may stop or change a write.
- **INV-PLG-8** A hook runs only while its plugin is on for everyone and trusted, checked before
  each delivery. A working folder's package cannot bring a hook.
- **INV-PLG-9** Unattended runs load no extension found on disk (`INV-RUN-5`). The harness's own
  parts are required and refuse to be switched off; switching something on grants no permission.
- **INV-CAP-1** A capability set only narrows. `intersect` never adds access; a run's set is
  frozen when it starts (`INV-RUN-2`).
- **INV-CAP-2** The capability contract is generic. It names no application task, role or UI
  concept.
- **INV-CAP-3** A capability set says what may be called, not whether a call may run. The gate
  still decides each call.

## Data

```text
<data root>/config/plugin-attachments.json     (registry-enabled.json read until the first change)
<data root>/plugins/<name>/                     packages kept with the data; removal moves to trash/plugins/
<state dir>/plugin-trust.json                   trusted code, by hash
<state dir>/plugin-registered.json              what each extension registered last time
<state dir>/plugin-hooks.json                   hooks and their last run
<state dir>/accounts/_shared/pi/                settings and packages shared by every account
```

## Source map

`src/plugins/*.ts`, `src/capabilities/*.ts`, `src/core/changes.ts`.
