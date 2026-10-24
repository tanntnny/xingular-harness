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
| `methods(harness)` | `server/methods.ts` | Merges Foundation handlers with built-in plugin handlers from `BuiltinPluginRegistry` and rejects overlapping ownership. |
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
- Run events use the validated, persisted payload schemas in page 02. `question.requested` may carry
  the optional bounded ASCII sketch metadata described there; the server relays it without changing
  answer payloads or the protocol framing (PROP-0024).
- `harness.methods` lists every method. Groups in the table: `accounts`, `harnesses`, `runs`,
  `connections`, `plugins`, `wiki`, `refine`, `capabilities`, `hub`, `terminal`, `approvals`,
  `harness`, `subagents`, `agents`, `sessions`, `sideQuestions`, `library`, `recall`, `context`,
  `worktrees`, `annotations`.
- Host calls (only with the matching `--host-*` flag): `secrets.get|set|delete`,
  `policy.scope|authorize|approval|connections`, `tools.call`. The host registers tools with
  `tools.register` and names with `directory.set`, and describes its parts with
  `plugins.describe`.
- `refine.start` takes `{ task, k?, mode?, improver?, executor?, baseVersion?, retainWorkspaces?, id? }`;
  `refine.candidates` returns each execution with `workspace: string | null` (page 05, PROP-0002, PROP-0003).
- `runs.checklist { runId }` returns the run's latest checklist, `[]` when it wrote none (PROP-0006).
- `agents.list { cwd? }` returns `{ profiles, problems }`; `agents.get { cwd?, name }` one profile;
  `agents.create { cwd?, name, scope: 'global' | 'project', from? }` writes the template or a copy
  and refuses an existing file; `agents.remove { cwd?, name, scope }` deletes a person's own file.
  `subagents.spawn` takes `agent` as a profile name and returns `agent` and `unavailableTools`
  (PROP-0029). It takes an optional `title` (at most six words); without one the child's title is
  the first line of its brief (PROP-0030).
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

Built-in feature modules may contribute handlers through `BuiltinPluginRegistry`, but the
`methods(harness)` result remains the public contract. Plugin module ownership does not rename
methods or change their params, result shapes or authorization paths (PROP-0020).

## Source map

`src/server/*.ts`, `src/cli.ts`, `src/core/errors.ts`, `scripts/prove-standalone.mjs`.

## Doctor jobs (PROP-0011)

| Method | Input | Reply |
|---|---|---|
| `doctor.start` | `{ context: { caller, cwd, accountId, model, tools, variant?, capabilities? }, mode?: "local" \| "live", checks?: string[], confirmed?: boolean }` | `DoctorReport` |
| `doctor.read` | `{ id }` | `DoctorReport` |
| `doctor.cancel` | `{ id }` | `DoctorReport` |

A trusted host attests confirmation for the exact selected live checks. Live mode requires both
`confirmed: true` and non-empty `checks`. Terminal equivalents are `terminal.doctor.*`; every call
requires the control key and each job belongs to its originating terminal. The terminal supplies
its account and pinned variant; the controlled frontend supplies its current model and tool list.

Reports carry job state (`running`, `completed`, `cancelled`), progress, timestamps, selected
account/model, findings, and available live-check notices. Findings distinguish `local` from
`live` and statuses `pass`, `warning`, `fail`, `disabled`, `blocked`, `unverified`. Schemas and
Node types are exported. Jobs are in-memory until shutdown; real live-run records remain.

## Side questions (PROP-0019)

| Method | Input | Reply |
|---|---|---|
| `sideQuestions.start` | `{ question, cwd, caller, context?: { instructions?, transcript?, references? }, parentRunId?, parentSessionId?, accountId?, model?, effort?, runId?, sessionId? }` | `{ runId, sessionId, nativeSessionId }` |
| `sideQuestions.read` | `{ runId, sessionId, afterSequence? }` | `{ run: RunRecord, events: RunEvent[] }` |
| `sideQuestions.interrupt` | `{ runId, sessionId }` | `{ runId }` |

The Harness builds bounded context from the parent's persisted effective prompt and public events
plus the surface's visible transcript. Read and interrupt require the side run's session id. The
standalone terminal exposes the same operations through control-key-protected
`terminal.sideQuestions.*` calls; its caller identity, account and working folder come from terminal
preparation, not client-supplied values.

Remote `tools.register` may include `diagnostics: [{ id, category, title, tools, probe?: { notice,
tool, input, contains } }]`. The host answers `tools.diagnose({ id, context })` with `{ status,
evidence, remedy? }` for local inspection. A probe is a declared registered tool call through
the gate, with an expected response marker; it cannot supply arbitrary executable code.

## Private terminal resource controls (PROP-0013)

These methods are session-socket controls, not additions to the public host RPC table. All
require the claimed terminal control key; account, working directory and variant pin come
from preparation, never from the request.

| Method | Input | Reply |
|---|---|---|
| `terminal.browser.config` | `{}` | `{ allowPrivate }`, the device-local private-address setting |
| `terminal.browser.configure` | `{ allowPrivate: boolean }` | `{ allowPrivate }`, updated setting |
| `terminal.browser.snapshot` | `{ refresh?: boolean }` | `BrowserSnapshot`: resources, plugins, safe connection records, pinned/latest variant identity and Hub overview |
| `terminal.browser.read` | `{ id, latest?: boolean }` | `{ content }`, bounded enumerated resource content |
| `terminal.browser.importSkill` | `{ path }` | `{}`, validated bounded local bundle imported into the existing library |
| `terminal.browser.hubPreview` | `{ id, version, offset? }` | Existing `HubPreviewPage` |
| `terminal.browser.hubDocument` | `{ id, version }` | Existing verified installed document |
| `terminal.browser.connections.appClients` | `{}` | Existing available application OAuth catalog IDs |
| `terminal.browser.connections.save` | `{ input: ConnectionInput }` | Existing safe `Connection` record |
| `terminal.browser.connections.test\|signIn\|signOut\|remove` | `{ id }` | Existing connection service result |

Protected `plugins.install { source }` and `plugins.remove { pluginId }` delegate to the package
service. Optional matching callbacks extend `PluginControl`; hosts without them receive a clear
unsupported-operation error. No protocol version or persisted schema changes.

## Worktrees (PROP-0016)

| Method | Input | Reply |
|---|---|---|
| `worktrees.list` | `{ repo? }` | active `WorktreeRecord[]` (of the repository `repo` is in) |
| `worktrees.removed` | `{ repo? }` | removed records that `restore` can bring back |
| `worktrees.status` | `{ id }` | `WorktreeStatus`: exists, head, changed paths, commits since it started |
| `worktrees.create` | `{ repo, name?, baseRef?, branch?, kind?, carryChanges?, setup? }` | `{ worktree, carried, included, setup }` |
| `worktrees.branch` | `{ id, name }` | the record, on branch `<prefix><name>` |
| `worktrees.handoff` | `{ id, direction: "toSource" \| "toWorktree", move? }` | `{ direction, patched, copied, stash }` |
| `worktrees.remove` | `{ id, force? }` | `{ worktree, snapshot }` |
| `worktrees.restore` | `{ id }` | the record |
| `worktrees.prune` | `{ repo?, keep? }` | `{ removed, failed }` |
| `worktrees.adopt` | `{ path }` | the record (kind `permanent`, origin `adopted`) |
| `worktrees.setup.trust` | `{ repo, hash }` | `{}` |

Errors: `not_a_repository`, `repository_empty`, `worktree_exists`, `branch_exists`,
`worktree_in_use`, `worktree_has_work`, `worktree_removed`, `worktree_missing`, `not_a_worktree`,
`handoff_target_dirty`, `handoff_conflict`, `git_failed`, `git_unavailable`. The terminal reaches the
same service through `terminal.worktrees.*` routes, which need the control key (`INV-TUI-4`).

## Page notes (PROP-0017)

| Method | Input | Reply |
|---|---|---|
| `annotations.list` | `{ url?, query?, status?, offset?, limit? }` | `{ notes, total }`, newest first |
| `annotations.read` | `{ id }` | `Note` |
| `annotations.create` | `{ source, target, body, tags? }` | `Note` (private) |
| `annotations.update` | `{ id, expectedVersion, patch: { body?, tags?, status?, target? } }` | `Note` |
| `annotations.delete` | `{ id, expectedVersion }` | `{}` |
| `annotations.share` | `{ id, principal: { sessionId } \| { agentId }, binding? }` | `Note` |
| `annotations.unshare` | `{ id, principal }` | `Note` |
| `annotations.revokeBinding` | `{ binding }` | `{ revoked }` |
| `annotations.import` | `{ notes }` | `{ imported, skipped }` (ids kept) |
| `annotations.pageScript` | `{}` | `{ script }`: the page helper, with `__ARGS__` for one operation |
| `annotations.queue` | `{ id, sessionId, expectedVersion?, autoSend? }` | `Note`, shared with the session and queued (PROP-0018) |
| `annotations.dequeue` / `annotations.confirm` | `{ id, expectedVersion? }` | `Note` |
| `annotations.queued` | `{ sessionId }` | `{ notes }`, oldest first |
| `annotations.createAndAct` | `{ note, action: save \| queue \| send, sessionId?, trusted? }` | `{ note, send }`; an untrusted send waits for `confirm` |
| `annotations.compose` | `{ sessionId, ids? }` | `{ text, ids }`: one instruction for a host's own `sessions.run` |
| `annotations.delivered` | `{ ids, sessionId, runId }` | `{ notes }`, marked sent |
| `annotations.send` | `{ sessionId, ids? }` | `{ state: sent \| busy \| host \| empty, … }` |
| `annotations.capture.attach` | `{ key, kind: web \| cdp \| bridge, endpoint?, name? }` | `{ kind, app, windows, bridge? }` |
| `annotations.capture.target` | `{ key }` | `{ kind, app, inspecting, windows }` |
| `annotations.capture.selectWindow` | `{ key, window }` | `{}` |
| `annotations.capture.open` | `{ key, url? }` | `{ url, title }` |
| `annotations.capture.inspect` / `stopInspect` | `{ key }` | `{ captureId }` / `{}` |
| `annotations.capture.next` | `{ key, sessionId?, surface? }` | `{ active, trusted, app, note, send, message, … }` |
| `annotations.capture.release` | `{ key }` | `{}` |
| `annotations.bridge.start` | `{}` | `{ port, token, scriptUrl, snippet }` |

Notices: `annotations.changed { sessionId, ids }` after any queue, send or fix;
`annotations.ready { sessionId, ids }` when a host session's waiting notes should be sent now.

Errors: `version_conflict`, `not_found`, `annotation_limit`, `invalid_request`, `invalid_data`. The
terminal reaches the same store through `terminal.annotations.*`, which shares only with its own
session and needs the control key (`INV-TUI-4`).
