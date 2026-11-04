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
  `worktrees`, `annotations`, `commands`, `usage`, `browser`.
- Host calls (only with the matching `--host-*` flag): `secrets.get|set|delete`,
  `policy.scope|authorize|approval|connections`, `tools.call`. The host registers tools with
  `tools.register` and names with `directory.set`, and describes its parts with
  `plugins.describe`.
- `refine.start` takes `{ task, k?, mode?, improver?, executor?, baseVersion?, retainWorkspaces?, id? }`;
  `refine.candidates` returns each execution with `workspace: string | null` (page 05, PROP-0002, PROP-0003).
  A task may carry `guidance` and `workspace: { kind: 'git-snapshot', repo, commit }` (PROP-0052).
- `refine.fromRun { runId? | sessionId?, guidance? }` returns `{ task, run, notes }`, a task that
  replays a typed turn from its snapshot. `refine.candidateDiff { id, label }` returns `{ label, files }`
  and `refine.candidateOutput { id, label }` a filename → text map. `refine.adopt` takes an optional
  `tag` (PROP-0052).
- `variants.tag { scope, name, version }` and `variants.untag { scope, name }` return the scope's tags;
  `variants.tags { scope }` reads them; `variants.resolve { scope, ref }` returns `{ fingerprint, version }`
  for a fingerprint, prefix, tag or `head`; `variants.revert { scope, from, components }` saves a new
  head with those components taken from `from`. `variants.restore` accepts any reference. Lineage rows
  carry `tags`; a version record may carry `tunedFor` (PROP-0052).
- Run records may carry `workspaceSnapshot` (page 02, PROP-0052); hosts tolerate the additive field.
- `runs.todo { runId }` returns the run's latest todo list, `[]` when it wrote none (PROP-0006,
  renamed by PROP-0045). `runs.checklist` is the deprecated pre-rename alias.
- `runs.continuation` returns `todo`; `checklist` remains a deprecated mirror of it for one release.
- Run records include optional nullable `workspaceRoot`, the canonical root whose files a run may
  modify by default (page 02). New Harness runs set it; older records may omit it. Hosts must
  tolerate the additive field and must not nominate or widen the root.
- `agents.list { cwd? }` returns `{ profiles, problems }`; `agents.get { cwd?, name }` one profile;
  `agents.create { cwd?, name, scope: 'global' | 'project', from? }` writes the template or a copy
  and refuses an existing file; `agents.remove { cwd?, name, scope }` deletes a person's own file.
  `subagents.spawn` takes `agent` as a profile name and returns `agent` and `unavailableTools`
  (PROP-0029). It takes an optional `title` (at most six words); without one the child's title is
  the first line of its brief (PROP-0030). With `continue: <runId>` it continues a stopped child of
  this conversation instead (no `agent` or `tools`; `brief` and `title` optional) and returns
  `continued`, the run it continued (ADR-0043).
- `runs.continuation { runId, sessionDir? }` returns a `Continuation` (its `checkpoint` is the last
  work-slice handoff), and `sessions.run` accepts `continueFrom` (page 02, PROP-0007) and `workSlice`
  (PROP-0041). `harness.status` reports `recovery.interruptedRunIds`.
- `workSlice { enabled?, maxToolCalls?, maxMinutes?, maxNewTokens?, maxSlices?, continue? }` on
  `sessions.run` bounds that reply; absent sets no limit (ADR-0081): no call, time or new-token cap, so nothing ends
  or continues at a budget. A limit a caller sets continues up to 8 slices. A token cap, when set, counts new input, cache writes and output, never the
  cached prefix (PROP-0044). `enabled: false` turns the guard off for that run;
  `XINGULAR_WORK_SLICE=off` in the launching process turns it off for every run in it, and nothing is
  persisted. The policy is
  carried into the continuation. A value outside its range is refused with `invalid_request` before
  the run record is written.
- The run-event stream adds `checkpoint` (the bounded handoff) and `heartbeat` (steps, elapsed time,
  last tool, compactions, slice, call budget). Hosts must accept both; an unknown event type is still
  relayed in order (INV-RUN-3).
- `terminalCode` gains `needs_person` and `unfinished` (ADR-0072, ADR-0075): a goal that settled with
  work left — `needs_person` when it ended `blocked`, `unfinished` when it was paused, stalled or
  limited. Both are `interrupted`, carry a `checkpoint`, and are not auto-continued; a host should
  offer the person Continue, as it does for `slice_complete`. An ordinary reply with open todo items
  settles `completed`. Extension notices arrive as `extension.notice` events (for example
  `work-slice` and `goal`).
- `sessions.run` accepts `goal { objective, rounds?, hours? }` (ADR-0072, INV-RUN-16) for a person's
  own top-level run; it is refused with `invalid_request` for a plan, command, unattended or child
  run, or an empty or over-long (4,000 character) objective. The objective is the request, and the
  run continues in place while the goal is active. Goal rounds, claim checks and stops arrive as
  `extension.notice` events with `extension: 'goal'`; a claim check's model request is one more
  `usage.updated` request. Run records carry `goalMode` (`goalId`, `objective`, `status`, `limits`,
  `rounds`, `timeUsedSeconds`, `claimed`, `lastReason`) while a goal exists; `goal` stays the
  request text. A goal active at a work-slice boundary is carried into the continuation run.
- Run streams also carry `tool.refused` with the call id, name, refusal code and bounded reason.
  Run records expose nullable `terminalCode`; `terminalReason` remains descriptive text. Older
  records and events may omit the code. Trajectory search exposes both fields (pages 02 and 08).
- `sessions.run` accepts `live: true` (ADR-0083): the Pi session stays open for the conversation's
  next run. `sessions.live`, `sessions.close`, `sessions.followUp` and `sessions.followUp.clear`
  manage live sessions (page 02). A run refused because the live session is replying fails with
  `session_busy`. `sessions.remoteControl.{start,stop,rotate,confirm,status,status.wait}
  { sessionId, ... }` pair a phone with a live session (page 15); they fail with `not_found` when
  the conversation has no live session.
- Errors carry a stable `code`, a message and an optional hint (`core/errors.ts`).

## Browser configuration and extension (ADR-0082)

Browser settings are device-local, not variant or project settings. `backend` selects the isolated
Harness browser or the explicitly paired Brave extension; a disconnected Brave backend refuses
calls and never falls back. Extension status never returns its bearer token.

| Method | Input | Reply |
|---|---|---|
| `browser.config` | `{}` | `BrowserConfig`: backend, headed, CDP URL, executable path, private-address policy and allowed domains |
| `browser.configure` | partial `BrowserConfig` | Updated `BrowserConfig`; selecting isolated from Brave stops and revokes the extension bridge |
| `browser.extension.status` | `{}` | `BrowserExtensionStatus`: stopped/pairing/waiting/connected/paused, paired/connected/paused flags, loopback port and last heartbeat |
| `browser.extension.start` | `{}` | `{ status, pairingCode?, expiresAt? }`; a new pair code is `port:CODE`, expires after five minutes, and is returned only while pairing |
| `browser.extension.stop` | `{}` | Stopped `BrowserExtensionStatus`; revokes the pairing and rejects pending browser calls |

Normal Harness shutdown closes the bridge while preserving the pairing for reconnection. Explicit
stop revokes it. Pairing validates the extension origin. Every later bridge request requires the
random bearer token, and any supplied Origin must match the paired extension; service-worker fetches
may omit Origin. Loopback authentication is not a substitute for the extension's exact-origin site
allow list.

## Plugin proposals

| Method | Input | Reply |
|---|---|---|
| `plugins.proposals.create` | `{ name, description, files }` (path-to-text object) | pending `Proposal` |
| `plugins.proposals.list` | `{}` | `Proposal[]`, including decided records |
| `plugins.proposals.preview` | `{ id }` | revalidated `Proposal` with current content hash |
| `plugins.proposals.accept` | `{ id, hash }` | accepted `Proposal` |
| `plugins.proposals.reject` | `{ id, hash }` | rejected `Proposal` |

A `Proposal` has `id`, `name`, `description`, `files`, generated `manifest`, `hash`, `createdAt`,
`status` and optional `decidedAt`. Both decisions require the pending proposal's current preview
hash; acceptance installs it switched off without trusting code. These methods expose trusted host
operations, not an assertion that a host has built a review UI. Protected terminal control routes
`plugins.proposals.list|preview|accept|reject` delegate to the same service when configured; they
require the terminal control key. The model tool can create only. Validation and trust details are
on page 06.

## Context attribution (PROP-0049)

| Method | Input | Reply |
|---|---|---|
| `context.attribution` | `{ runId }` | `ContextAttribution`: the model and window, the measured `used` and its `share`, `source` (`measured` or `estimate`), the request index, the compaction reserve and `free`, one row per contributor (`tokens`, share, owner group, `always`, `estimated`, budget, cut, tool breakdown, note), `history` of the window at each request, `compactions`, `onDemand` variant components, group totals and the reconciliation `note` |
| `context.runDetails` | `{ runId }` | Recorded status, effective mode, model, effort, variant, workspace, tool names, connectors, successful named `skill_load` calls and observed activated extensions; unknown observations are `null`, not inferred from available contributions |
| `terminal.context` | `{ runId?, section? }` | `{ attribution, text }` for the selected run in this terminal's native conversation, or its latest run when omitted; one row's text when `section` names it |

The rows are read from what the run recorded — `runs/<id>/context.json` for the sections and their
rendered sizes, `context.snapshot` for the prompt, the update and every tool schema, `usage.updated`
for the provider's own figure. Nothing is written. A row is estimated at four characters per token;
the conversation row is the measured total less the rows above it, so the rows add up to the figure
the provider reported rather than to an estimate of their own. When the pack carries no rendered
sizes, or the snapshot was truncated, the reply says the split is approximate. `terminal.context`
checks a supplied run against the terminal's native conversation; without one it resolves the latest run. Skill observations cover `skill_load`, not direct file reads; extension observations are unavailable when the loader cannot establish ownership, including terminal runs.

## Usage (PROP-0042)

| Method | Input | Reply |
|---|---|---|
| `usage.summary` | `{ scope?: "session" \| "account" \| "project" \| "all", sessionId?, accountId?, projectId?, period?: "today" \| "7d" \| "30d" \| "all", timezoneOffsetMinutes? }` | `UsageSummary`: totals, cache hit rate, latency, day/model/provider/account/session breakdowns, unpriced count, ledger time |
| `usage.limits` | `{ accountId?, refresh?: boolean }` | `UsageLimitsReport`: per account and provider, the reading source, reason, observed time and limits |
| `usage.sync` | `{}` | `{ runs, indexed, lastIndexedAt }` |

The methods are contributed by the built-in `usage` plugin module and read only derived or stored
data; `refresh: true` is the only form that may contact a provider, once per due provider. The
terminal reaches the same service through protected `terminal.usage.summary|limits`, whose scope
comes from the terminal session, never from the request.

## Commands and session controls (PROP-0040)

`commands.list { cwd?, accountId?, agentId?, projectId? }` returns `ListedCommand[]`: `name`,
optional `aliases`, `args`, `description`, `owner`, plus `group`, `source`
(`core | plugin | extension | prompt | skill`) and optional core `kind` (`session | page | local`).
Core metadata comes from `commands/registry.ts`; effective plugin contributions supply other routes.
Under the approved ADR-0061 contract, plugin-owned extension commands and package-owned prompt
templates are listed only by their owner-qualified `/<owner-prefix>:<name>` routes, with an
explicit root `/<owner-prefix>:` only for a declared default (a package uses
`harness.defaultPrompt` for its own template). No bare plugin alias is listed or dispatched.
Standalone templates, `/skill:<name>`, core commands and their core aliases retain their existing
forms. Owner-prefix and same-owner route collisions fail closed with owner diagnostics, not a
winner chosen by discovery order. Discovery, completion and dispatch share these rules;
listing neither runs a command nor proves surface acceptance. This is an approved contract, not
a claim that every surface has implemented or passed it.

For the methods below, `ref` means `{ sessionDir, sessionFile?, cwd? }`.

| Method | Input | Reply |
|---|---|---|
| `sessions.tree` | `ref` | `SessionTree`: file, leaf, entries and user-message fork points |
| `sessions.navigate` | `ref + { entryId }` | `{ leafId, editorText? }`; no summary/model request |
| `sessions.fork` | `ref + { entryId, targetDir }` | `{ sessionFile, editorText }` |
| `sessions.clone` | `ref + { targetDir }` | `{ sessionFile }` |
| `sessions.rename` | `ref + { name }` | `{ name }` |
| `sessions.lastReply` | `ref` | `{ text: string | null }` |
| `sessions.export` | `ref + { path }` | `{ path }`; absolute `.jsonl` branch export |
| `sessions.reload` | `{}` | `{ reloaded: true }`; reloads persistent hooks; structured turns load resources fresh |

`sessions.run` also accepts `command` for compact, navigation with optional summary, or HTML
export instead of prompt submission (page 02). These retain tracked run lifecycle and pins.
Saved-history helpers currently validate file scope but do not themselves fence active work;
host adapters must not infer concurrency safety from method availability.

## Socket transport and the long-lived harness (ADR-0083)

`server/socket.ts::serveSocket` serves the same framing on a Unix socket, readable and writable by
its owner only, with one peer per connection; a closed connection stops receiving events and
notices. `connectHarness` is the matching client. The long-lived harness (page 11) adds
`daemon.status` → `{ pid, version, startedAt, variantScope, windows, hosts, live, detached }` and
`daemon.stop` on its own socket only. `version` is the package version and `windows` the count of
terminal sessions the harness serves (detached ones included) and `hosts` the names of the hosts
connected; a daemon older than the handshake reports neither. A client that starts a window compares `version` with its own (page 11).

| Method | Input | Reply |
|---|---|---|
| `terminal.detach` | `{ sessionId }` | `{ detached, activeRunId }`; a client terminal with a running reply keeps it without a window, anything else is disposed |
| `terminal.detached` | `{}` | `{ sessions: DetachedTerminal[] }`: session id, folder, history folder, account, active run, history file, time |
| `terminal.takeRelaunch` | `{ sessionId }` | the `TerminalRelaunch` the session asked for, or null |

`terminal.prepare` accepts `attach: true` to reconnect to a detached session of the same id, folder,
history folder and account. The private `terminal.live.*` routes are listed on page 11.

## Hosts on the long-lived harness (ADR-0084)

A host that embeds the harness gives it its secret store, policy, names, tools, connected-apps broker
and refine host in-process. A host that connects to the daemon's socket gives the same things as calls
the harness makes back to it, with the same names the stdio host calls use (`secrets.*`, `policy.*`,
`directory.set`, `tools.register`/`tools.call`/`tools.diagnose`, and for a broker `broker.list`,
`broker.call`, `broker.revision`; for refinement `refine.workspace`, `.session`, `.cleanup`,
`.deliverable`). A client answers them with `HarnessClient.handle`.

- `host.register { name, secrets?, policy?, directory?, tools?, broker?: { names, note? }, refine? }`
  makes the connection a host and replies `{ name, resumed }`, the sessions that name already owns.
  `name` is the host's own; the harness names no host (INV-BND-2).
- A session belongs to the host whose connection started its first run (`sessions.run`,
  `sessions.spawnSubagent`). A subagent's or side question's run belongs to the host of the run that
  started it. The owner is kept for as long as the daemon runs, so a host that reconnects under its name
  finds its sessions again.
- A host hears only the run events of its own sessions. Any other client hears every event, as before.
- Calls are routed by the session's owner. A run with no host (a terminal's) is gated, named and given
  tools as with no host at all. When the owner is not connected, `scope` and `authorize` fail with
  `host_unavailable`, an approval has no facts (`unattended`), connections are empty and a secret read
  fails: nothing is approved on a host's behalf in its absence.
- The host's tools reach only its own sessions; a tool the harness itself offers a host's session (a
  paired browser's) wins over a host tool of the same name.
- `harness.open` with the root already open returns the recovery already made and changes nothing, so
  a second host cannot mark the first host's running replies interrupted.
- A daemon a host starts gets its construction options from a launch file, `xagent daemon run
  --host-config <file>` (`DaemonLaunch`, page 11). `OAUTH_CLIENTS_ENV` carries sign-in client secrets,
  never the file.

## Invariants

- **INV-SRV-1** `src/server/methods.ts` is the contract for every non-Node host. Adding a method
  to an existing group is an additive change (update this page). Renaming, removing, or changing
  the params or result shape of a method is an architecture change.
- **INV-SRV-2** A method handler calls the same in-process API a Node application uses. The server
  holds no logic of its own beyond parameter checking.
- **INV-SRV-3** Events reach the host only after they are persisted and redacted (`INV-RUN-3`).
- **INV-SRV-4** Changing the framing or `PROTOCOL_VERSION` is an architecture change. A transport
  that carries the same framing (stdio, the owner-only socket) is not; a new one is listed here.
- **INV-SRV-5** The harness works with none of the host calls supplied (`INV-EXT-2`).
- **INV-SRV-6** After a change to the server, the CLI or startup, `npm run prove` must pass: it
  starts the server on a throwaway data root with no application present and exercises accounts,
  variants, the Wiki, the prompt, connected apps, a recorded session, a plugin hook and the
  refinement demo. The App's sidecar tests parse every reply with its schemas and must pass too.
- **INV-SRV-7** A host on the long-lived harness is not a second writer: the daemon is the only
  process writing a state folder's data root for it. What only the host has is answered by calls,
  routed by the session's owner (above). A host that embeds its own harness is a separate writer, as
  before; that stays the default until a host's daemon mode has been used for days (ADR-0084).

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
| `terminal.usage.summary\|limits` | `{ scope, period, timezoneOffsetMinutes }` / `{ refresh? }` | Existing usage service result, scoped to this terminal's account and project |
| `terminal.usage.allLimits` | `{ refresh? }` | All-account provider limits; refresh reads providers due under the configured cache interval, without changing the pinned account |
| `terminal.usage.headers` | `{ provider, status, headers }` | `{}`; only limit-bearing headers, throttled, stored as an account limit reading |

Remote control (page 15, ADR-0056) adds these protected controls:

| Method | Input | Reply |
|---|---|---|
| `terminal.remoteControl.start` | `{ interface?: 'auto' \| 'tailscale' \| 'lan' }` | `RemoteStatus`; listening on one Tailscale or private address |
| `terminal.remoteControl.stop` \| `rotate` | `{}` | `RemoteStatus`; stopped, or a new link with every device unpaired |
| `terminal.remoteControl.confirm` | `{ requestId, allow }` | `RemoteStatus`; the person's answer to a pair request |
| `terminal.remoteControl.status` \| `status.wait` | `{}` / `{ revision }` | `RemoteStatus`; the wait returns at once for a changed revision, otherwise within 20 seconds |

Protected `plugins.install { source }`, `plugins.update { pluginId? }` and
`plugins.remove { pluginId }` delegate to the package service. Removing a Hub-owned package routes
through Hub's receipt-aware uninstall; a floating update refuses Hub-owned packages, while an
update-all skips them. Optional matching callbacks extend `PluginControl`; hosts without them
receive a clear unsupported-operation error. No protocol version or persisted schema changes.

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
| `annotations.markPending` | `{ id, sessionId, expectedVersion? }` | `Note`, shared with the session and unsent (PROP-0018, PROP-0048) |
| `annotations.confirm` | `{ id, expectedVersion? }` | `Note` |
| `annotations.confirmAll` | `{ sessionId }` | `{ notes }`: every page-origin note of the session, confirmed |
| `annotations.pending` | `{ sessionId }` | `{ notes }`, unsent, oldest first |
| `annotations.clear` | `{ sessionId }` | `{ notes }`: the session's unsent notes, resolved and no longer shared with it |
| `annotations.createAndAct` | `{ note, action: save \| send, sessionId?, trusted? }` | `{ note, send }`; with a session the note is always shared; `send` sends all unsent notes; an untrusted note waits for `confirm` |
| `annotations.compose` | `{ sessionId, ids?, prompt? }` | `{ text, ids }`: one message for a host's own `sessions.run`, with the person's request last |
| `annotations.delivered` | `{ ids, sessionId, runId }` | `{ notes }`, marked sent |
| `annotations.send` | `{ sessionId, ids?, prompt? }` | `{ state: sent \| busy \| host \| empty, …; empty has unconfirmed }` |
| `annotations.capture.attach` | `{ key, kind: web \| cdp \| bridge, endpoint?, name? }` | `{ kind, app, windows, bridge? }` |
| `annotations.capture.discover` | `{}` | `{ apps: [{ endpoint, port, name, browser, electron, windows }] }`: apps on a loopback DevTools port |
| `annotations.capture.launch` | `{ key, path, args? }` | `{ kind: cdp, app, windows, endpoint }`: starts the app with a DevTools port and attaches |
| `annotations.capture.target` | `{ key }` | `{ kind, app, inspecting, windows }` |
| `annotations.capture.selectWindow` | `{ key, window }` | `{}` |
| `annotations.capture.open` | `{ key, url? }` | `{ url, title }` |
| `annotations.capture.inspect` / `stopInspect` | `{ key }` | `{ captureId }` / `{}` |
| `annotations.capture.next` | `{ key, sessionId?, surface? }` | `{ active, trusted, app, note, send, message, … }` |
| `annotations.capture.release` | `{ key }` | `{}` |
| `annotations.bridge.start` | `{}` | `{ port, token, scriptUrl, snippet }` |

Notices: `annotations.changed { sessionId, ids }` after any share, send or clear;
`annotations.ready { sessionId, ids }` when a host session's waiting notes should be sent now.

Errors: `version_conflict`, `not_found`, `annotation_limit`, `invalid_request`, `invalid_data`. The
terminal reaches the same store through `terminal.annotations.*`, which shares only with its own
session and needs the control key (`INV-TUI-4`).

## Links (ADR-0047)

A link a person clicks is a person's action, not a model tool call: nothing here is in
`HARNESS_TOOLS`, so the gate, standing approvals and redaction never see it. `core/links.ts` holds
the one allowlist both front ends use, and `openLink` is the only door into the operating system.

| Method | Input | Reply |
|---|---|---|
| `links.open` | `{ target, base? }` | `OpenedTarget`: `{ kind: "web", url }`, `{ kind: "mail", address }`, `{ kind: "file", path }` or `{ kind: "directory", path }` |

`target` is what the link says; `base` is the absolute folder a relative target is resolved
against, and without it a relative target is refused. `linkTarget` classifies without touching the
filesystem (`http`/`https`, `mailto`, `file`, an absolute path, or a relative path under `base`),
and `openableTarget` then checks what it names: a regular file or a directory, never an application
bundle, an installer, or a launchable script, and never a file with an executable bit set, because
`xdg-open` runs one. The address is passed to `open`/`xdg-open`/`rundll32` as one argument, never
through a shell.

Errors: `link_not_openable`, with a message a person can read, and `invalid_request` when `target`
is missing. The opener is `HarnessOptions.linkOpener`, so a host with its own native opener keeps
the policy and replaces only the spawn.
