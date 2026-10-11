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
| Tools | `src/tools/` | Tool definitions, the memory tools, `ask_user`; a gate that asks the application's policy, then standing approvals, then the person. |
| Connected apps | `src/mcp/` | MCP connections, OAuth, per-session grants, redaction, a trace of what each call returned. |
| Terminal | `src/terminal/` | A `pi` command in a terminal the application draws: launch spec, telemetry extension, and the session socket with the `agentx-wiki` and `agentx-mcp` commands. |
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
  builtins: ['/path/to/builtin']    // folders of built-in skills, prompts, and rules
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
An application adds what it knows through five points:

1. **Prompt sections** (`Launch.sections`, `Launch.toolGroups`, `Launch.references`). Each
   section has an `order` and may be `dynamic`. The harness adds its own (`blocks` 30, `rules` 40,
   `references` 50, `skills` 60, `knowledge` 80, `tools` 90), applies budgets and the caller's
   context profile, keeps stable sections in the system prompt, and sends dynamic ones as
   updates.
2. **Tool providers** (`harness.sessions.provide`). A provider returns `ToolSpec`s for a session;
   only the names in the session's `allow` list are registered, in that order.
3. **`ToolPolicy`**. `scope` says whether a call is inside what the run may do (or needs one
   approval); `authorize` says whether the tool is still switched on; `approval` adds facts for
   standing approvals; `connections` narrows the connected apps a session reaches.
4. **`SecretStore`**. Where credentials live (a keychain, a vault). Keys are
   `<account id>/<name>`.
5. **`Directory`**. Names for the application's ids, shown in what the harness writes.

`apps.expose(...)` additionally offers the application's tools through the connected-apps
broker (`mcp_list_tools`, `mcp_call_tool`), which is how a terminal session reaches them.

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

`npm run prove` starts that server on a throwaway data root, with no application present, and
exercises accounts, memory, skills, the prompt, connected apps, and a recorded session.

## Storage

```
<data root>/
  wiki/             home.md, library/, projects/<slug>/, facts/, blocks/, revisions, inbox, log
  registry/         skills/, prompts/, rules/   (a person's own; never copied)
  runs/<id>/        run.json, events.jsonl, context.json, caller.json
  config/           context profiles, skill enablement, settings the harness reads
  index.sqlite      a rebuildable index of Wiki entries and runs (FTS5)
  projects.json     read only: the application owns it

<state dir>/
  accounts/         registry, per-account Pi agent folders, audit log
  approvals.json    standing approvals
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
