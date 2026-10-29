# Xingular Harness

A Pi agent harness built on **recursive harnessing** ([Harness²](https://arxiv.org/abs/2610.14224),
Apache-2.0, Google LLC), as one TypeScript package (`@xingular/harness`). It lets a running host
improve the harness itself, with model weights fixed. To say that precisely, the harness has two
halves:

- **The foundation is fixed.** Pi sessions, the prompt compiler, the run recorder, the tool gate,
  accounts, plugin-code trust, the refinement method and the extension points. Only a release
  changes it.
- **A Harness Variant (HV) mutates.** It is what a model is told and can load: eight components
  (c1–c8) for one scope. Each scope has versioned, validated HVs; a run pins one version, and
  refinement proposes a better HV that a person adopts.

*The foundation runs a variant, records how it went, and lets refinement propose a better
variant; only a person adopts one.* Refinement edits a copy of a variant and never the
foundation. See [Foundation and variants](docs/architecture/00-overview.md#foundation-and-variants).

Recursive refinement proposes HV improvements from run evidence. A person adopts candidates;
model weights and the foundation stay fixed. See the [Google Harness² feature guide](docs/features/google-harness2/README.md)
for the method and HV components.

| Area | Main features | Guide |
|---|---|---|
| Core runtime | Accounts, sessions and runs, prompt compilation, tool governance | [Cores](docs/features/cores/README.md) |
| Harness² | HVs, recursive refinement, answer-free selection, experience library | [Google Harness²](docs/features/google-harness2/README.md) |
| Automations | Subagents, recovery, optional run reflections, plugin hooks | [Automations](docs/features/automations/README.md) |
| Memory | Wiki notes, run recall, trajectory search and reads | [Memory](docs/features/memory/README.md) |
| Integrations | Application extension points, plugins, connected apps and Hub | [Integrations](docs/features/integrations/README.md) |
| Interfaces | Node embedding, standalone terminal and JSON-lines server | [Interfaces](docs/features/interfaces/README.md) |

The binding design of every part is the [architecture specification](docs/architecture/README.md).

Try refinement with no model and no credentials: `npm run build && node dist/cli.js refine demo --k 2`.
The [feature guide](docs/features/README.md) groups capabilities by area; the [documentation
index](docs/README.md) links the architecture and other project records.

### Session options for applications

- Interactive sessions offer `spawn_subagent` and `wait_subagents` by default. `subagents: null` disables them; `{ maxDepth }` configures native nesting (default one, maximum three), independently of the host caller depth. `{ maxChildren, maxByProfile, maxOther, maxUnprofiled }` bounds breadth: by default a run starts at most four distinct child conversations, two `worker`, three `explorer`, one of any other named profile and one with no profile. Unattended sessions remain disabled unless the host explicitly supplies subagent options. A frozen capability set can narrow these tools further.
- `harness.subagents.spawn({ parentRunId, brief, agent?, tools?, wait? })` opens a fresh child of the same caller with no wider capabilities. `agent` names an agent profile (below). It returns `{ runId, nativeSessionId, agent?, unavailableTools? }` once open; `wait: true` also waits for settlement. `harness.subagents.wait({ parentRunId, runIds? })` joins selected direct children, or the current children when omitted, and returns their outcomes. `results` reads the same bounded outcome records without waiting. RPC exposes `subagents.spawn`, `subagents.wait`, and `subagents.results`; `sessions.spawnSubagent` remains a compatibility alias.
- **Agent profiles** (PROP-0029) are what a subagent starts from: the built-in `worker` (reads, edits, writes, runs commands) and `explorer` (reads only), a person's own `<data root>/agents/<name>.md`, a repository's `<project>/.xingular/agents/<name>.md`, and the variant's c5 subagents, later ones winning. A profile is Markdown with frontmatter (`description`, `color`, `tools`, `plugins`, `variant`, `model`, `effort`) and its body is the role. It only narrows the parent's tools and plugins. `listProfiles`, `resolveProfile`, `createProfile` and `removeProfile` (RPC `agents.list|get|create|remove`) read and write them, and the child's `RunRecord.profile` names the one it used.
- The model's `spawn_subagent` returns immediately by default; `wait: true` returns an inline result. `wait_subagents` joins selected children. The SDK and standalone terminal share this execution service. Terminal calls use its private control channel, including when connected apps are disabled.
- Parents receive results at native turn boundaries and join outstanding children before completing. Typed native-history receipts prevent duplicate automatic delivery; explicit waits can reread results. Ownership is recorded before startup so an explicit resume can recover even a lost spawn return. Startup reservations without a run become interrupted outcomes. A restarted Harness never restarts model work automatically. Recovery requires the same recorded account, caller, working folder, and selected history branch. Session IDs are opaque; consumers follow `parentRunId` and `relation`.
- `providers: false` runs a session with the harness's own tools only.
- `variant: { scope }` runs the session on that scope's head variant (or `{ scope, version }`, or `{ dir }` for a variant on disk). The version is pinned for the run and recorded on it.
- On the caller, `recallExcludeAgents` hides those agents' conversations from history and trajectory tools.
- `harnessTools: false` runs a session without the History, Wiki and skill tools (and without `ask_user` and `todo_write`).
- Every session with harness tools gets `todo_write`: the model sends its whole todo list (`pending`, `in_progress`, `completed`, at most 50 steps) and the run records it as a `todo.updated` event. `todoOf(events)` or the `runs.todo` method reads the latest one. Plan mode allows it. The pre-rename `checklist_write` and `checklist.updated` are still read, `runs.checklist` is a deprecated alias, and `checklistOf`/`CHECKLIST_WRITE` remain deprecated exports for one release (PROP-0045).
- `continueFrom: <run id>` continues a run that stopped before it finished (interrupted or failed) as a new run. `harness.recovery.interruptedRunIds` lists the runs `open` marked interrupted, and `continuationOf(root, runId, sessionDir)` (`runs.continuation`) says whether one can be continued and what it left: todo list, unanswered approvals and questions, the last tool and whether it finished, unfinished subagents. The new run reopens the same native history, records `resumedFromRunId`, keeps the account, variant version and capability set (`continuation_mismatch` otherwise), and the model is told where the earlier run stopped. The harness never continues a run by itself; which runs to continue, and when, is the application's choice.
- The first-party `lessons` plugin (off by default) reflects on a completed top-level run with enough tool calls and may keep one general lesson in the Wiki under `library/lessons/`, in refinement's cue/lesson shape. It uses the run's own account and model, read-only file tools, and is capped (`minToolCalls`, `maxLessons`, `maxChars`). See PROP-0008.

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
  dataRoot: '/path/to/data',        // variants/, library/, refine/, wiki/, registry/, runs/, index.sqlite
  stateDir: '/path/to/state',       // device-local: accounts, approvals, connections, sockets
  productName: 'My App',            // how the harness names itself to a model (default 'Xingular Agent')
  secrets,                          // SecretStore; defaults to an owner-only file in stateDir
  policy,                           // ToolPolicy: what a run may do, and what needs a person
  directory,                        // names for the ids the application uses
  builtins: ['/path/to/builtin'],   // folders of built-in skills, prompts, and rules
  plugins: [myPlugin],              // the application's own parts, described as plugins
  refineHost                        // where refinement executions work, as whom, with which tools
})

harness.refine.start({ task: { id, scope: 'agent-1', prompt }, k: 1, mode: 'parallel' })

harness.sessions.provide((session) => myTools(session))   // the application's own tools
harness.runs.listen((event, run) => show(event))            // every run event, after it is saved

await harness.sessions.run({
  run: { id, sessionId },
  cwd, sessionDir, text,
  caller: { agentId, agentName, actor: 'Chat' },
  variant: { scope: 'agent-1' },
  launch: { sections: [{ id: 'identity', title: 'Identity', body, budget: 2000, order: 10 }] },
  tools: { allow: ['read', 'bash', 'my_tool'], gated: ['bash'] }
})
```

## How an application extends it

The harness knows a caller and a harness scope (opaque ids), never an agent, a group, or a task.
An application adds what it knows through seven points:

1. **Prompt sections** (`Launch.sections`, `Launch.toolGroups`, `Launch.references`). Each
   section has an `order` and may be `dynamic`. The harness adds its own (`system` 25,
   `guardrails` 40, `memory` 45, `references` 50, `subagents` 64, `scripts` 66, `wiki` 80,
   `tools` 90), applies budgets, keeps stable sections in the system prompt, and sends dynamic
   ones as updates.
2. **Tool providers** (`harness.sessions.provide`). A provider returns `ToolSpec`s for a session;
   only the names in the session's `allow` list are registered, in that order.
   A tool may return `attachments` as `{ id, name, mimeType }` references. The harness records
   those references on `tool.completed`; attachment bytes remain with the provider and never enter
   the run-event stream.
   The harness provides the web tools itself: `webTools({ secrets })` gives `web_search` (Brave Search,
   key read from the secret store) and `web_fetch` (checked reads of public pages). An application
   passes it to `harness.sessions.provide` and switches the names on for each agent.
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
7. **`RefineHost`** (`HarnessOptions.refineHost`). Where a refinement execution works
   (`prepareWorkspace`: an isolated folder, such as a git worktree), as whom and with which tools
   (`session`), and what it produced (`deliverable`). Executions run as unattended runs with
   trigger `probe`, so a `ToolPolicy` can refuse anything with effects outside that folder;
   improver sessions run with trigger `improver`, file tools only, on a copy of the evidence.

`apps.expose(...)` additionally offers the application's tools through the connected-apps
broker (`mcp_list_tools`, `mcp_call_tool`), which is how a terminal session reaches them.

## Plugins: what a session loads

A plugin is a bundle with a title, a description and contributions: instructions, skills,
commands, tools, connections, code (a Pi extension) and themes. A Pi package is a plugin as it
is; so are the harness's own parts (Harness, Wiki, History, Subagents, Ask the user, Connected apps, Pi), the
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
  call. A terminal command runs as `/<owner-prefix>:<command>`; package extensions use their
  normalized package name, or an optional `harness.commandPrefix` from `package.json`.
- **The gate runs last.** In an SDK session it is an inline extension, loaded after those on
  disk. A terminal retains its final prepared `--extension` bridge argument; the owned frontend
  loads that bridge as the final trusted inline factory. A plugin that changes a tool call's
  input does so before the gate sees it. Every resource reload revalidates the parent's original
  trusted selection; changed or revoked code requires review and a fresh terminal.
- **A required part can be extended.** A package names the part it adds to and, optionally, a
  hooks file: `"harness": { "extends": ["wiki"], "hooks": "./hooks.mjs" }`. The harness runs
  hooks itself (`src/plugins/hooks.ts`), in its own process, because notes are often written while
  no session is open. `export default function (harness) { harness.on('wiki.page.saved', async
  (event, ctx) => …) }`; the events are `wiki.page.saved` and `history.run.ended`. A hook is told after the write and cannot stop it,
  has 30 seconds, and what it throws is kept in `plugin-hooks.json` and shown on its plugin. It
  runs only while its plugin is switched on for everyone and trusted; what is loaded is checked
  against that before each delivery. `ctx.call(connection, tool, args)` reaches a connected app
  that is on for everyone, and only a tool marked to run without asking. A working folder's
  package cannot bring a hook. An embedding application adds no hook events of its own yet.
- **An agent can propose a plugin, and only propose.** `plugin_propose` stores a pending set of
  text files; the release-owned `plugin-authoring` skill offers on-demand guidance. A trusted caller
  can preview and accept or reject through `plugins.proposals.*` using the preview hash. Acceptance
  writes `<data root>/plugins/<name>/` with a Harness-generated `package.json`, switched off and
  without granting code trust. No model tool accepts, switches on or trusts. A terminal review UI
  is pending; an App review UI is not claimed. See [plugin architecture](docs/architecture/06-plugins-and-capabilities.md#contracts).
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
  Outside a session, `xagent plugins list | show | install | remove | update | attach |
  detach | trust | untrust` acts directly, as the person who typed it; `trust` shows the files
  and wants a typed yes or `--yes`. It does not open the data root, so it settles no run.
- **Unattended runs load no extension found on disk.** A variant's own trusted plugins still
  load, so a refinement probe runs the plugin it is testing.
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

`variants.importComponents` adds complete skill folders, or single-file rules and prompts, to the
component library:

```ts
{ skills: [{ name, files: [{ path, content, encoding }] }] }
```

It validates bounded relative paths and file encodings, requires a root
`SKILL.md`, rejects existing items, and writes the folders without enabling or executing them. It
has no knowledge of the application feature that may call it.

`npm run prove` starts that server on a throwaway data root, with no application present, and
exercises accounts, variants, the Wiki, the prompt, connected apps, a recorded session, a
plugin hook, and the refinement demo end to end.

## Run it as a standalone Harness terminal

After the CLI package is published to npm or your company's npm registry, install and launch it:

```sh
npm install --global @xingular/harness
xagent
```

The machine needs Node 22.19 or newer and Bun 1.3.14 or newer. Harness runs its own OpenTUI
terminal frontend with Bun, using its pinned Pi SDK; no separate global `pi` installation is
required. On first launch, it creates a `Default` isolated account. Use `/accounts` to sign in.

On Windows the shell tool works without extra setup: it uses Git Bash when Git for Windows is
installed and PowerShell otherwise. Windows has no sandbox the harness can use to keep commands
inside the project, so each command asks for approval unless Full Permission is on, and plan mode
does not run commands. File edits work as usual.

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
It uses separate development directories by default: `~/.xingular-harness-dev/data` and
`~/.xingular-harness-dev/state`, so development harness data, approvals, plugin trust and
connections stay separate from the installed command. It signs in as the installed command's
accounts, though: one provider sign-in serves both launches. Press `/quit`, Ctrl+C or Ctrl+D to
close it. Override either directory with `--data <dir>` or `--state <dir>`; choose the accounts a
launch signs in as with `--account-state <dir>`, for example
`npm run dev -- --account-state ~/.xingular-harness-dev/state` for a fully separate identity. An
omitted option keeps its development specific default.

The OpenTUI/Solid frontend is the only terminal. Install Bun 1.3.14 or newer and run
`npm run build:tui` (or `npm run build`); without Bun the build fails rather than producing a
terminal that cannot start. The harness runs `dist/terminal-opentui.js`, which uses the same
session runtime, accounts, command pages, approvals, questions, plugins and run records as the
embedded SDK. See [the terminal guide](docs/terminal-tui.md).

### Worktrees

Run `xagent --worktree` (or `-w [name]`) inside a git repository to start in a fresh managed
worktree: a detached checkout under `<state dir>/worktrees/` that carries your uncommitted
changes, copies ignored files named in `.worktreeinclude`, and runs the repository's
`.xharness/worktree-setup` once you trust it (`xagent worktree trust-setup`). The 15 most recent
managed worktrees per repository are kept; older ones are pruned, and unsaved work is kept as a
snapshot you can restore. `/worktree` in a session, `xagent worktree <command>` in a shell, and
the `worktrees.*` server methods offer the same actions: new, switch, create branch, hand off to
or from the main checkout, remove, restore, prune and adopt. An application passes a worktree's id
as `run.worktreeId` and the session works in it. See
[PROP-0016](docs/architecture/proposals/PROP-0016-managed-worktrees.md).

### Web annotations

`/annotate: [url]` opens a visible capture browser (its own window and profile, separate from the
agent's browser). Annotate the whole page, select a passage, or click an element there, then write a
comment. `/annotate:notes` lists, edits, resolves, reveals and deletes annotations. An annotation made in the inspector is
shared with the session at once; others stay private until you share them; its agent then reads it with `page_notes_list` and
`page_notes_read`, with quoted page text marked untrusted. Annotations live in `<data root>/annotations/`
and the `annotations.*` server methods give a host the same store. A host with its own web view
runs the same page helper (`annotations.pageScript`). See
[PROP-0017](docs/architecture/proposals/PROP-0017-page-annotations.md).

`/annotate:` opens the inspector:
- Hover a component in the browser or an app window, click it, and write a comment in the popover.
- Choose **Annotate** (the agent can read it) or **Annotate & send** (sends every unsent annotation now). `s` in the page does the same as the second.
- `/annotate:submit <request>` sends the unsent annotations with your request; `/annotate:clear` resolves the unsent ones.
- App windows work two ways:
  - **DevTools port:** press `a` in the page (or run `/annotate: --app`) to list the Electron and Chromium apps running with a DevTools port, type a port, or start an app with one. `/annotate: --app 9229` attaches directly.
  - **Page bridge:** for a macOS web view such as Tauri, run `/annotate: --bridge` and load the script tag it shows while developing the app. Allow `http://127.0.0.1:<port>` in the app's `script-src` and `connect-src`.
- A host drives the same flow with `annotations.capture.*`, and sends to its own sessions with `annotations.compose` and `annotations.delivered`.

See [PROP-0018](docs/architecture/proposals/PROP-0018-annotation-queue-and-app-targets.md) and [PROP-0048](docs/architecture/proposals/PROP-0048-simple-annotate.md).

Building a checkout does not update an existing global `xagent` installation.
To replace that command with this checkout, run `npm pack`, then install the exact tarball
filename it prints with `npm install --global ./<tarball-filename>`. This is a local install;
it does not publish a release. Close an already-running terminal session and launch the command
again to load the new frontend. A package version alone cannot distinguish an unreleased local
build from an older installed build with the same version.

This opens the Harness-owned OpenTUI terminal in the current working directory. Its presentation
uses the Harness titanium palette and an OpenCode-inspired layout: the transcript above a
borderless composer with the working status above it and the model, context and token line below.
Harness owns screen composition, editing/input dispatch, scrolling, command routing and plugin UI;
Pi supplies the persistent execution runtime, native history and rich content components. The
existing isolated account, compiled context, approval gate, telemetry and Wiki/socket commands
remain behind the terminal. No Pi `InteractiveMode` is constructed.

Harness terminal commands stay unprefixed: `/doctor`, `/worktree`, `/trajectory`, `/subagents`,
`/agents`, and `/mcp`. `/history` continues to navigate session branches. These commands are
registered independently of feature-plugin command metadata. Other plugin-owned commands use
`/<owner-prefix>:<command>`; for example, annotate a page with `/annotate:
https://example.com`, or list every annotation with `/annotate:notes`. Former owner-qualified
and `/plugin:<command>` routes for promoted Harness commands remain hidden compatibility aliases for
one release; help and completion show only canonical forms.

`/resume` stays inside the prepared account history and working folder. Cancel an active response
before changing or reloading a session. Full OMP visual parity is not established by the current
verification. `/harness` opens one browser for Foundation, Variant, Skills, Plugins,
Connections (MCP), Tools and Library. `/skills`, `/plugins`, `/connections` (`/mcp`) and `/tools`
open its sections directly; `/hub` opens Discover and `/components` opens Library. Resource
sections share Installed / Discover, source filters, search and a detail inspector. Tab focuses
controls, arrows change the focused choice, Ctrl+F returns to search and Escape goes back.
Skills show actual session availability even with invocation shortcuts off. With shortcuts on,
Use inserts `$name` into the draft without sending it; typing `$` also completes loaded skills.
To keep an existing message and attachments, open Ctrl+K, choose Skills, then Use.
Variant inspection distinguishes the pinned session version from the latest saved version.
Adding a library skill or rule creates a validated version for future sessions.

`/accounts`, `/permissions`, `/settings`, `/trajectory` and `/log` retain their own centered pages.
`/permissions` reviews device-local Pi terminal grants and the Full Permission switch; tool grants
apply across terminal sessions sharing this Harness state, and Full Permission requires confirmation.
`/trajectory` opens recorded runs for the current native conversation,
with event navigation and a detail inspector. `/log` shows a static, redacted snapshot of Harness
diagnostics and run events for the current conversation; press Escape to close. See
[terminal architecture and evidence](docs/terminal-tui.md),
[the ownership decision](docs/decisions/ADR-0001-owned-terminal.md),
[the OpenTUI-only decision](docs/decisions/ADR-0006-opentui-only-terminal.md), and
[third-party notices](NOTICE.md).

### `/accounts` in the terminal

`/accounts` manages the Pi accounts the same way the app's Accounts screen does: add, rename,
check, make default, sign in (browser or API key), sign out, remove a provider or an account,
manage pools, and read the activity log. Each change is made by the person at the terminal; a
command the model runs in the shell cannot make it.

A running session stays on the account it started with. To use another account for this
session, choose **Use for this session**: the terminal child restarts and the same conversation
resumes on that account. Removing an account that a running terminal is using is refused. Only
terminals in this process are counted, so an account used by another running `xagent` window can
still be removed; that session then asks for another account the next time it starts.

The installed standalone command defaults to `~/.xingular-harness/data` and
`~/.xingular-harness/state`; `npm run dev` instead defaults to the separate
`~/.xingular-harness-dev/data` and `~/.xingular-harness-dev/state`. Override either with
`--data <dir>` and `--state <dir>`. A launch signs in as the accounts kept in the state directory
it uses; `--account-state <dir>` takes them from another state directory instead (its `accounts`
folder and its `secrets.json`), which is how `npm run dev` reaches the installed command's sign-in.
Session history is stored per working directory and can be reopened with the terminal's `/resume`
command. The explicit `terminal` command is an alias for the default launch. Use `--help` to see
the commands; `serve` remains the host-facing RPC service for integrations such as Xingular
Agent/App.

## Storage

```
<data root>/
  variants/<scope>/  versions/<fingerprint>/variant/, head.json, lineage.jsonl   (the eight components)
  refine/<id>/      summary.json, task.json, variants/<label>/, rollouts/, context/, selection/, reflection/, improver/
  library/<scope>/<area>/  INDEX.md, variants/<task>/{variant/, EXPERIENCE.md}   (the experience library)
  wiki/             home.md, library/, projects/<slug>/   (project notes)
  wiki-history/     earlier versions of notes
  legacy/           what an earlier Wiki kept (memory blocks, facts, revisions, Inbox), moved once
  registry/         skills/, prompts/, rules/   (the component library; the Hub installs here)
  plugins/<name>/   packages kept with a person's data; each is found as an installed plugin
  runs/<id>/        run.json, events.jsonl, context.json, caller.json, subagents.json (reserved child IDs)
  config/           what is switched on for whom (plugin-attachments.json),
                    settings the harness reads
  agents/<name>.md  a person's agent profiles (a repository keeps its own in .xingular/agents/)
  index.sqlite      a rebuildable index of runs for recall (FTS5)
  projects.json     read only: the application owns it

<state dir>/
  accounts/         registry, per-account Pi agent folders, audit log
  approvals.json    standing approvals
  plugin-trust.json       the code a person trusted, by hash, and whether earlier packages were taken over
  variant-plugin-trust.json  harness-variant plugin code a person trusted, and scopes whose probes may run improver code
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
npm run build     # dist/cli.js, dist/terminal-pi.js, and the OpenTUI frontend
npm run build:tui # only the OpenTUI frontend
```

Node 22.19 or newer and Bun 1.3.14 or newer.

## Images

`SessionRunInput.requiresImageInput` optionally requires a vision-capable resolved Pi model before a prompt is delivered. The check includes direct `images` input, and the generic tool wrapper rejects image results on text-only models. Direct prompt images use Pi's `{ type: 'image', data, mimeType }` content shape. Applications own attachment selection, extraction and image preparation; the Harness transports typed image content and validates model capability. In the standalone terminal, pasting Finder-copied HEIC/HEIF files on macOS converts them to temporary PNGs so Pi can read their pixels. See [the terminal guide](docs/terminal-tui.md#clipboard-image-paste).

`SessionRunInput.initialBashCommand` is an opt-in for one new interactive user turn. It must match
the leading `!` command in `text`; Harness checks it through the same per-call gate as model-issued
Bash, executes it once in Pi's native session, records its bounded result, and asks the model to
inspect that result before replying. Automatic, plan, resumed, relation, probe, and improver runs
cannot carry it. See the [terminal guide](docs/terminal-tui.md#bash-command-mode).

## Curated Hub

`xagent hub list [--refresh]`, `xagent hub show publisher/name@version`, and
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

## Readiness diagnostics

Use `/doctor` in the terminal for local readiness checks and explicitly selected live probes. The same
structured jobs are available through `harness.doctor` and `doctor.*` server methods. See
[Doctor](docs/doctor.md) for coverage, consent, isolation, and provider callbacks.

## Public package

The package is ESM: import from `@xingular/harness` or supported subpaths such as
`@xingular/harness/variant/seed`. JavaScript and declarations are shipped in `dist/sdk`; a
TypeScript loader is not required. Node 22.19 or later is required. The interactive terminal also
requires Bun (release builds use 1.4.2); the CLI reports its version with `xagent --version`.
Original project code is Apache-2.0. See LICENSE, NOTICE.md and THIRD_PARTY_LICENSES.md.

A host providing its own browser tools sets `browser: false` on `createHarness` to disable the
generic backend and prevent tool-name collisions. The desktop App uses this for shared tabs.
The default standalone Harness keeps its isolated browser backend enabled.

See the [1.3.0 release notes](docs/releases/1.3.0.md), [1.2.0 release notes](docs/releases/1.2.0.md),
[1.1.1 release notes](docs/releases/1.1.1.md), and the [release procedure](docs/releases/README.md). Publication requires pre-tag review of the exact candidate, two-OS CI, a separate protected
`npm-publish` approval, registry verification, and npm provenance.
