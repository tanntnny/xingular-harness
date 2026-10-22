# 10 Server protocol

## Purpose

A host that is not a Node program embeds the harness as a child process and talks to it over
newline-delimited JSON on stdin and stdout. The protocol exposes the same in-process API a Node
application uses, run events as they are saved, state-change notices, and calls from the harness
to the host for the extension points the host supplies.

## Components

| Type / function | Module | Role |
|---|---|---|
| `RpcPeer`, `Transport`, `stdioTransport`, `PROTOCOL_VERSION` | `server/rpc.ts` | Framing, requests, replies, host calls. |
| `methods(harness)` | `server/methods.ts` | The method table. |
| `serve`, `attach` | `server/serve.ts` | Registers the table, forwards events and notices. |
| `remoteSecrets`, remote policy, directory, tools | `server/remote.ts` | Extension points supplied by the host over the protocol. |
| CLI `serve` | `src/cli.ts` | `serve --state <dir> --data <dir> --name <product> [--builtins <dir>] [--host-secrets] [--host-policy] [--host-tools] [--host-directory]`. |

## Contracts

```text
host → harness   { v: 1, id, method, params }        harness → host   { v: 1, id, result | error }
harness → host   { v: 1, event }                     a run event, validated, after it is saved
harness → host   { v: 1, notice }                    state changed: read it again
harness → host   { v: 1, id, call, params }          host → harness   { v: 1, id, result | error }
```

- stdout carries only protocol lines; diagnostics go to stderr.
- `harness.methods` lists every method. Groups in the table: `accounts`, `harnesses`, `runs`,
  `connections`, `plugins`, `wiki`, `refine`, `capabilities`, `hub`, `terminal`, `approvals`,
  `harness`, `subagents`, `sessions`, `library`, `recall`, `context`.
- Host calls (only with the matching `--host-*` flag): `secrets.get|set|delete`,
  `policy.scope|authorize|approval|connections`, `tools.call`. The host registers tools with
  `tools.register` and names with `directory.set`, and describes its parts with
  `plugins.describe`.
- `refine.start` takes `{ task, k?, mode?, improver?, executor?, baseVersion?, retainWorkspaces?, id? }`;
  `refine.candidates` returns each execution with `workspace: string | null` (page 05, PROP-0002, PROP-0003).
- `runs.checklist { runId }` returns the run's latest checklist, `[]` when it wrote none (PROP-0006).
- `runs.continuation { runId, sessionDir? }` returns a `Continuation`, and `sessions.run` accepts
  `continueFrom` (page 02, PROP-0007). `harness.status` reports `recovery.interruptedRunIds`.
- Errors carry a stable `code`, a message and an optional hint (`core/errors.ts`).

## Invariants

- **INV-SRV-1** `src/server/methods.ts` is the contract for every non-Node host. Adding a method
  to an existing group is an additive change (update this page). Renaming, removing, or changing
  the params or result shape of a method is an architecture change.
- **INV-SRV-2** A method handler calls the same in-process API a Node application uses. The server
  holds no logic of its own beyond parameter checking.
- **INV-SRV-3** Events reach the host only after they are persisted and redacted (`INV-RUN-3`).
- **INV-SRV-4** Changing the framing or `PROTOCOL_VERSION` is an architecture change.
- **INV-SRV-5** The harness works with none of the host calls supplied (`INV-EXT-2`).
- **INV-SRV-6** After a change to the server, the CLI or startup, `npm run prove` must pass: it
  starts the server on a throwaway data root with no application present and exercises accounts,
  variants, the Wiki, the prompt, connected apps, a recorded session, a plugin hook and the
  refinement demo. The App's sidecar tests parse every reply with its schemas and must pass too.

## Source map

`src/server/*.ts`, `src/cli.ts`, `src/core/errors.ts`, `scripts/prove-standalone.mjs`.
