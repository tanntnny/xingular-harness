# 02 Sessions and runs

## Purpose

A *session* is a native Pi conversation. A *run* is one tracked execution interval of a session:
one turn from a request to an outcome. The harness opens Pi for each run with a pinned account,
a pinned variant, a frozen capability set, a compiled prompt and a gated tool list, then
records everything the run does as validated events.

## Components

| Type | Module | Role |
|---|---|---|
| `Sessions` | `sessions/sessions.ts` | Starts a turn: `run(input: SessionRunInput)`, `provide(provider)`. Builds the gate. |
| `runTurn`, `piSessionFactory`, `loadResources` | `sessions/runner.ts` | Opens the Pi session, loads resources in a fixed order, streams events, settles the run. |
| compaction checkpoint | `sessions/compactionCheckpoint.ts` | Restores the active request's bounded goal, checklist and plan instructions to model context after compaction. |
| `RunRegistry`, `ActiveRun` | `sessions/registry.ts` | Live runs: `emit`, `requestApproval`, `requestAnswer(s)`, `onInterrupt`, `onSteer`, `finish`; `listen` for observers. |
| run store functions | `sessions/runStore.ts` | `saveRun`, `updateRun`, `persistEvent`, `appendEvent`, `readEvents`, `markInterruptedRuns`, `runFamily`, `listRuns`. |
| `RunRecord`, `RunEvent`, schemas | `sessions/contracts.ts` | The one contract every session shares. |
| `Subagents` | `sessions/subagentService.ts` | `spawn`, `wait`, `results`, delivery receipts, recovery. |
| `SideQuestions` | `sessions/sideQuestions.ts` | Starts, reads and interrupts independent tool-free runs using bounded context from the main conversation (PROP-0019). |
| plan mode | `sessions/planMode.ts` | `planSection`, `planRefusal`, `PLAN_READ_ONLY_TOOLS`. |
| `Approvals` | `sessions/approvals.ts` | Standing approvals (page 07). |
| history selection | `sessions/history.ts` | `selectHistory`: which native history file a run continues. |
| `runIndex`, `pricing`, `reasoningSummaries`, `lineageJoin`, `extensionUi` | `sessions/` | Run listing, cost, provider summaries, parent/child joins, extension UI as run events. |

## Runtime flow of `sessions.run`

1. Validate the input (`run.id`, `sessionId`, `text`; an `initialBashCommand` only on a new
   interactive user turn).
2. Resolve a continuation when requested; reuse its pinned root or derive one from its recorded
   working directory. For a new run, resolve and pin the root from the effective `cwd` (after
   worktree selection). Select the native history (`selectHistory`) and resolve the account
   (`accounts.resolve`).
3. Resolve the caller's capabilities, intersect with any narrower requested set, and **freeze**
   them for the run (`capabilities/runSnapshot.ts::freezeRun`).
4. **Pin** the variant once (`variant/materialise.ts::materialise`).
5. `saveRun` with status `queued`, the account, `harnessScope` and `harnessVersion`.
6. Compile the prompt (`sessionLaunch`, page 04): a stable system prompt and an optional context
   update.
7. `runs.start` the live run; build the tool list (broker, Harness tools including read-only
   `get_capabilities`, the plan-eligible `ask_user`, subagent tools, provider tools) and the gate.
8. Open Pi through the `SessionFactory`, with resources loaded in order: disk extensions chosen by
   the harness, variant extensions, inline extensions, and the gate last.
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
- **Workspace root** (`RunRecord.workspaceRoot`) is the canonical root whose filesystem effects
  native writes and default-scope Bash may modify: the nearest Git repository or worktree above its
  effective working directory, otherwise that canonical directory. New runs pin it; continuations
  reuse it. Older records may omit it, in which case a continuation derives it from the recorded
  `workingDirectory`. The filesystem root itself cannot be selected as a workspace, because it
  would collapse the write boundary. Native writes revalidate the target and atomically replace it
  inside an OS write scope; Bash scans for external hard-link aliases and runs in the same pinned
  boundary (page 07).
- **Question sketches** (PROP-0025, ADR-0026; originally PROP-0024, ADR-0025). `question.requested` may include `uiSketch: true`
  and `sketch` text on each choice. If enabled, every choice must have a sketch; otherwise no
  choice may carry one. A sketch is 1–24 LF-separated lines, at most 80 printable ASCII characters
  per line (1,943 bytes maximum), with at least one visible character. Tabs, CR, other controls,
  escape sequences and non-ASCII text are rejected. Whitespace, including interior blank lines and
  trailing spaces, is preserved literally in the persisted request event. Tool guidance requests
  contextual UI wireframes with actual panel/table structure and neighboring elements, consistent
  across alternatives; generation quality is guidance, not a schema guarantee. Old events remain
  valid without a data rewrite; readers with the old bounds must update before accepting larger
  sketches. `question.answered` and `QuestionAnswer` are unchanged.
- **Checklist** (PROP-0006): `checklist.updated` carries the whole list the model last wrote with
  `checklist_write`, `{ items: { text, status: pending | in_progress | completed }[] }`, at most 50
  items. The latest event replaces every earlier one; `checklistOf(events)` reads it.
- **`RunRecord`** fields are listed in `sessions/contracts.ts`. `mode`, `harness`, `sessionType`,
  `worktreeId`, `attachmentCount`, `exitCode`, `handoffId` and `trigger` belong to the
  application: stored and returned, and only `mode` and `trigger` are read.
- **Triggers the harness reads:** `user` (may carry an initial Bash command), `probe` and
  `improver` (refinement, page 05), `reflection` (lessons, page 08). Runs with the last three are
  never asked about: the gate refuses what would need a person, and they receive no question tool.
  Only attended plan runs may newly receive `ask_user`.
- **Side questions** (PROP-0019). `sideQuestions.start` creates a separate run with trigger and
  relation `side-question`, a fresh native history, the selected account/model/effort, no variant,
  and an empty frozen capability set. It combines the parent's persisted effective prompt and
  public run events with the surface's visible transcript and selected references, after redaction
  and fixed bounds. Hidden reasoning and attachment bytes are omitted. A supplied parent run must
  belong to the supplied parent session. `sideQuestions.read` and `interrupt` require the side run's
  session id. The run is not a subagent or continuation and never changes the parent.
- **Subagents.** `spawn_subagent` / `wait_subagents` for the model; `subagents.spawn`, `wait`,
  `results` for the host (`sessions.spawnSubagent` is a compatibility alias). Child runs have
  `relation: 'subagent'` and `parentRunId`. Nesting defaults to 1, at most 3 (`subagentDepth`).
  The child's record carries `title`, the short name the parent gave it (PROP-0030).
- **Agent profiles** (PROP-0029). `agent` names a profile: built-in (`worker`, `explorer`),
  `<data root>/agents/<name>.md`, `<project>/.xingular/agents/<name>.md`, or a c5 definition of
  the parent's variant, later sources winning (`agents/profiles.ts`). A profile narrows the
  child's tools and plugins (`agents/narrow.ts`), may choose its variant, model and effort, and
  frames it with a "Your role" section. The child's record carries `profile`; the spawn result
  carries `agent` and any `unavailableTools`. A run that may spawn lists every profile in its
  `subagents` section.
- **Plan mode** (`plan: true`). The stable system prompt is unchanged. An attended plan run may
  include `ask_user` and `spawn_subagent` / `wait_subagents`, subject to the caller's frozen
  capabilities. Delegation is limited to named profiles whose effective tool and plugin allowlists
  qualify for read-only research; the child inherits plan mode and cannot write, run commands, ask
  the user, use connectors or spawn children. The gate refuses unsafe calls before approvals and the
  subagent service rechecks profile eligibility before launch. Other calls must be in
  `PLAN_READ_ONLY_TOOLS` (including `get_capabilities` when frozen for the run), be provider tools
  marked `readOnly`, or be explicitly classified by `planModeSafe`. Model-issued `bash` is allowed
  and runs in the sandbox's read-only scope: no writes except a discarded temp folder, no network,
  nothing that widens the scope; the gate refuses `outside` requests and `PLAN_BASH_DENIED` commands
  (PROP-0043). The dynamic plan instruction
  requires an opening `Goal` or `Summary`, evidence-grounded findings when useful, and task-scaled
  steps and verification. A small fix stays concise without omitting its
  outcome or check; cross-cutting work uses ordered steps. It uses alternatives only when requested
  or materially useful; contextual `uiSketch` questions clarify real choices.
  The reply ends with one `<proposed_plan>` block.
- **Compaction checkpoint** (PROP-0033, ADR-0032). After compaction, an active run's model context
  receives a bounded, ephemeral checkpoint with the current user request and the latest validated
  checklist or applicable plan instructions, when either is available to restore. It is re-added to
  each request while that run continues;
  its state is cleared when the run settles or the session branch changes. The message changes no
  tools, permissions, run events or native history. An interrupted run still uses the durable
  checklist and normal continuation path.
- **Continuation** (PROP-0007). `continuationOf(root, runId, sessionDir?)` (`runs.continuation`)
  says whether a stopped run can be continued: `resumable`, a `reason` when not (`not_found`,
  `active`, `completed`, `no_history`, `history_missing`), the exact native history to reopen,
  the pinned account, variant version and capability set, the checklist, unanswered approvals and
  questions, the last tool and whether it finished, and subagents that did not finish.
  `SessionRunInput.continueFrom` starts a **new** run from it: it reopens that history, records
  `resumedFromRunId`, pins the same account, variant version and capability set (anything different
  fails with `continuation_mismatch`; a run that cannot be continued fails with
  `continuation_unavailable`). If the earlier snapshot includes `ask_user`, an automatic or
  refinement-triggered continuation fails with `continuation_mismatch` rather than narrowing it.
  Empty text defaults to "Continue from where you stopped.", and the new run adds
  a dynamic `continuation` section (order 26) saying where the earlier run stopped. The next run
  without `continueFrom` withdraws it. `Recovery.interruptedRunIds` lists the runs `open` marked
  interrupted.
- **Worktrees** (PROP-0016). When `run.worktreeId` names a worktree in the Harness registry
  (`worktrees/`), the run works in that worktree's folder (the given `cwd` is replaced), holds a
  lease on it (holder: the session id, with `git worktree lock`) until the run completes, fails or
  is interrupted, and records the id. An id the registry does not know is stored and returned as
  the caller's own field, as before. A terminal session holds its worktree for its whole life.
- **Usage** (`usage.updated`). `inputTokens` is uncached input; `cacheReadTokens` and
  `cacheWriteTokens` are separate; `outputTokens` includes `reasoningTokens`. Totals are
  cumulative for the run, not the native session. `contextTokens` is the latest request's size.
  The derived usage ledger (`usage_requests`, page 08) copies these requests for
  `/usage:analysis`; run events remain the only source of truth.
- **Limit snapshots** (`account.status.limits`). A provider reading carries a window or balance,
  its reset, and its source. It is produced by the usage limits service from provider response
  headers or a documented provider endpoint (page 09), stored in the account's state, and never
  inferred from a made-up cap.
- **Provider reasoning summaries.** For supported Responses API families, when reasoning is
  enabled the runner requests a `detailed` summary and records only the provider's explicit summary
  (bounded to 4,000 characters) in request-level usage. This does not change reasoning effort or
  guarantee a provider will return a summary; raw reasoning is not used as a substitute.

## Session controls and command runs (PROP-0040)

`commands/registry.ts` is the browser-safe core command catalogue, shared by front ends.
`commands.list` combines it with effective plugin, extension, prompt and skill routes (page 10).
A listed route is not proof that its surface passes acceptance.

`sessions/control.ts` owns saved-history operations: tree, navigation without a summary, fork,
clone, rename, last reply and JSONL export. A `SessionRef` names `sessionDir`, optional
`sessionFile` and optional `cwd`; the resolved JSONL must be inside that directory. Navigation
records a `xingular-navigation` entry; choosing a user message returns its text for editing and
moves before it. Fork and clone create history in an absolute `targetDir`.

`SessionRunInput.command` (also `TurnParams.command`) is one of:

- `{ name: 'compact', instructions? }`
- `{ name: 'navigate', entryId, summarize: boolean, instructions? }`
- `{ name: 'export', path }` (absolute `.html` path)

It replaces prompt submission and skips the normal context update. It requires saved history and
cannot combine with plan mode, continuation, automatic execution, initial Bash or images. It uses
normal account/variant/capability pins, events and cancellation. Front ends must fence history
mutations against active work; the current raw saved-history helpers do not themselves establish
that fence. Stable native entry IDs must connect host transcript projection to navigation/fork,
not positional message counts. A host can route `/history` to Harness `sessions.navigate` and
navigate the same saved session; it must not substitute a fork. Shared session catalog registration
is approved but remains in progress; no completed cross-surface catalog is implied (PAR-008).

## Invariants

- **INV-RUN-1** A run pins one account, one variant version, one capability set and one canonical
  `workspaceRoot` when it starts. None changes during the run. A continuation reuses the prior
  root, deriving one from `workingDirectory` only for a legacy record without the field. A pinned
  account that cannot be used fails the run; it is never swapped (`INV-ACC-2`). A side-question
  run is the explicit exception for the variant: it pins no variant and uses the fixed Harness
  instruction plus a redacted main-run context projection (PROP-0019).
- **INV-RUN-2** A run's capability set is written once (`freezeRun`). A resumed or duplicate launch
  with a different set fails with `capabilities_frozen`. A child run's set is the intersection of
  its parent's, its profile's tools and plugins, and what it asked for; it never widens.
- **INV-RUN-3** Every run event is validated against its schema, redacted, persisted, and only then
  relayed to listeners, in order. An event that arrives after the run settled is kept as evidence
  and never applied or relayed.
- **INV-RUN-4** A restarted harness never restarts model work. On `open`, runs left active are
  marked `interrupted` unless another live process owns them (`owner.json`). Recovery of a
  subagent needs the same account, caller, working folder and history branch. Continuing is always
  a new run with `continueFrom`; it pins the earlier run's account, variant version and capability
  set, and the earlier run's record is never reopened. The application asks for it, or the earlier
  run's work-slice policy does when the reply stopped at its budget (PROP-0041); a run started
  without a person (`automatic`), a plan, a subagent, a session command or a worktree never
  continues itself.
- **INV-RUN-5** Unattended runs (`automatic: true`) load no extension found on disk, read no
  context files, and never ask a person: anything that would need approval is refused. A variant's
  own trusted plugins still load, except for side-question runs, which have no variant or plugin
  code and use an empty capability set (PROP-0019).
- **INV-RUN-6** Only the harness writes `runs/<id>/`; an application reads it. `run.json`,
  `events.jsonl`, `owner.json` and `subagents.json` are written only through
  `sessions/runStore.ts`. Side files are written by their owning module: `context.json`
  (`prompt/compile.ts`), `caller.json` (`sessions/sessions.ts`), `capabilities.json`
  (`capabilities/runSnapshot.ts`), `mcp-context.json` (`mcp/service.ts`). Adding another writer
  or side file needs a proposal. (See drift D-1.)
- **INV-RUN-7** Token accounting follows the usage contract above. Changing what a field means is
  an architecture change.
- **INV-RUN-8** Plan mode keeps the stable system prompt but has mode-specific tools: an attended
  plan may include `ask_user`, `spawn_subagent` and `wait_subagents`, subject to the frozen caller
  capabilities; newly resolved normal, automatic, probe, improver and reflection runs omit
  `ask_user`. Plan-mode spawning requires a named profile whose effective explicit tool and plugin
  allowlists qualify for read-only research. The child inherits plan mode and is narrowed to the
  intersection of the parent's frozen capabilities, the profile and the plan research set; it has no
  connectors, user questions, writes, commands or nested subagents. The plan run itself may run
  Bash only in the OS-enforced read-only scope (PROP-0043, ADR-0038). The gate refuses unsafe calls
  before approvals, and the service rechecks before launch. The terminal activates plan-eligible
  tools only for a plan request, then restores its normal set. Provider-cache effects of the tool-list
  difference are not assumed (page 04, `INV-PRM-8`).
- **INV-RUN-9** Subagent results reach the parent at native turn boundaries, at most once
  automatically (typed receipts in native history). A parent joins outstanding children before it
  completes.
- **INV-RUN-10** An initial Bash command is allowed only on a new interactive user turn (not
  automatic, plan, resumed, continuing, relation, probe or improver runs), must match the leading `!`
  command in the text, and passes the same gate as model-issued Bash. It is workspace-scoped by
  default; the explicit terminal syntax `!outside <command>` requests the same human-only,
  pre-execution outside-scope approval as the Bash tool and runs the command at most once.
- **INV-RUN-11** A side-question run is independent, tool-free and temporary. It receives only a
  bounded, redacted projection of the main run's effective prompt and public events plus the
  surface's visible transcript and selected references. It excludes hidden reasoning and attachment
  bytes, never reads the main native history, and never changes or steers the parent. Its own run
  record and events use the normal store contract (PROP-0019).
- **INV-RUN-13** A reply is a bounded work slice (PROP-0041). The foundation defaults are 160 tool
  calls, 40 minutes and 320 000 new tokens, whichever comes first. The token count covers new input,
  cache writes and output, never the cached prefix: a few large reads pass any small cap before
  useful work, so the cap is a safety net, not the bound. At the limit the guard ends the slice and
  refuses the next tool call with a request for `checkpoint_write`; a handoff call is never refused,
  including when it is the first call past the limit, and another tool ends the reply. A reply that ends this way is `interrupted` with terminal reason `slice_complete`, and one
  the stall guard ends is `stalled`. The stall guard identifies a call by its name and every
  argument, names a repeated call once and ends the reply on the next repeat, and counts afresh in
  each reply, so a checklist a reply rewrites as its steps complete is not a repeat. A new run
  continues it only up to the policy's slice cap, only
  after a slice that changed a file, passed a check or recorded a finished item, and never after a
  checkpoint that is `blocked`. A run may turn the guard off with `workSlice.enabled: false`, and a
  launch may set `XINGULAR_WORK_SLICE=off` for every run in that process; with it off a reply has no
  boundary — no checkpoint, no continuation, no stall notes — and ends only when the model stops or a
  person interrupts.
- **INV-RUN-14** A run event stream carries `checkpoint` (the handoff `checkpoint_write` records or
  the harness derives from the run's own evidence when the model wrote none) and `heartbeat`
  (steps, elapsed time, last tool, compactions, slice, and the call budget). A heartbeat older than
  five minutes while the owner process lives marks the run `interrupted` with reason `stalled`; a
  run that never emitted one keeps the 30-minute silence rule. The watchdog never restarts work.
- **INV-RUN-12** A post-compaction checkpoint is a bounded context projection of the active request,
  the latest validated checklist and applicable plan instructions. It is compiled by
  `prompt/compile.ts`, supplied only to model requests in the active run, and never persists hidden
  reasoning or changes permissions, stable prompt text, native history or run-event schemas. Its
  in-memory state is cleared when the run settles or the active session branch changes
  (PROP-0033, ADR-0032).

## Data

`<data root>/runs/<id>/`: `run.json` (including the optional, legacy-compatible `workspaceRoot`),
`events.jsonl`, `owner.json`, `subagents.json`, `context.json`, `caller.json`, `capabilities.json`,
`mcp-context.json`. Native history lives in
the session directory the caller passes (`sessionDir`), owned by Pi. Side-question native history
uses a one-use OS temporary directory, removed when the run settles; its tracked run and events
remain in the ordinary run store.

## Source map

`src/sessions/*.ts`, `src/capabilities/runSnapshot.ts`, `src/core/workspaceBashTool.ts`,
`src/core/workspaceSandbox.ts`, `src/core/workspaceWriteOperations.ts`, `src/tools/spawnSubagent.ts`.
Decisions: [ADR-0002](../decisions/ADR-0002-native-subagent-lifecycle.md) (superseded),
[ADR-0003](../decisions/ADR-0003-shared-asynchronous-subagents.md),
[ADR-0022](../decisions/ADR-0022-plan-only-question-tools.md),
[ADR-0023](../decisions/ADR-0023-contextual-side-question-runs.md),
[ADR-0026](../decisions/ADR-0026-contextual-question-wireframes.md),
[ADR-0033](../decisions/ADR-0033-plan-mode-research-delegation.md).

## Native session names (PROP-0010)

`session_name({ name: string })` adds or revises the current Pi session's name in embedded
and terminal execution. The agent names meaningful work early and revises it when the overall
objective changes, including a manual name. Agent-submitted names are imperative sentences
of at most six whitespace-separated words; whitespace is normalized, and empty names,
terminal escapes, non-whitespace controls and longer names fail without writing. Identical
names are a no-op. Pi's native session-info history is the only storage; continuation and
reopen preserve it. Each child names only itself. There is no additional model request or
run-event schema. The normal capability selection and host gate apply; `harnessTools: false`
omits the tool. Plan mode permits it as session metadata maintenance.
