# 00 Overview

## Purpose

`@xingular/harness` runs one agent run well, on Pi, for any application that embeds it. It owns
what a model is told (the harness tree and the compiled prompt), what it can do (tools, the gate,
connected apps), what it remembers (Wiki notes, run history), how a run is recorded, and how the
harness itself is improved from evidence (refinement). It knows a *caller*, a *session* and a
*run*. It does not know what an application is or what its objects mean.

## Layers

```text
Application (for example the App repo)      agents, groups, tasks, projects, worktrees, UI, PTY, keychain
   │  seven extension points (01) and the server protocol (10)
Harness (this package)                      trees, prompt, sessions, runs, gate, Wiki, history, plugins, MCP, refinement, terminal
   │  Pi SDK: createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader
Pi                                          model calls, native JSONL history, tool execution, extensions
```

- **Pi** supplies the model runtime, native history, tool execution and the extension API.
- **The harness** decides everything Pi is given: the account folder, the prompt, the tools, the
  extensions, skills and prompts it may load, and the gate in front of each tool call. It records
  every run.
- **The application** supplies what only it knows, through the extension points, and reads what
  the harness records.

**Belongs in the harness:** Pi sessions and accounts, harness trees and refinement
(Propose–Probe–Compose, selection, the experience library), the prompt compiler and its delivery,
project notes (the Wiki), recall, the tool gate and standing approvals, connectors (MCP), terminal
sessions and their owned standalone frontend, and the server protocol.

**Stays in the application:** agents, groups, conversations, tasks and coordination, projects and
worktrees, files, browser and computer use, windows, the PTY, the keychain, and application UI.

This package is consumed as source by the App's sidecar and is meant to be embedded by other
applications, so a change here changes every application built on it.

The application side of the boundary is described in
[`App/docs/architecture/overview.md`](../../../App/docs/architecture/overview.md).

## Components

`Harness` (`src/harness.ts`) is the composition root. `createHarness(options)` builds one and
opens the data root.

| Member | Type | Module | Page |
|---|---|---|---|
| `env` | `HarnessEnv` (`root`, `directory`, `productName`) | `core/env.ts` | 01 |
| `accounts` | `Accounts` | `accounts/` | 09 |
| `sessions` | `Sessions` | `sessions/sessions.ts` | 02 |
| `runs` | `RunRegistry` | `sessions/registry.ts` | 02 |
| `subagents` | `Subagents` | `sessions/subagentService.ts` | 02 |
| `approvals` | `Approvals` | `sessions/approvals.ts` | 07 |
| `trust` | `TreeTrust` | `tree/trust.ts` | 03 |
| `refine` | `Refinements` | `refine/service.ts` | 05 |
| `plugins` | `Plugins` | `plugins/plugins.ts` | 06 |
| `hooks` | `Hooks` | `plugins/hooks.ts` | 06 |
| `apps` | `ConnectedApps` | `mcp/service.ts` | 09 |
| `hub` | `Hub` | `hub/hub.ts` | 09 |
| `terminals` | `Terminals` | `terminal/terminals.ts` | 11 |
| `bus` | `Bus` (state-changed notices) | `core/bus.ts` | 10 |

Modules with no member of their own: `tree/` (functions over the tree store), `prompt/compile.ts`,
`wiki/notes.ts`, `history/`, `tools/`, `capabilities/`, `server/`.

### Lifecycle

1. **Construct.** `isolateProcess` removes inherited credentials and points Pi's fallback folder
   away from `~/.pi` before anything else. Stores and services are created.
2. **Open a data root** (`open(dataRoot)`). Lays out folders, moves an earlier Wiki aside once,
   migrates connection scopes, marks runs that never settled as interrupted (unless another live
   process owns them), and syncs the recall index. Returns a `Recovery`, which lists the
   interrupted runs; the application may continue one as a new run (`continueFrom`, page 02).
3. **Serve.** Sessions, refinements, terminals and RPC calls run. Every run event is persisted,
   then relayed to listeners; finished runs are indexed for recall and announced to hooks.
4. **Close** (`close()`). Stops the hub, refinements, terminals and live runs, settles hooks,
   closes connected apps and the index.

## ETCLOVG: the harness's share

| Letter | The harness owns |
|---|---|
| **E** Execution | Isolated account folders, the Pi session, the terminal launch spec |
| **T** Tools | History, trajectory, Wiki notes, skill loading, `ask_user`, the run checklist, the connected-apps broker, the tool gate |
| **C** Context | The compiler, stable prefix and updates, the versioned tree (c1–c8), skills, on-demand Wiki notes |
| **L** Lifecycle | Run state, interrupt, recovery, approvals and questions, subagents, refinement |
| **O** Observability | Validated run events saved per run; usage counters |
| **V** Verification | Isolated refinement probes and answer-free selection |
| **G** Governance | The per-call gate, standing approvals, account pinning, redaction |

The application's column (PTY, worktrees, roles, tasks, review, schedules, UI) is in the parent
`AGENTS.md` and the App's architecture pages.

## Invariants

- **INV-BND-1** The harness imports nothing from an application. Application data reaches it only
  through the extension points (page 01) or the server protocol (page 10).
- **INV-BND-2** The harness names no application and no application concept (agent role, group,
  task, pane, worktree, handoff, browser, computer use) in code paths it reads or text a model or
  person sees. Text names the product through `env.productName` (default `Xingular Harness`;
  `{product}` in a tool description). Ids such as `agentId`, `projectId` and a tree `scope` are
  opaque; names come from `Directory` or `CallerContext.agentName`.
- **INV-BND-3** A new need of one application is met by a generic extension point or option,
  never by a branch on an application's name or concept.
- **INV-BND-4** Trees, the prompt compiler and Wiki notes are synchronous (`tree/`, `prompt/`,
  `wiki/`). A synchronous function is the critical section; do not make them async. Accounts, Pi,
  MCP and refinement are async.
- **INV-BND-5** The process never launches against `~/.pi`, `~/.codex` or `~/.claude`, and never
  inherits a credential variable (`isolateProcess`, page 09).
- **INV-BND-6** Tests never make a model request; they use a fake `SessionFactory`.

## Source map

`src/harness.ts`, `src/index.ts` (public exports), `src/core/` (env, caller, bus, errors, fs,
text, index), `src/cli.ts` (command line).
