# 01 Extension points

## Purpose

An application adds what it knows to the harness through exactly seven surfaces. They are the
whole interface in the application-to-harness direction; anything else an application needs is
added as a new generic surface, by proposal.

## Components

Each surface is an option of `createHarness` (`HarnessOptions`) or a per-run input, and has a
server-protocol equivalent for a host that is not a Node program (page 10).

| # | Surface | Declared in | How it is supplied | Over the protocol |
|---|---|---|---|---|
| 1 | Prompt sections | `Launch` in `prompt/compile.ts` (`sections: HostSection[]`, `toolGroups: HostToolGroup[]`, `references: Reference[]`) | `SessionRunInput.launch` per run | `sessions.run` params |
| 2 | Tool providers | `ToolProvider`, `ToolSpec`, `ToolSession` in `tools/types.ts` | `harness.sessions.provide(provider)` | `tools.register` + host call `tools.call` (`--host-tools`) |
| 3 | `ToolPolicy` | `sessions/policy.ts` (`scope`, `authorize`, `approval`, `connections`) | `HarnessOptions.policy` | host calls `policy.*` (`--host-policy`) |
| 4 | `SecretStore` | `accounts/secrets.ts` (`get`, `set`, `delete`) | `HarnessOptions.secrets` (default: owner-only file in the state dir) | host calls `secrets.*` (`--host-secrets`) |
| 5 | `Directory` | `core/env.ts` (`agentName`, `sessionAgent`) | `HarnessOptions.directory` | `directory.set` (`--host-directory`) |
| 6 | Plugin descriptions | `PluginDescriptor` in `plugins/types.ts` | `HarnessOptions.plugins`, `harness.describe()` | `plugins.describe` |
| 7 | `RefineHost` | `refine/host.ts` (`prepareWorkspace`, `session`, `deliverable?`) | `HarnessOptions.refineHost` (default: temp copy of the source, Pi file and shell tools) | — (Node only today) |

The caller is not an extension point but the frame every call carries: `CallerContext`
(`core/caller.ts`) holds opaque `agentId`, `projectId`, `sessionId`, `runId`, `agentName`,
`actor` (`Chat` or `Code`), `surface`, `recallExcludeAgents` and an opaque `policyContext` that the
harness forwards to the policy and never reads.

## Contracts

1. **Prompt sections.** A `HostSection` has `id`, `title`, `body` (`null` declares a withdrawn
   slot), `budget`, `order`, optional `dynamic` and `pinned`. The harness places it among its own
   sections by `order` (page 04).
2. **Tool providers.** Providers are asked in the order they were added, for each session. Only
   names in the run's frozen capability set are registered. A `ToolResult` may carry
   `attachments` as `{ id, name, mimeType }` references; bytes stay with the provider.
3. **`ToolPolicy`.** `scope(call)` → `ScopeDecision { allowed, requiresApproval?, automatic?,
   humanOnly?, allowGlobalApproval?, reason? }`; `authorize(call)` throws to block and is asked
   again after an approval; `approval(...)` returns `ApprovalFacts { unattended?, readOnly?,
   inScope? }`; `connections(...)` narrows the connected apps. With no policy, every enabled tool
   may run and gated tools ask the person.
4. **`SecretStore`.** Keys are `<account id>/<name>` (`secretKey`).
5. **`Directory`.** Every lookup may answer `null`.
6. **Plugin descriptions** are data. They change what `plugins.list` and `plugins.inventory`
   report, never what runs. A descriptor with a harness plugin's id is ignored.
7. **`RefineHost`.** `prepareWorkspace` returns an isolated folder (never one a person works in)
   and an optional `cleanup`; `session` returns a `RolloutSession` (caller, tools, launch, model,
   account); `deliverable` maps file names to readable text.

## Invariants

- **INV-EXT-1** There are seven extension points. Adding, removing or changing the shape of one is
  an architecture change; update this page and affected contracts in the same change.
- **INV-EXT-2** Every extension point is optional. The harness runs with none of them supplied.
- **INV-EXT-3** An extension point carries data or decisions the application owns. It never
  carries an application's name or a branch for one application (`INV-BND-3`).
- **INV-EXT-4** Each Node extension point has a protocol equivalent, or the page says it is
  Node-only (today only `RefineHost`).
- **INV-EXT-5** `CallerContext` fields are trusted host context, never model arguments. A tool may
  not let the model set them.

## Data

None of its own. Secrets go to the `SecretStore`; everything else is passed per call.

## Source map

`src/core/caller.ts`, `src/core/env.ts`, `src/prompt/compile.ts` (`Launch`), `src/tools/types.ts`,
`src/sessions/policy.ts`, `src/accounts/secrets.ts`, `src/plugins/types.ts`
(`PluginDescriptor`), `src/refine/host.ts`, `src/server/remote.ts` (protocol equivalents).

## Provider diagnostics

Tool providers optionally carry `diagnostics(context)` metadata (PROP-0011). Checks expose local
readiness callbacks and declared live probes. Existing callable provider functions remain valid.
This extends surface 2; the number of extension points remains seven. `WorldPart` forwards the
same callback. Remote `tools.register` accepts diagnostic descriptors; `tools.diagnose` returns
local readiness data. Optional remote single-tool probe recipes go through the normal gate.
