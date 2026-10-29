# 06 Plugins and capabilities

## Purpose

A *plugin* is a bundle with a title, a description and contributions: instructions, skills,
commands, subagent profiles (`agent`), tools, connections, code (a Pi extension) and themes. A Pi package is a plugin as it is;
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
| `BuiltinPluginRegistry`, `BuiltinPluginModule` | `plugins/builtinRegistry.ts`, `plugins/builtin.ts` | Registers built-in modules and their descriptors, world parts, server handlers and plugin-owned terminal commands. Harness core commands live in `commands/registry.ts`, shared by both surfaces. |
| `HARNESS_PLUGINS` | `plugins/builtin.ts` | Descriptor view of the registered Harness parts and feature plugins. |
| `FIRST_PARTY_PLUGINS` | `plugins/firstParty.ts` | `output-trim`, `budget-guard`: inline extensions shipped switched off. `lessons`: switched off; its contribution turns on reflection after a run (page 08, PROP-0008) and loads no Pi code. |
| `Hooks` | `plugins/hooks.ts` | Runs a package's hooks file after a write. |
| install / trust | `plugins/install.ts`, `plugins/trust.ts` | Install through Pi's package manager with scripts off; trust code by hash. |
| proposals | `plugins/proposals.ts` | Validate and store inert proposals; preview, reject or accept a hash-bound review. |
| inventory / api | `plugins/inventory.ts`, `plugins/api.ts` | `plugins.list`, `plugins.inventory`, attach, trust. |
| capability api | `capabilities/api.ts`, `capabilities/types.ts` | `list`, `resolve`, `toolIntersection`, `inventory`, `attach`. |
| run snapshot | `capabilities/runSnapshot.ts` | `freezeRun`, `loadRun`, `capabilitySet`. |

## Contracts

- **Loading.** `Plugins.loading({ cwd, agentDir, caller, contributions, install? })` returns
  `extensionPaths`, `skillPaths`, `promptPaths`, `themePaths`, `profilePaths`, `builtins` (legacy shape; no Pi CLI built-ins selected), `hooks`,
  `found`, `detached`, `projectCode`, `packageCode`. `profilePaths` are read by the harness for
  subagent profiles (page 02); Pi is never given them. A session opens Pi with its own discovery off
  and only these paths; a terminal receives them as `--extension`, `--skill`,
  `--prompt-template` and `--theme` after `--no-extensions --no-skills --no-prompt-templates
  --no-themes`. Pi still reads `AGENTS.md` and `SYSTEM.md` itself.
- **Surface metadata (PROP-0040).** `PluginDescriptor.surfaces` and `Plugin.surfaces` optionally
  carry `{ preferred: 'host', terminal: 'fallback' | 'unavailable', note: string }`.
  `plugins/surfaces.ts` formats the note and badge. Inspection explains what the host adds and
  what the terminal does instead; this is not a category, attachment switch or permission.
- **Shared resources (PROP-0040).** Both surfaces load Harness-selected resources and enabled
  first-party hooks, including output trim and budget guard. Terminal preparation exposes these
  through its protected bridge. Pi CLI-only llama.cpp, codemode, tool-search and MCP built-ins are
  not selected or advertised as extra terminal capabilities. This does not remove Harness MCP.
- **Attachments.** `config/plugin-attachments.json` holds `global`, `agents`, `projects` (each
  `{ on, off }`) and `settings` per plugin. The narrowest scope that says something wins: agent,
  then project, then everywhere. With no entry an item keeps its default.
- **Package metadata.** A Pi package may declare `"harness": { "extends": [...], "hooks": "./hooks.mjs", "commandPrefix": "my-tools", "defaultPrompt": "review", "agents": "./agents" }`.
  `defaultPrompt` names one of that package's prompt templates as the target of `/<owner-prefix>:`;
  it is not a path or an arbitrary command. Without a valid, unambiguous owned target, it must not
  route to another owner's template or guess a default (ADR-0061).
  A package without a `package.json` name is named, described and versioned by the first of
  `plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, so an agent plugin
  written for other harnesses installs as it is.
- **Package subagent profiles.** An installed package's agents folder (`agents/` unless
  `harness.agents` names another) brings each Markdown file whose frontmatter has a `name` and a
  `description` as an `agent` contribution (at most 50). It is text: it needs no trust and follows
  its switch like a skill. The profile is named by its frontmatter, not its file. Fields only other
  harnesses understand are dropped (`agents/profiles.ts`, `parsePackageProfile`): their tool names
  are translated (`Read`→`read`, `Glob`→`find`, …), a model without a provider is left to the
  parent, `plugins` and `variant` are never taken, and a tool list of which nothing translates
  keeps the child read-only. A package profile never replaces a built-in, person's, project's or
  variant's profile of the same name; the listing reports it as a problem instead.
  `commandPrefix` is optional; in the terminal, commands otherwise use a normalized package name as
  their owner prefix. Prefixes use lowercase letters, digits and hyphens, starting with a letter;
  `plugin` and `skill` are reserved. Package-owned prompt templates share the package's command
  namespace with its extension commands; prompts discovered by a loose extension use that
  extension's namespace. Neither is exposed as a bare plugin alias. Standalone prompt templates
  retain their existing form. See page 11 for routing and collision rules.
- **Plugin authoring.** `plugin_propose` creates a pending proposal, not an installation. The
  release-owned `plugin-authoring` skill is available on demand in structured and terminal sessions;
  a pinned variant's skill of the same name wins. It adds no trust or permission
  ([ADR-0045](../decisions/ADR-0045-default-plugin-authoring-skill.md)).
- **Proposal review.** `plugins/proposals.ts` validates a lowercase package name, nonempty description,
  and 1–100 UTF-8 text files (256 KiB each, 1 MiB total). It accepts `README.md`, extensions
  (`.ts`, `.js`, `.mjs`), Markdown skills, prompts and agents, and JSON themes in their respective
  directories; paths must be safe and cannot contain `.git` or `node_modules`. A
  `skills/<name>/SKILL.md` needs matching name and nonempty description frontmatter. The Harness
  generates `package.json`; it is not supplied by the proposal. Preview revalidates the stored data
  and computes SHA-256 over name, description, generated manifest and sorted file entries. Accept
  and reject require the current preview hash and pending status; stale reviews fail.
  Acceptance rechecks after adoption and listing, refuses an existing package name or already-trusted
  identical package code, stages and publishes under `<data root>/plugins/<name>`, clears old
  attachment decisions for that package and explicitly switches it off globally. It grants no code
  trust or permission; reject retains the proposal as rejected. These are trusted caller review
  operations, not model tools. See [ADR-0046](../decisions/ADR-0046-hash-bound-plugin-proposals.md).
- **Hooks.** A package declares `"harness": { "extends": [...], "hooks": "./hooks.mjs" }`. Events:
  `wiki.page.saved`, `history.run.ended`. A hook has 30 seconds; its errors are kept in
  `plugin-hooks.json`. `ctx.call(connection, tool, args)` reaches only a connected app that is on
  for everyone, and only a tool marked to run without asking.
- **Capability set** (`CapabilitySet`): `{ version: 1, tools, connectors, contributions }`.
  `capabilities.resolve` returns the set available to a caller; `capabilities.intersect` /
  `toolIntersection` narrows it for a child. The required `ask-user` plugin remains attached, but its
  `ask_user` tool is included only for an attended plan run or a continuation pinned with that
  capability. Automatic or refinement-triggered continuations with it are rejected rather than
  weakening the frozen set. The `side-questions` descriptor owns the fixed instruction for the
  restricted side-question run; it has no tools, providers, connectors, subagents or variant code
  (PROP-0019). In plan mode, delegation is limited to research children: the resolved profile must
  have explicit tool and plugin allowlists confined to the research set, and the child's frozen
  capabilities are intersected with the parent and profile. A profile name or its instructions alone
  never grants eligibility (INV-RUN-8).

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
  A side-question run also has no variant plugin code or tool guidance (PROP-0019).
- **INV-PLG-10** Every Harness-managed built-in feature is registered by `BuiltinPluginRegistry`.
  Its descriptor, world tools, server handlers and any plugin-owned terminal commands share one
  owner. First-class Harness terminal commands are registered by the terminal command registry and
  do not depend on a feature plugin's command metadata or attachment state. A module's world part
  releases resources through the existing session and Harness lifecycle. This registry does not
  load third-party Pi code or bypass its trust checks.
- **INV-PLG-11** Built-in plugin categories are a documentation ownership taxonomy. They are not a
  `PluginDescriptor` field, a public response field or a second attachment scope.
- **INV-PLG-12** Plugin command ownership includes plugin-owned prompt templates. An owner prefix
  identifies exactly one owner; prefix collisions between owners and duplicate routes within an
  owner fail closed with owner diagnostics, including collisions between a template and an extension
  command. Package `harness.defaultPrompt` can select only its own unambiguous template for the
  namespace root. Ownership does not change attachment, code trust or permission rules.
- **INV-CAP-1** A capability set only narrows. `intersect` never adds access; a run's set is
  frozen when it starts (`INV-RUN-2`). An agent profile's `plugins` list keeps only the parent's
  contributions of those plugins (required plugins always stay) and drops the tools they own; it
  never adds one (PROP-0029).
- **INV-CAP-2** The capability contract is generic. It names no application task, role or UI
  concept.
- **INV-CAP-3** A capability set says what may be called, not whether a call may run. The gate
  still decides each call.

## Data

```text
<data root>/config/plugin-attachments.json     (registry-enabled.json read until the first change)
<data root>/plugins/<name>/                     packages kept with the data; removal moves to trash/plugins/
<data root>/plugin-proposals/<id>.json          proposed text, hash and review status
<state dir>/plugin-trust.json                   trusted code, by hash
<state dir>/plugin-registered.json              what each extension registered last time
<state dir>/plugin-hooks.json                   hooks and their last run
<state dir>/accounts/_shared/pi/                settings and packages shared by every account
```

## Source map

`src/plugins/*.ts`, `src/capabilities/*.ts`, `src/core/changes.ts`.

## Built-in ownership taxonomy (PROP-0020)

These categories make ownership visible in docs and source layout. They do not change plugin
metadata or availability:

| Category | Features | Foundation boundary |
|---|---|---|
| Foundation | Accounts, sessions and run recording, prompt and variant validation, gate, plugin loading/trust/attachments, resource browser, server and terminal frameworks | Release-owned infrastructure and security contracts |
| World | Web search/read tools, browser tools, page annotations | The isolated browser engine and network policy remain Foundation services |
| Memory | Wiki, history and trajectory | Storage and run records remain Foundation-owned services |
| Automation | Subagents, ask-user, todo, lessons and refinement | Run lifecycle, capability narrowing and approval gate remain Foundation-owned |
| Integrations | Connected apps/MCP and Hub | Connector credentials and plugin installation remain behind Foundation services |
| Operations | Doctor, worktrees and usage | Diagnostics, repository operations and usage analytics remain Harness-managed services |

## Terminal plugin and resource inspection

The broad `/harness` browser joins saved plugin/contribution metadata with actual session skills and
tool registration. A saved on/off state does not prove a resource loaded; origins and owners
distinguish same-name resources. `/plugins` is a focused local manager with Plugins, Trust and
Packages tabs. It uses the existing plugin services for switching, trust, settings, package install,
update and removal. `/hub` is a distinct Community catalog surface; it does not load code or add a
second loader. Hub-owned package removal through `plugins.remove` delegates to Hub so the exact
receipt and its resources stay consistent. No second discovery or enablement mechanism is
introduced (PROP-0013, PROP-0047).
