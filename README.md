# Xingular Harness

A Pi agent harness, as one TypeScript package (`@xingular/harness`). It is everything a model
needs to work for someone over time, and nothing about any particular application:

| Part | Folder | What it does |
|---|---|---|
| Accounts | `src/accounts/` | Several isolated Pi accounts and pools, sign-in, model lists, health and limits. A session keeps the account it started with. |
| Sessions | `src/sessions/` | Pi SDK turns, run records and `events.jsonl`, interrupt, approvals, questions, recovery after a crash. |
| Prompt | `src/prompt/` | The system prompt compiled from sections with budgets and profiles; a stable prefix, and changing state delivered as updates in native history. |
| Memory | `src/memory/` | The Wiki: pages, facts, memory blocks, revisions, proposals with an evidence gate, undo, an Inbox, recall over past runs, and sleep-time consolidation. |
| Skills | `src/skills/` | Skills, prompts, and rules: a person's own in the data root, and built-in ones shipped with the harness or the application. |
| Plugins | `src/plugins/` | What a Pi session loads, chosen by the harness and never by Pi's own discovery; trust for a working folder's code; the list of every plugin and what reaches one caller. |
| Tools | `src/tools/` | Tool definitions, the memory tools, `ask_user`; a gate that asks the application's policy, then standing approvals, then the person. |
| Connected apps | `src/mcp/` | MCP connections, OAuth, per-session grants, redaction, a trace of what each call returned. |
| Terminal | `src/terminal/` | Interactive Pi sessions with isolated accounts, compiled instructions, a telemetry and tool extension, and the session socket with the `xagent-wiki` and `xagent-mcp` commands. |
| Server | `src/server/` | The same API over newline-delimited JSON, for a host that is not a Node program. |

It was split out of Xingular Agent, which is now an application built on it.

## Using it from Node

```ts
import { createHarness } from '@xingular/harness'

const harness = createHarness({
  dataRoot: '/path/to/data',        // knowledge and history: wiki/, registry/, runs/, index.sqlite
  stateDir: '/path/to/state',       // device-local: accounts, approvals, connections, sockets
  productName: 'My App',            // how the harness names itself to a model (default 'Xingular Harness')
  secrets,                          // SecretStore; defaults to an owner-only file in stateDir
  policy,                           // ToolPolicy: what a run may do, and what needs a person
  directory,                        // names for the ids the application uses
  builtins: ['/path/to/builtin'],   // folders of built-in skills, prompts, and rules
  plugins: [myPlugin]               // the application's own parts, described as plugins
})

harness.sessions.provide((session) => myTools(session))   // the application's own tools
harness.runs.listen((event, run) => show(event))            // every run event, after it is saved

await harness.sessions.run({
  run: { id, sessionId },
  cwd, sessionDir, text,
  caller: { agentId, agentName, actor: 'Chat' },
  launch: { sections: [{ id: 'identity', title: 'Identity', body, budget: 2000, order: 10 }] },
  tools: { allow: ['read', 'bash', 'my_tool'], gated: ['bash'] }
})
```

## How an application extends it

The harness knows a caller (an opaque id that owns memory), never an agent, a group, or a task.
An application adds what it knows through six points:

1. **Prompt sections** (`Launch.sections`, `Launch.toolGroups`, `Launch.references`). Each
   section has an `order` and may be `dynamic`. The harness adds its own (`blocks` 30, `rules` 40,
   `references` 50, `skills` 60, `knowledge` 80, `tools` 90), applies budgets and the caller's
   context profile, keeps stable sections in the system prompt, and sends dynamic ones as
   updates.
2. **Tool providers** (`harness.sessions.provide`). A provider returns `ToolSpec`s for a session;
   only the names in the session's `allow` list are registered, in that order.
   A tool may return `attachments` as `{ id, name, mimeType }` references. The harness records
   those references on `tool.completed`; attachment bytes remain with the provider and never enter
   the run-event stream.
   The harness provides the web tools itself: `webTools({ secrets })` gives `web_search` (Brave Search,
   key read from the secret store) and `web_fetch` (checked reads of public pages). An application
   passes it to `harness.sessions.provide` and switches the names on for each agent.
3. **`ToolPolicy`**. `scope` says whether a call is inside what the run may do (or needs one
   approval); `authorize` says whether the tool is still switched on; `approval` adds facts for
   standing approvals; `connections` narrows the connected apps a session reaches.
4. **`SecretStore`**. Where credentials live (a keychain, a vault). Keys are
   `<account id>/<name>`.
5. **`Directory`**. Names for the application's ids, shown in what the harness writes.
6. **Plugin descriptions** (`HarnessOptions.plugins`). Each `PluginDescriptor` names one part of
   the application and says which tools, prompt sections and tool groups it provides. It is data:
   it changes what `plugins.list` and `plugins.inventory` report, never what runs. `WEB_PLUGIN`
   describes the web tools. A host that is not a Node program sends them with `plugins.describe`.

`apps.expose(...)` additionally offers the application's tools through the connected-apps
broker (`mcp_list_tools`, `mcp_call_tool`), which is how a terminal session reaches them.

## Plugins: what a session loads

A plugin is a bundle with a title, a description and contributions: instructions, skills,
commands, tools, connections, code (a Pi extension) and themes. A Pi package is a plugin as it
is; so are the harness's own parts (Memory, Wiki, History, Ask the user, Connected apps, Pi), the
application's, a person's registry ("Yours"), the folder every account shares, and what a
working folder brings.

- **The harness is the only loader.** A session opens Pi with its own discovery switched off and
  the paths the harness chose (`Plugins.loading`); a terminal gets the same list as `--extension`,
  `--skill`, `--prompt-template` and `--theme` flags after `--no-extensions --no-skills
  --no-prompt-templates --no-themes`. The harness finds things with Pi's own resolver, which runs
  no extension code. Pi still reads `AGENTS.md` and `SYSTEM.md` itself; they are listed.
- **Code waits for trust.** A working folder's `.pi/extensions` and the packages its settings
  name are trusted together; each installed package is trusted on its own. Trust is a hash of the
  files (`plugins.trust { hash }`), so the same code in another folder is trusted and a changed
  file asks again. A loose file a person put in the shared `extensions/` folder loads without
  asking. The first time this version runs, the packages already present are recorded as trusted,
  once; anything installed or changed later waits.
- **Installing runs no code.** `plugins.install { source }` takes a folder, an npm name or a git
  address and goes through Pi's own package manager on the settings every account shares, so
  `pi list` agrees. Install scripts are switched off (`npm_config_ignore_scripts`). The package
  arrives switched off and, with code, not trusted. `plugins.remove` and `plugins.update` take a
  `pluginId`. A folder under `<data root>/plugins/` is found as a package where it is, and
  removing it moves it to `<data root>/trash/plugins/`. `npm` and `git` in an account's Pi folder
  are links to the shared folder, so one install serves every account.
- **Extensions have an interface without a terminal.** An SDK session that loaded an extension
  binds it the way Pi's RPC mode does: `session_start` fires, and `select`, `confirm`, `input`
  and `editor` become the run's question events; `notify`, `setStatus` and `setWidget` become
  `extension.notice` run events. What needs a terminal (custom components, key handlers, themes)
  does nothing. A tool an extension registered is offered to the model and asks before every
  call. A command it registered runs when a message starts with it.
- **The gate runs last.** In an SDK session it is an inline extension, loaded after those on
  disk; in a terminal the harness's extension is the last `--extension`. A plugin that changes a
  tool call's input does so before the gate sees it.
- **A required part can be extended.** A package names the part it adds to and, optionally, a
  hooks file: `"harness": { "extends": ["memory"], "hooks": "./hooks.mjs" }`. The harness runs
  hooks itself (`src/plugins/hooks.ts`), in its own process, because most memory is written while
  no session is open. `export default function (harness) { harness.on('memory.saved', async
  (event, ctx) => …) }`; the events are `memory.saved`, `memory.block.changed`,
  `wiki.page.saved` and `history.run.ended`. A hook is told after the write and cannot stop it,
  has 30 seconds, and what it throws is kept in `plugin-hooks.json` and shown on its plugin. It
  runs only while its plugin is switched on for everyone and trusted; what is loaded is checked
  against that before each delivery. `ctx.call(connection, tool, args)` reaches a connected app
  that is on for everyone, and only a tool marked to run without asking. A working folder's
  package cannot bring a hook. An embedding application adds no hook events of its own yet.
- **An agent can propose a plugin, and only propose.** `plugin_propose` parks a set of files in
  the Inbox. Accepting writes `<data root>/plugins/<name>/` with a `package.json` the harness
  wrote, switched off and untrusted. No tool accepts, switches on or trusts.
- **Two plugins ship with the harness, switched off.** `output-trim` cuts a tool result longer
  than its limit to its beginning and its end before the model reads it; `budget-guard` refuses
  tool calls once a run passed a limit of model requests or tokens, leaves the agent one request
  to wrap up, and ends the run if it calls tools again (`src/plugins/firstParty.ts`). They are
  Pi extensions loaded inline, so they also run in unattended work and need no trust. A person
  switches them like any plugin and sets their numbers with `plugins.configure { pluginId,
  settings }`. A descriptor may declare `switchable`, `settings` and `code` to describe a part
  like these. A terminal session does not load them yet.
- **A person can do the same from a terminal.** In a terminal session, `/plugins` lists what the
  session loads and switches a plugin, or one thing it brings, for the session's project or for
  everyone, and trusts code after showing its files. The session's shell can read the session
  token from its environment, so a change is taken only with a second key that the harness's
  extension claims once as it loads (`control.claim`) and keeps in its own memory; the socket's
  `plugins.list` is open to the session, and `plugins.attach`, `plugins.detach`, `plugins.trust`
  and `plugins.untrust` refuse without that key. A change applies when the session restarts.
  Outside a session, `xingular-harness plugins list | show | install | remove | update | attach |
  detach | trust | untrust` acts directly, as the person who typed it; `trust` shows the files
  and wants a typed yes or `--yes`. It does not open the data root, so it settles no run.
- **Unattended runs and memory maintenance load no extension**, as before.
- **A person switches things on and off for a scope.** `plugins.attach` and `plugins.detach`
  take a plugin's or a contribution's `id` and a `scope` (`{}` for everywhere, `{ agentId }`, or
  `{ projectId }`). The narrowest scope that says something wins: an agent, then a project, then
  everywhere. The choices are one file, `config/plugin-attachments.json`; registry enablement
  (`skills.setEnabled`) reads and writes the same file, and the earlier `registry-enabled.json`
  is read until the first change. A connected app keeps its scope in `connections.json` and is
  switched through the same two methods. A switched-off extension, skill or prompt is not
  loaded for that caller. The harness's own parts are required and refuse with their reason; an
  application's parts are switched by the application. Switching something on grants no
  permission: its tools still pass the gate.
- `plugins.list { cwd?, accountId?, agentId?, projectId? }` returns every plugin, with where each
  is switched on (`attachment`); with an agent or a project, each state is what that caller
  gets. `plugins.inventory { context, launch, tools, connections, cwd? }` returns what reaches
  one caller, each item attributed to a plugin, with `unattributed` naming any prompt section,
  tool group or tool no plugin accounts for.

A terminal session's `pi` command has four extensions of its own (`builtin:mcp`, `codemode`,
`tool-search`, `llama.cpp`). They are passed by name unless Pi's settings switch them off. An SDK
session does not have them.

## Using it from another language

```sh
npm run build
node dist/cli.js serve --state <dir> --data <dir> --name "My App" \
  [--builtins <dir>] [--host-secrets] [--host-policy] [--host-tools] [--host-directory]
```

Lines on stdin and stdout, one JSON object each:

```
host → harness   { v: 1, id, method, params }       harness → host   { v: 1, id, result | error }
harness → host   { v: 1, event }                    a run event
harness → host   { v: 1, notice }                   state changed: read it again
harness → host   { v: 1, id, call, params }         host → harness   { v: 1, id, result | error }
```

`harness.methods` lists every method; [`src/server/methods.ts`](src/server/methods.ts) is the
table. With the `--host-*` flags the harness calls the host for `secrets.get|set|delete`,
`policy.scope|authorize|approval|connections`, and `tools.call`; the host registers its tools
with `tools.register` and its names with `directory.set`.

`skills.import` accepts complete user-owned skill folders:

```ts
{ skills: [{ name, files: [{ path, content, encoding }] }] }
```

It validates bounded relative paths and file encodings, requires a root
`SKILL.md`, rejects existing items, and writes the folders without enabling or executing them. It
has no knowledge of the application feature that may call it.

`npm run prove` starts that server on a throwaway data root, with no application present, and
exercises accounts, memory, skills, the prompt, connected apps, and a recorded session.

## Run it as a standalone Pi terminal

After the CLI package is published to npm or your company's npm registry, install and launch it:

```sh
npm install --global @xingular/harness
xingular-harness
```

The machine needs Node 22.19 or newer. On macOS and Linux, the `pi` command must be on `PATH`;
on Windows, Harness runs the pinned Pi CLI package through the active Node runtime. On first
launch, the harness creates a `Default` Pi account; Pi handles provider sign-in.

To build and run from a source checkout instead:

```sh
npm install
npm run build
node dist/cli.js
```

This opens Pi's interactive terminal in the current working directory. The harness adds its
compiled context, isolated account, approval gate, Wiki commands, and terminal extension while
Pi provides the interface.

The default data and device state directories are `~/.xingular-harness/data` and
`~/.xingular-harness/state`. Override them with `--data <dir>` and `--state <dir>`. Session
history is stored per working directory and can be reopened with Pi's `/resume` command. The
explicit `terminal` command is an alias for the default launch. Use `--help` to see the commands;
`serve` remains the host-facing RPC service for integrations such as Xingular Agent/App.

## Storage

```
<data root>/
  wiki/             home.md, library/, projects/<slug>/, facts/, blocks/, revisions, inbox, log
  registry/         skills/, prompts/, rules/   (a person's own; never copied)
  plugins/<name>/   packages kept with a person's data; each is found as an installed plugin
  runs/<id>/        run.json, events.jsonl, context.json, caller.json
  config/           context profiles, what is switched on for whom (plugin-attachments.json),
                    settings the harness reads
  index.sqlite      a rebuildable index of Wiki entries and runs (FTS5)
  projects.json     read only: the application owns it

<state dir>/
  accounts/         registry, per-account Pi agent folders, audit log
  approvals.json    standing approvals
  plugin-trust.json       the code a person trusted, by hash, and whether earlier packages were taken over
  plugin-registered.json  what each extension registered the last time a session loaded it
  plugin-hooks.json       what each hooks file listens for and how its last run went
  connections.json  connected apps (secrets are in the SecretStore)
  run/              the session socket and the terminal commands
```

The files are the source of truth; `index.sqlite` can be deleted and rebuilt
(`harness.rebuildIndex()`).

## Commands

```sh
npm run typecheck
npm test          # unit tests and the golden prompt/memory fixtures in tests/golden
npm run build     # dist/cli.js (the xingular-harness command) and dist/terminal-pi.js
npm run prove     # the standalone proof above
```

Node 22.13 or newer (for `node:sqlite`).

## Images

`SessionRunInput.requiresImageInput` optionally requires a vision-capable resolved Pi model before a prompt is delivered. The check includes direct `images` input, and the generic tool wrapper rejects image results on text-only models. Direct prompt images use Pi's `{ type: 'image', data, mimeType }` content shape. Applications own file formats, attachment selection, extraction and image preparation; the Harness only transports typed image content and validates model capability.

## Curated Hub

`xingular-harness hub list [--refresh]`, `hub show publisher/name@version`, and
`hub install publisher/name@version` browse and install exact catalog versions. `/hub` offers the
same review in the interactive terminal, using its private control key for installation. Both the
terminal and embedding applications use `hub.list`, `hub.get`, `hub.install`, and `hub.readDocument`.
`hub.get { id, version, preview: true }` verifies data payload bytes without installing them.

Registry bundles import complete skills or single Markdown prompts/rules, disabled. Pi packages
reuse the existing installer and require an exact npm version or full GitHub commit. Documents
are saved as inert JSON for a compatible host to interpret; the harness does not apply them.
Installation grants no attachment, trust, credentials, or permission. Writes are serialized and
existing registry files are never overwritten.

Installed documents and provenance live under `<data root>/hub/`; the catalog cache is
`<state dir>/hub/catalog.json`. An offline snapshot ships with the package. Explicit refresh keeps
the last valid catalog when the network or schema fails. The prepared public distribution repository
is `../Hub`; publication remains separate from local installation and testing. Run its build with
`--sync-harness` to regenerate this package's offline snapshot after reviewing catalog changes.

Standalone defaults stay separate from a host application's folders. Use explicit `--data` and
`--state` to target the same library. CLI hub commands construct the harness without opening the
data root, so they do not migrate the Wiki or settle another process's runs.
