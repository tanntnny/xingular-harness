# 00 Overview

## Purpose

`@xingular/harness` runs one agent run well, on Pi, for any application that embeds it. It owns
what a model is told (the variant and the compiled prompt), what it can do (tools, the gate,
connected apps), what it remembers (Wiki notes, run history), how a run is recorded, and how a variant
of the harness is improved from evidence (refinement). It knows a *caller*, a *session* and a
*run*. It does not know what an application is or what its objects mean.

## Layers

```text
Host (for example the App repo)             presentation, windows, PTY, keychain, native OS bridges, host-only surfaces
   │  seven extension points (01) and the server protocol (10)
Harness (this package)                      every capability: variants, prompt, sessions, runs, gate, Wiki, history,
                                            plugins, MCP, refinement, world tools, worktrees, annotations,
                                            and the reference terminal frontend
   │  Pi SDK: createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader
Pi                                          model calls, native JSONL history, tool execution, extensions
```

- **Pi** supplies the model runtime, native history, tool execution and the extension API.
- **The harness** decides everything Pi is given: the account folder, the prompt, the tools, the
  extensions, skills and prompts it may load, and the gate in front of each tool call. It records
  every run. It owns every capability a person uses, and its standalone terminal surfaces each one
  (page 14, `INV-PAR-1`).
- **A host** presents the same capabilities with its own UI, supplies what only it knows through
  the extension points, and reads what the harness records. The terminal and a host offer the same
  capabilities; a host may add registered host-only surfaces (`INV-PAR-4`).

**Belongs in the harness:** Pi sessions and accounts, variants and refinement
(Propose–Probe–Compose, selection, the experience library), the prompt compiler and its delivery,
project notes (the Wiki), recall, the tool gate and standing approvals, connectors (MCP), terminal
sessions and their owned standalone frontend, generic web/isolated-browser tools, managed git
worktrees (PROP-0016), page annotations (PROP-0017), and the server protocol.

**Stays in the host:** windows, the PTY, the keychain, native operating-system bridges (a WebKit
tab, computer control) behind Harness contracts (`INV-PAR-3`), presentation, and registered
host-only surfaces (`INV-PAR-4`). Orchestration across agents (organizations, routed chats, group
chats, delegated work queues) is not a Harness capability; a host that wants it must first bring it
here through a proposal, with a terminal surface.

This package is consumed as source by the App's sidecar and is meant to be embedded by other
applications, so a change here changes every application built on it.

The application side of the boundary is described in
[`App/docs/architecture/overview.md`](../../../App/docs/architecture/overview.md).

## Foundation and variants

The harness has two halves, and every page uses these two words for them.

- The **foundation** is the part that is fixed. Code and release change it; nothing running
  through it can. It is the Pi hookup, the prompt compiler and its budgets, sessions, runs and the
  run recorder, the tool gate and standing approvals, accounts and their isolation, plugin-code
  trust, the variant surface with its validator and always-on cap, the refinement method (its
  budget identity and answer-free rule), the seven extension points and the server protocol.
- A **variant** is the part that mutates: one tree of eight components (c1–c8) for one scope,
  stored as immutable, validated versions (page 03). A scope's *head* is the variant it runs now;
  a *version* is a recorded variant; a *candidate* is a variant refinement proposed.

"The harness" means the foundation together with the variant it is running.

```text
  foundation  ──runs──►  variant (pinned head)  ──►  run record, events, trajectories
      ▲                                                        │
      │ person adopts                                          ▼
      └──────────  candidate variants  ◄── refinement (improvers edit a copy)
```

1. The foundation runs a session on a pinned variant and records everything the run did.
2. Refinement reads those records, lets improver sessions edit a *copy* of the variant, probes
   each candidate and picks one final output without seeing a score (page 05).
3. A person adopts a candidate. Only then does it become the head, and only with its plugin code
   trusted. The next run pins the new head.

The rule between the halves is one-way. A variant decides what the agent is told and which
skills, scripts, subagents and plugins it may load. It cannot alter the compiler, the gate, the
recorder, accounts or trust: variant plugins run inside the tool loop, but the gate is always the
last extension loaded (`INV-GATE-2`). Refinement never edits the foundation (`INV-FND-1`) and has
one door into a variant (`INV-FND-2`).

When a rule is unclear, ask which half the thing belongs to. If an agent or an improver could
legitimately change it, it is a variant concern. If changing it would need a release, it is the
foundation. Page 04 and DESIGN-0001 draw the same line inside the prompt: foundation text is
contract prose about mechanics, variant text is work guidance.

The improver prompts in `refine/prompts.ts` and the evidence folder's `harness/` names keep the
Harness² paper's own vocabulary, where "the harness" is what the improver edits. They are method
text, and changing them would change the method (`INV-REF-3`).

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
| `trust` | `VariantTrust` | `variant/trust.ts` | 03 |
| `refine` | `Refinements` | `refine/service.ts` | 05 |
| `plugins` | `Plugins` | `plugins/plugins.ts` | 06 |
| `hooks` | `Hooks` | `plugins/hooks.ts` | 06 |
| `apps` | `ConnectedApps` | `mcp/service.ts` | 09 |
| `hub` | `Hub` | `hub/hub.ts` | 09 |
| `terminals` | `Terminals` | `terminal/terminals.ts` | 11 |
| `worktrees` | `Worktrees` | `worktrees/service.ts` | 02, 14 |
| `bus` | `Bus` (state-changed notices) | `core/bus.ts` | 10 |

Modules with no member of their own: `variant/` (functions over the variant store), `prompt/compile.ts`,
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
| **C** Context | The compiler, stable prefix and updates, the versioned variant (c1–c8), skills, on-demand Wiki notes |
| **L** Lifecycle | Run state, interrupt, recovery, approvals and questions, subagents, refinement |
| **O** Observability | Validated run events saved per run; usage counters |
| **V** Verification | Isolated refinement probes and answer-free selection |
| **G** Governance | The per-call gate, standing approvals, account pinning, redaction |

The host's column (PTY, windows, native bridges, presentation) is in the parent `AGENTS.md` and
the App's architecture pages. Page 14 states how the terminal and a host share capabilities.

## Invariants

- **INV-BND-1** The harness imports nothing from an application. Application data reaches it only
  through the extension points (page 01) or the server protocol (page 10).
- **INV-BND-2** The harness names no application and no application concept (agent role, group,
  task, pane, handoff, App browser workspace, computer use) in code paths it reads or text a model or
  person sees. Text names the product through `env.productName` (default `Xingular Harness`;
  `{product}` in a tool description). Ids such as `agentId`, `projectId` and a variant `scope` are
  opaque; names come from `Directory` or `CallerContext.agentName`. A managed git worktree is a
  Harness object since PROP-0016.
- **INV-BND-3** A new need of one application is met by a generic extension point or option,
  never by a branch on an application's name or concept.
- **INV-BND-4** Variants, the prompt compiler and Wiki notes are synchronous (`variant/`, `prompt/`,
  `wiki/`). A synchronous function is the critical section; do not make them async. Accounts, Pi,
  MCP and refinement are async.
- **INV-BND-5** The process never launches against `~/.pi`, `~/.codex` or `~/.claude`, and never
  inherits a credential variable (`isolateProcess`, page 09).
- **INV-BND-6** Tests never make a model request; they use a fake `SessionFactory`.

## Source map

`src/harness.ts`, `src/index.ts` (public exports), `src/core/` (env, caller, bus, errors, fs,
text, index), `src/cli.ts` (command line). Boundary decisions: [PROP-0015](proposals/PROP-0015-one-capability-surface.md),
[ADR-0017](../decisions/ADR-0017-one-capability-surface.md).
