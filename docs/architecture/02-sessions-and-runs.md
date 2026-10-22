# 02 Sessions and runs

## Purpose

A *session* is a native Pi conversation. A *run* is one tracked execution interval of a session:
one turn from a request to an outcome. The harness opens Pi for each run with a pinned account,
a pinned harness tree, a frozen capability set, a compiled prompt and a gated tool list, then
records everything the run does as validated events.

## Components

| Type | Module | Role |
|---|---|---|
| `Sessions` | `sessions/sessions.ts` | Starts a turn: `run(input: SessionRunInput)`, `provide(provider)`. Builds the gate. |
| `runTurn`, `piSessionFactory`, `loadResources` | `sessions/runner.ts` | Opens the Pi session, loads resources in a fixed order, streams events, settles the run. |
| `RunRegistry`, `ActiveRun` | `sessions/registry.ts` | Live runs: `emit`, `requestApproval`, `requestAnswer(s)`, `onInterrupt`, `onSteer`, `finish`; `listen` for observers. |
| run store functions | `sessions/runStore.ts` | `saveRun`, `updateRun`, `persistEvent`, `appendEvent`, `readEvents`, `markInterruptedRuns`, `runFamily`, `listRuns`. |
| `RunRecord`, `RunEvent`, schemas | `sessions/contracts.ts` | The one contract every session shares. |
| `Subagents` | `sessions/subagentService.ts` | `spawn`, `wait`, `results`, delivery receipts, recovery. |
| plan mode | `sessions/planMode.ts` | `planSection`, `planRefusal`, `PLAN_READ_ONLY_TOOLS`. |
| `Approvals` | `sessions/approvals.ts` | Standing approvals (page 07). |
| history selection | `sessions/history.ts` | `selectHistory`: which native history file a run continues. |
| `runIndex`, `pricing`, `reasoningSummaries`, `lineageJoin`, `extensionUi` | `sessions/` | Run listing, cost, provider summaries, parent/child joins, extension UI as run events. |

## Runtime flow of `sessions.run`

1. Validate the input (`run.id`, `sessionId`, `text`; an `initialBashCommand` only on a new
   interactive user turn).
2. Select the native history (`selectHistory`) and resolve the account (`accounts.resolve`).
3. Resolve the caller's capabilities, intersect with any narrower requested set, and **freeze**
   them for the run (`capabilities/runSnapshot.ts::freezeRun`).
4. **Pin** the harness tree once (`tree/materialise.ts::materialise`).
5. `saveRun` with status `queued`, the account, `harnessScope` and `harnessVersion`.
6. Compile the prompt (`sessionLaunch`, page 04): a stable system prompt and an optional context
   update.
7. `runs.start` the live run; build the tool list (broker, harness tools, `ask_user`, subagent
   tools, provider tools) and the gate.
8. Open Pi through the `SessionFactory`, with resources loaded in order: disk extensions chosen by
   the harness, tree extensions, inline extensions, and the gate last.
9. Record `nativeSessionId`, register the run with `Subagents`, start `runTurn`, and return
   `{ runId, nativeSessionId }`. The reply streams as run events.

A session that cannot open ends its run as `failed` and returns `nativeSessionId: null`.

## Contracts

- **Run status:** `queued`, `running`, `waiting_for_approval`, `waiting_for_input`, `interrupted`,
  `completed`, `failed`. The first four are active (`ACTIVE_STATUSES`).
- **Run events** (`runEventTypeSchema`): `started`, `context.snapshot`, `message.delta`,
  `message.completed`, `message.steered`, `tool.started`, `tool.completed`, `retry.started`,
  `retry.ended`, `compaction.started`, `compaction.ended`, `approval.requested`,
  `approval.resolved`, `question.requested`, `question.answered`, `extension.notice`,
  `reaction.added`, `agent.message`, `checklist.updated`, `artifact.added`, `file.changed`, `usage.updated`,
  `account.status`, `status.changed`, `failed`, `completed`. Each has a payload schema in
  `runEventPayloadSchemas`.
- **Checklist** (PROP-0006): `checklist.updated` carries the whole list the model last wrote with
  `checklist_write`, `{ items: { text, status: pending | in_progress | completed }[] }`, at most 50
  items. The latest event replaces every earlier one; `checklistOf(events)` reads it.
- **`RunRecord`** fields are listed in `sessions/contracts.ts`. `mode`, `harness`, `sessionType`,
  `worktreeId`, `attachmentCount`, `exitCode`, `handoffId` and `trigger` belong to the
  application: stored and returned, and only `mode` and `trigger` are read.
- **Triggers the harness reads:** `user` (may carry an initial Bash command), `probe` and
  `improver` (refinement, page 05), `reflection` (lessons, page 08). Runs with the last three are
  never asked about: the gate refuses what would need a person.
- **Subagents.** `spawn_subagent` / `wait_subagents` for the model; `subagents.spawn`, `wait`,
  `results` for the host (`sessions.spawnSubagent` is a compatibility alias). Child runs have
  `relation: 'subagent'` and `parentRunId`. Nesting defaults to 1, at most 3 (`subagentDepth`).
- **Plan mode** (`plan: true`). The tool list is unchanged; the gate refuses everything outside
  `PLAN_READ_ONLY_TOOLS`, provider tools marked `readOnly`, and calls a provider marks
  `planModeSafe`. The plan instruction arrives as a dynamic section; the reply ends with one
  `<proposed_plan>` block.
- **Continuation** (PROP-0007). `continuationOf(root, runId, sessionDir?)` (`runs.continuation`)
  says whether a stopped run can be continued: `resumable`, a `reason` when not (`not_found`,
  `active`, `completed`, `no_history`, `history_missing`), the exact native history to reopen,
  the pinned account, tree version and capability set, the checklist, unanswered approvals and
  questions, the last tool and whether it finished, and subagents that did not finish.
  `SessionRunInput.continueFrom` starts a **new** run from it: it reopens that history, records
  `resumedFromRunId`, pins the same account, tree version and capability set (anything different
  fails with `continuation_mismatch`; a run that cannot be continued fails with
  `continuation_unavailable`), defaults empty text to "Continue from where you stopped.", and adds
  a dynamic `continuation` section (order 26) saying where the earlier run stopped. The next run
  without `continueFrom` withdraws it. `Recovery.interruptedRunIds` lists the runs `open` marked
  interrupted.
- **Usage** (`usage.updated`). `inputTokens` is uncached input; `cacheReadTokens` and
  `cacheWriteTokens` are separate; `outputTokens` includes `reasoningTokens`. Totals are
  cumulative for the run, not the native session. `contextTokens` is the latest request's size.

## Invariants

- **INV-RUN-1** A run pins one account, one harness tree version and one capability set when it
  starts. None of them changes during the run. A pinned account that cannot be used fails the
  run; it is never swapped (`INV-ACC-2`).
- **INV-RUN-2** A run's capability set is written once (`freezeRun`). A resumed or duplicate launch
  with a different set fails with `capabilities_frozen`. A child run's set is the intersection of
  its parent's and what it asked for; it never widens.
- **INV-RUN-3** Every run event is validated against its schema, redacted, persisted, and only then
  relayed to listeners, in order. An event that arrives after the run settled is kept as evidence
  and never applied or relayed.
- **INV-RUN-4** A restarted harness never restarts model work. On `open`, runs left active are
  marked `interrupted` unless another live process owns them (`owner.json`). Recovery of a
  subagent needs the same account, caller, working folder and history branch. Continuing is always
  a new run the application asks for with `continueFrom`; it pins the earlier run's account, tree
  version and capability set, and the earlier run's record is never reopened.
- **INV-RUN-5** Unattended runs (`automatic: true`) load no extension found on disk, read no
  context files, and never ask a person: anything that would need approval is refused. A tree's
  own trusted plugins still load.
- **INV-RUN-6** Only the harness writes `runs/<id>/`; an application reads it. `run.json`,
  `events.jsonl`, `owner.json` and `subagents.json` are written only through
  `sessions/runStore.ts`. Side files are written by their owning module: `context.json`
  (`prompt/compile.ts`), `caller.json` (`sessions/sessions.ts`), `capabilities.json`
  (`capabilities/runSnapshot.ts`), `mcp-context.json` (`mcp/service.ts`). Adding another writer
  or side file needs a proposal. (See drift D-1.)
- **INV-RUN-7** Token accounting follows the usage contract above. Changing what a field means is
  an architecture change.
- **INV-RUN-8** Plan mode never changes the tool list or the system prompt, so switching it keeps
  the cached prefix. Its refusals happen before approvals and no approval can lift them.
- **INV-RUN-9** Subagent results reach the parent at native turn boundaries, at most once
  automatically (typed receipts in native history). A parent joins outstanding children before it
  completes.
- **INV-RUN-10** An initial Bash command is allowed only on a new interactive user turn (not
  automatic, plan, resumed, continuing, relation, probe or improver runs), must match the leading `!` command
  in the text, and passes the same gate as model-issued Bash.

## Data

`<data root>/runs/<id>/`: `run.json`, `events.jsonl`, `owner.json`, `subagents.json`,
`context.json`, `caller.json`, `capabilities.json`, `mcp-context.json`. Native history lives in
the session directory the caller passes (`sessionDir`), owned by Pi.

## Source map

`src/sessions/*.ts`, `src/capabilities/runSnapshot.ts`, `src/tools/spawnSubagent.ts`.
Decisions: [ADR-0002](../decisions/ADR-0002-native-subagent-lifecycle.md) (superseded),
[ADR-0003](../decisions/ADR-0003-shared-asynchronous-subagents.md).
