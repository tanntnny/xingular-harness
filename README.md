# Xingular Harness

A Pi agent harness, as one TypeScript package (`@xingular/harness`). It is everything a model
needs to work for someone over time, and nothing about any particular application:

| Part | Folder | What it does |
|---|---|---|
| Accounts | `src/accounts/` | Several isolated Pi accounts and pools, sign-in, model lists, health and limits. A session keeps the account it started with. |
| Sessions | `src/sessions/` | Pi SDK turns, run records and `events.jsonl`, interrupt, approvals, questions, recovery after a crash. |
| Prompt | `src/prompt/` | The system prompt compiled from sections with budgets and profiles; a stable prefix, and changing state delivered as updates in native history. |
| Memory | `src/memory/` | The Wiki: pages, facts, memory blocks, revisions, proposals with an evidence gate, undo, an Inbox, history recall, run trajectory inspection, and sleep-time consolidation. |
| Skills | `src/skills/` | Skills, prompts, and rules: a person's own in the data root, and built-in ones shipped with the harness or the application. |
| Plugins | `src/plugins/` | What a Pi session loads, chosen by the harness and never by Pi's own discovery; trust for a working folder's code; the list of every plugin and what reaches one caller. |
| Tools | `src/tools/` | Tool definitions, the memory tools, `ask_user`; a gate that asks the application's policy, then standing approvals, then the person. |
| Connected apps | `src/mcp/` | MCP connections, OAuth, per-session grants, redaction, a trace of what each call returned. |
| Terminal | `src/terminal/` | A Harness-owned terminal frontend over persistent Pi sessions, isolated accounts, compiled instructions, the tool gate and telemetry bridge, native history, plugin UI, `/plugins`, `/hub`, `/accounts`, and the existing session socket. |
| Server | `src/server/` | The same API over newline-delimited JSON, for a host that is not a Node program. |

It was split out of Xingular Agent, which is now an application built on it.
The [documentation index](docs/README.md) links current terminal architecture and decisions.

### Session options for applications

- Interactive sessions offer `spawn_subagent` and `wait_subagents` by default. `subagents: null` disables them; `{ maxDepth }` configures native nesting (default one, maximum three), independently of the host caller depth. Unattended sessions remain disabled unless the host explicitly supplies subagent options. A frozen capability set can narrow these tools further.
- `harness.subagents.spawn({ parentRunId, brief, tools?, wait? })` opens a fresh child of the same caller with no wider capabilities. It returns `{ runId, nativeSessionId }` once open; `wait: true` also waits for settlement. `harness.subagents.wait({ parentRunId, runIds? })` joins selected direct children, or the current children when omitted, and returns their outcomes. `results` reads the same bounded outcome records without waiting. RPC exposes `subagents.spawn`, `subagents.wait`, and `subagents.results`; `sessions.spawnSubagent` remains a compatibility alias.
- The model's `spawn_subagent` returns immediately by default; `wait: true` returns an inline result. `wait_subagents` joins selected children. The SDK and standalone terminal share this execution service. Terminal calls use its private control channel, including when connected apps are disabled.
- Parents receive results at native turn boundaries and join outstanding children before completing. Typed native-history receipts prevent duplicate automatic delivery; explicit waits can reread results. Ownership is recorded before startup so an explicit resume can recover even a lost spawn return. Startup reservations without a run become interrupted outcomes. A restarted Harness never restarts model work automatically. Recovery requires the same recorded account, caller, working folder, and selected history branch. Session IDs are opaque; consumers follow `parentRunId` and `relation`.
- `providers: false` runs a session with the harness's own tools only.
- On the caller, `vaultAccess: 'propose'` writes no memory directly, and `recallExcludeAgents` hides those agents' conversations from history and trajectory tools.
- `maintenanceRunTrigger: false` (a harness option) leaves memory to explicit proposals and scheduled merges.

Every session also gets `trajectory_search` and `trajectory_read` from the built-in History plugin.
Search lists runs in the current data root, including active runs, with filters and a continuation
cursor. Read returns pages of the canonical execution events, including captured prompt/context,
tool, decision, retry, compaction, and usage evidence. Active runs show the latest events saved so
far; settled reads stop at the first outcome. Payloads are bounded and marked when truncated, and
the tools omit account identifiers, credential fields, attachment bytes, native adapter payloads,
and provider reasoning text or summaries.
They report recorded evidence without scoring runs, and do not backfill older records.

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
   `registryTools({ harness })` gives `registry_write` (a skill, rule, or prompt) and `plugin_write`
   (a plugin). Each writes for the calling agent only: the item is on for that agent, and a plugin's
   code is trusted once written. An item others already use goes to the Inbox instead.
3. **`ToolPolicy`**. `scope` says whether a call is inside what the run may do (or needs one
   approval). A decision with `humanOnly` is for a person alone: the always-approve switch and
   remembered answers do not apply to it. `authorize` says whether the tool is still switched on;
   `approval` adds facts for standing approvals; `connections` narrows the connected apps a session
   reaches.
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
  disk. A terminal retains its final prepared `--extension` bridge argument; the owned frontend
  loads that bridge as the final trusted inline factory. A plugin that changes a tool call's
  input does so before the gate sees it. Every resource reload revalidates the parent's original
  trusted selection; changed or revoked code requires review and a fresh terminal.
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
  token from its environment, so a change is taken only with a second key that the trusted
  terminal process claims once (`control.claim`) and shares with its bridge in memory; the socket's
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

A terminal session can load Pi's four existing builtins (`builtin:mcp`, `codemode`,
`tool-search`, `llama.cpp`). The Harness resource selection passes enabled builtins by name,
and the pinned compatibility adapter supplies their implementations to the persistent SDK
runtime. The separate per-turn SDK execution path does not load these terminal builtins.

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

## Run it as a standalone Harness terminal

After the CLI package is published to npm or your company's npm registry, install and launch it:

```sh
npm install --global @xingular/harness
xingular-harness
```

The machine needs Node 22.19 or newer. Harness runs its own terminal frontend through the
active Node runtime on every platform, using its pinned Pi SDK; no separate global `pi`
installation is required. On first launch, it creates a `Default` isolated account. Use
`/accounts` or `/login` to sign in.

Provider sign-in progress lives in the running Harness process. An embedding application can call
`accounts.loginStatus` after reconnecting to recover the current device code or prompt by account;
the status carries a revision so it can be safely merged with streamed login events. Progress is
never written to account files, and a completed or cancelled attempt no longer exposes its code.

To build and run from a source checkout, use the development command:

```sh
npm install
npm run dev
```

`npm run dev` rebuilds the CLI and opens the Harness terminal in the current working directory.
It uses the normal Harness data and state directories. Press `/quit` or Ctrl+C to close it.
For separate development data, pass the usual `--data <dir>` and `--state <dir>` arguments:
`npm run dev -- --data <dir> --state <dir>`.

Building a checkout does not update an existing global `xingular-harness` installation.
To replace that command with this checkout, run `npm pack`, then install the exact tarball
filename it prints with `npm install --global ./<tarball-filename>`. This is a local install;
it does not publish a release. Close an already-running terminal session and launch the command
again to load the new frontend. A package version alone cannot distinguish an unreleased local
build from an older installed build with the same version.

This opens the Harness-owned terminal frontend in the current working directory. Its
presentation follows the inspected Oh My Pi 18.11.3 titanium and light palettes, centered welcome,
colored text statusline and curved `╰─` prompt, with Harness identity and existing capabilities. Harness
owns screen composition, editing/input dispatch, scrolling, command routing and plugin UI;
Pi supplies the persistent execution runtime, native history and rich content components.
The existing isolated account, compiled context, approval gate, telemetry and Wiki/socket
commands remain behind the terminal. No Pi `InteractiveMode` is constructed.

`/resume` stays inside the prepared history and working folder; `/import` accepts an explicitly
selected native JSONL file only for the same working folder. Cancel an active response before
changing or reloading a session. Full OMP visual parity is not established by the current
verification. `/permissions` reviews device-local Pi terminal grants and the Full Permission switch;
tool grants apply across terminal sessions sharing this Harness state, and Full Permission requires
confirmation. `/trajectory` opens recorded runs for the current native conversation, with event
navigation and a detail inspector. `/log` shows a static, redacted snapshot of Harness diagnostics
and run events for the current conversation; press Escape to close. See
[terminal architecture and evidence](docs/terminal-tui.md),
[the decision](docs/decisions/ADR-0001-owned-terminal.md), and [third-party notices](NOTICE.md).

### `/accounts` in the terminal

`/accounts` manages the Pi accounts the same way the app's Accounts screen does: add, rename,
check, make default, sign in (browser or API key), sign out, remove a provider or an account,
manage pools, and read the activity log. Each change is made by the person at the terminal; a
command the model runs in the shell cannot make it.

A running session stays on the account it started with. To use another account for this
session, choose **Use for this session**: the terminal child restarts and the same conversation
resumes on that account. Removing an account that a running terminal is using is refused. Only
terminals in this process are counted, so an account used by another running `xingular-harness` window can
still be removed; that session then asks for another account the next time it starts.

The default data and device state directories are `~/.xingular-harness/data` and
`~/.xingular-harness/state`. Override them with `--data <dir>` and `--state <dir>`. Session
history is stored per working directory and can be reopened with the terminal's `/resume`
command. The explicit `terminal` command is an alias for the default launch. Use `--help` to see the commands;
`serve` remains the host-facing RPC service for integrations such as Xingular Agent/App.

## Storage

```
<data root>/
  wiki/             home.md, library/, projects/<slug>/, facts/, blocks/, revisions, inbox, log
  registry/         skills/, prompts/, rules/   (a person's own; never copied)
  plugins/<name>/   packages kept with a person's data; each is found as an installed plugin
  runs/<id>/        run.json, events.jsonl, context.json, caller.json, subagents.json (reserved child IDs)
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
  harness.log       diagnostics from the standalone terminal, kept off its screen
```

The files are the source of truth; `index.sqlite` can be deleted and rebuilt
(`harness.rebuildIndex()`).

## Commands

```sh
npm run ci        # typecheck, unit/golden tests, and standalone proof; matches GitHub CI
npm run build     # dist/cli.js (the xingular-harness command) and dist/terminal-pi.js
```

Node 22.19 or newer.

## Images

`SessionRunInput.requiresImageInput` optionally requires a vision-capable resolved Pi model before a prompt is delivered. The check includes direct `images` input, and the generic tool wrapper rejects image results on text-only models. Direct prompt images use Pi's `{ type: 'image', data, mimeType }` content shape. Applications own file formats, attachment selection, extraction and image preparation; the Harness only transports typed image content and validates model capability.

## Curated Hub

`xingular-harness hub list [--refresh]`, `hub show publisher/name@version`, and
`hub install publisher/name@version` browse and install exact catalog versions. `/hub` offers the
same review in the interactive terminal, using its private control key for installation. Both the
terminal and embedding applications use `hub.list`, `hub.get`, `hub.preview`, `hub.install`,
`hub.uninstall`, and `hub.readDocument`. `hub.get { id, version, preview: true }` verifies data
payload bytes without installing them. `hub.preview { id, version, offset }` returns bounded,
UTF-8-safe pages of up to 16 KiB from a verified payload.

Registry bundles import complete skills or single Markdown prompts/rules, disabled. Pi packages
reuse the existing installer and require an exact npm version or full GitHub commit. Documents
are saved as inert JSON for a compatible host to interpret; the harness does not apply them.
Installation grants no attachment, trust, credentials, or permission. Writes are serialized and
existing registry files are never overwritten. Receipts report whether their resources are intact;
uninstall removes only the exact receipt's resources, including local edits within those paths, and
revokes its attachment choices.

Installed documents and provenance live under `<data root>/hub/`; the catalog cache is
`<state dir>/hub/catalog.json`. An offline snapshot ships with the package. Explicit refresh keeps
the last valid catalog when the network or schema fails. The prepared public distribution repository
is `../Hub`; publication remains separate from local installation and testing. Run its build with
`--sync-harness` to regenerate this package's offline snapshot after reviewing catalog changes.

Standalone defaults stay separate from a host application's folders. Use explicit `--data` and
`--state` to target the same library. CLI hub commands construct the harness without opening the
data root, so they do not migrate the Wiki or settle another process's runs.


## External curation

An embedding application may set `externalMaintenance: true`, supply trusted `CallerContext`
`vaultAccess` (`self` or `curator`), and register `maintenanceTools`/`MAINTENANCE_PLUGIN`.
Self callers directly edit only their own writable persona/notes; shared knowledge and text-resource
writes become persistent proposals. Curator tools read original evidence, compare captured target
revisions, read all host-assigned requests together, and apply reconciled Wiki proposals as one
undoable change set. Resource proposals keep their own receipts; executable proposals remain inert
until the user reviews/trusts them. Later user edits are never overwritten.
`maintenance.list`, `maintenance.review` and `maintenance.retry` let the host dispatch its own
recorded sessions. Curator runs do not recursively queue maintenance. Optional assigned IDs freeze
which requests a batch may claim. These fields are trusted host context, never model arguments.
`maintenance_read_batch` reads those assigned requests together; `maintenance_apply_batch` records
one decision for each and applies the evidence-checked Wiki set atomically. Standalone callers that
omit this option retain the existing lifecycle and direct-write contract.
