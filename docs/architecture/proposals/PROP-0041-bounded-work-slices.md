---
id: PROP-0041
title: Bounded work slices, a durable checkpoint, and a stall guard for long replies
status: Implemented; terminal card, App presentation and /slices open
created: 2026-10-26
updated: 2026-10-26
affects: [INV-RUN-2, INV-RUN-3, INV-RUN-4, INV-RUN-12, INV-PRM-1, INV-PRM-2, INV-PRM-4, INV-PRM-5, INV-PRM-10, INV-GATE-2, INV-STO-3, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 04-prompt.md, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity.md]
---

# PROP-0041: Bounded work slices, a durable checkpoint, and a stall guard

> **Amended by [ADR-0069](../../decisions/ADR-0069-stop-gate-and-finish.md):** the model no longer writes the checkpoint — `checkpoint_write` is removed and the harness writes it from the reply's evidence; the slice budget now covers the whole reply, including Pi's own continuations.

## Problem

A single reply can run for hours. Two measured sessions (STUDY-0003) ran 114 and 75 minutes in
**one** reply: 448 and 274 tool calls, 5 and 2 context compactions at ~256k tokens, 42 repeated
identical calls, and 41 minutes in three Playwright runs — 25 of them on two timeouts. The first had
addressed the person with **no text at all** at 114 minutes when it was measured, and was still
going; the second produced a single 2 028-character report at minute 74.9, and it said the release
was still blocked.

Nothing in the foundation bounds a reply. The only limiter is the opt-in `budget-guard` plugin
(`src/plugins/firstParty.ts:31,105-140`), which is off by default and, when on, refuses tools and
terminates the reply with no handoff. The post-compaction checkpoint (PROP-0033) restores only the
goal and the checklist, returns `null` when no checklist was written (`src/prompt/compile.ts:196`),
and carries no files, failing commands or decisions. Bash has no default timeout
(`src/core/workspaceBashTool.ts:23`). There is no stall detection, no heartbeat, and dead-owner runs
are only reconciled at startup (`src/sessions/runStore.ts:228`).

The result is not a loop on one action; it is a reply with no boundary. Nothing the model learns
becomes a checkpoint, a commit or a message, so the person cannot steer, review or stop it, and the
model re-derives state by re-reading files after every compaction.

Task and goal lifecycle stay in the application (`docs/study/feature-gap-review.md:7,35`). Every
mechanism below is **run execution**, which the harness owns.

## Affected rules

- **INV-RUN-4** currently says continuing is "always a new run the application asks for". A slice
  policy asks on the run's behalf. This proposal amends the asker, not the rule: continuation remains
  a new run with the earlier run's pins, and the earlier record is never reopened.
- **INV-RUN-12 / INV-PRM-10** define the post-compaction checkpoint as goal + checklist + plan. The
  checkpoint becomes a bounded ledger assembled by the compiler and used at both compaction and slice
  boundaries. It stays ephemeral, bounded, and free of hidden reasoning.
- **INV-RUN-3** every event is validated before it is persisted or relayed; the new `checkpoint`,
  `progress` and `heartbeat` events follow the same path.
- **INV-RUN-2 / INV-PRM-5** a new foundation tool (`checkpoint_write`) joins the frozen capability
  set and the compiled tool manifest. Runs pin it; nothing widens after launch.
- **INV-GATE-2** the gate stays the last extension. The loop guard is a foundation extension loaded
  before it, like the compaction checkpoint.
- **INV-PRM-1/2/4** all checkpoint and guard text is assembled in `src/prompt/compile.ts`; the
  stable system prompt does not change.
- **INV-STO-3** no new file or folder: checkpoints are run events in `events.jsonl`.
- **INV-PAR-1/2** the budget, checkpoint card, stall report and `/slices` control exist in the
  terminal and are presented by the App; `parity.md` gains a row.

## Proposal

### 1. A reply budget, enforced at the tool boundary

A foundation policy, on by default for every run (interactive, automatic, plan, probe, subagent):

- `workSlice.enabled` true; `workSlice.maxToolCalls` 320, `workSlice.maxMinutes` 60,
  `workSlice.maxNewTokens` 0, so no token cap by default (the values were raised by PROP-0044).
  `enabled: false`, or `XINGULAR_WORK_SLICE=off` at launch,
  removes the guard from a run: no budget, no stall notes, no continuation. Any
  limit reached, or `0` to disable that one, ends the slice. A token cap counts new input, cache
  writes and output; counting the cached prefix made one large read end a reply before any work
  (measured on the "Confirm plan model support" thread: 76 807 counted tokens after four requests).
- Counted by the runner from observed events: tool calls started, wall clock since the run started,
  and the sum of `inputTokens + cacheReadTokens + outputTokens` per request.
- Enforcement is a Pi `tool_call` hook, like `budget-guard`, but the exit is a checkpoint, not a
  silent stop: the next tool call is refused once with a reason that names the spent budget and
  instructs the model to call `checkpoint_write`; that tool (and `session_name`) remain callable.
  After a valid checkpoint, the model gets one request to write the person-facing progress line, and
  the run settles with terminal reason `slice_complete`.
- A reply that finishes inside its budget is unaffected at runtime: no extra request and no extra
  context. The only global cost is the new tool entry in the compiled manifest (Consequences).

### 2. `checkpoint_write`: a bounded, evidence-linked ledger

A foundation tool, always present beside `checklist_write`:

```
checkpoint_write {
  summary: string            // ≤ 1 200 chars, what the person should know now
  done: [{ item, evidence[] }]    // ≤ 20; evidence is a path, a check command, or a decision
  next: string               // the single next step
  blocked?: string           // what stops progress, if anything
  files: [{ path, why }]     // ≤ 20
  checks: [{ command, ok, detail }]  // ≤ 8; detail holds the failing line, ≤ 300 chars
  decisions: [{ what, why }] // ≤ 8
}
```

- The harness validates shape and bounds, then records one `checkpoint` run event (bounded 8 000
  chars). The latest checkpoint is the run's resumable state; `runs.continuation` returns it next to
  the checklist.
- Evidence is checked against the run's own events since the previous checkpoint. A `done` item whose
  evidence was not observed is kept but marked `unverified` in the record and told to the model; the
  tool never refuses a checkpoint, because a checkpoint is better than a stall.
- The prompt section that asks for a checkpoint is compiled, bounded, and states that the ledger is
  read by the next slice, not shown as a plan.

### 3. Continuation from the checkpoint

- `continueFrom` already starts a new run with the earlier run's pins. A slice policy may perform
  that continuation without an application request when the account's setting is on: same session,
  same account, variant and capability set, `resumedFromRunId` set, earlier record untouched.
- The new run's context begins with the compiled checkpoint (goal, ledger, plan instructions), so the
  model resumes from state rather than from a summary. The normal PROP-0033 checkpoint continues to
  cover mid-slice compactions.
- Both surfaces offer the same control: `/slices on|off` in the terminal, the matching setting in the
  App, and a per-run override on `sessions.run` (`workSlice: { maxToolCalls?, maxMinutes?, maxNewTokens?, continue? }`).
- Off means the run still stops at the budget, writes the checkpoint, and returns to the person with
  a "continue" affordance. Slices are a convenience; the checkpoint is the contract.

### 4. Stall guard

A foundation extension (`src/sessions/workSlice.ts`), registered where the compaction checkpoint is:

- Signatures are `toolName + canonicalised args`, hashed, so every argument participates and a
  changed argument (a checklist whose steps moved on, a different path) is a different call. Detect,
  per reply:
  - the same signature 3 times (`checkpoint_write` and `session_name` are handoff calls when a
    checkpoint is available; `todo_write`, `wait_subagents` and `subagents.*` polling are exempt);
  - the same Bash check failing twice;
  - four successful native `edit`/`write` results on one path without an intervening passing check;
    the next edit attempt is refused, and a further trigger ends the slice;
  - context-compaction thrash at the third compaction.
- Only a `tool_result` with `isError === false` and a path counts as a successful edit or write. A
  failed or blocked attempt consumes no edit-churn allowance. A successful edit/write clears failed
  check counts, exact-repeat counts for Bash check calls, and the pending nudge so that a fixed check
  may run against changed code. It leaves per-file edit counts and exact-repeat counts for other
  calls intact. A passing check clears edit churn and the reply's repetition state.
- There is no general 25-call file-change/check no-progress trigger. The work-slice call/time budget
  and the targeted repeated-call, repeated-failing-check, edit-churn and compaction-thrash protections
  remain. `todo_write` is excluded from repeated-call detection and does not reset loop state, but it
  remains subject to the tool-call budget. Counts and the nudge start fresh in each reply, because
  each reply is one slice.
- With `checkpoint_write`, the first targeted trigger is refused with a bounded nudge; repeating the
  trigger ends the reply as `stalled` and the runner derives a checkpoint when the model wrote none.
  A plan-research child keeps its frozen read-only capability set even though it lacks
  `checkpoint_write`: it receives the same configured work-slice bound, is told to stop and return a
  concise partial research report on its first budget or stall refusal, and a further tool call ends
  the reply. The runner records an evidence-derived checkpoint; the child is not auto-continued and
  receives no additional tool or connector permission.

### 5. Command budget

- `workspaceBashTool` gains a default `timeout` of 120 s and a hard ceiling of 300 s. A longer call is
  allowed only with an explicit `reason`, is shown in the approval action, and is capped at 900 s.
- A timed-out command returns its partial output plus "timed out after Ns; narrow the command (one
  test file, `--grep`, a line range)". After two timeouts in a run, the guard's evidence note asks for
  the narrow run first.
- Browser suites and full CI are run as background work where the surface supports it; the slice
  budget must not be spent blocking on them.

### 6. Compaction discipline

- Before Pi compacts, drop the oldest tool results beyond a character budget through the existing
  `context` projection (the mechanism PROP-0033 already uses), keeping every path and command line.
  This is the cheapest lever and the one these runs lacked with `output-trim` off.
- Count compactions per run. At the third, do not compact again: force a checkpoint and end the slice,
  naming the largest tool results as the cause (Claude Code's documented thrash guard).
- Where Pi exposes its summariser prompt, the foundation sets the same requirements the checkpoint
  has: paths with line ranges, failing command lines, and decisions survive.

### 7. Liveness and progress

- One new run event while a reply is active: `heartbeat` every 30 s `{ steps, elapsedMs, lastTool,
  compactions, slice, maxToolCalls }`, relayed to every surface. `message.completed` already carries
  every visible assistant text block, so no separate `progress` event is added (implemented this
  way; the second copy bought nothing).
- A stall watchdog settles what the process table cannot. The store reconciles on activity as well as
  on the owner pid, and periodically rather than only at startup: no heartbeat for five minutes while
  the host is alive marks the run `stalled` (a long command still heartbeats, so a 16-minute build is
  not mistaken for a hang), and a `running` or `waiting_*` run whose owner process is gone becomes
  `interrupted` with `terminalReason: "owner_gone"`. Model work is never restarted (INV-RUN-4).
- `owner.json` records a process start marker next to the pid, so a recycled pid cannot make a dead
  owner look alive.

### 8. Defaults and the existing plugin

- The slice policy, checkpoint tool, stall guard and heartbeat are foundation and on by default. The
  `budget-guard` plugin stays for people who want a different cap; the Slice policy supersedes it, and
  the plugin's page says so.
- Until this lands, the quickest real relief is configuration: `output-trim` on (20 000 chars) and
  `budget-guard` at 120 requests.

## Alternatives

- **Turn `budget-guard` on by default.** Rejected: it stops the reply with no state and no handoff,
  which converts a long run into a lost run.
- **Raise the context window or compact more often.** Rejected: latency and context rot both grow with
  input; the two runs compacted five and two times and still re-read `host.rs` 11 times.
- **Extend `checklist_write` instead of a new tool.** Rejected: the checklist is the person-visible
  plan and is reworded as scope changes; the checkpoint is execution state with evidence. Mixing them
  is what produced five reworded plans in one run.
- **Let the App drive continuation.** Rejected: that is orchestration in the wrong layer, and the
  terminal would lose parity (`INV-PAR-1`).
- **Add a task/goal lifecycle.** Rejected here: it belongs to the application
  (`feature-gap-review.md:7,35`) and is not needed to bound a reply.

## Consequences

- More runs per long task, each with its own record and pins. Continuation already supports this, so
  session and thread views group them; a person sees a checkpoint every ≤ 60 minutes instead of
  nothing.
- Two new tools/events and two new settings, which the App must present for parity. The compiled tool
  manifest gains one entry, which changes the provider-cache prefix once (INV-PRM-8: measure with real
  requests, with the owner's permission).
- A model can be stopped mid-slice. It is stopped with its own written state and a person-facing line,
  never silently.
- The context stops growing to 256k in a single reply, so per-step latency and compaction cost fall;
  the exact gain is to be measured, not assumed.

## Migration

No format migration. Existing runs and native histories are readable; runs without a checkpoint
continue to resume from the checklist. `terminalReason` gains `slice_complete`, `owner_gone` and
`stalled`; readers that switch on unknown reasons keep their default. Record validators accept the
new event types; older records stay valid. The App's event schemas accept the new types in the same
change (its sidecar test parses every reply of this package).

## Checks

- Unit: budget counting and refusal, checkpoint validation and bounds, evidence marking, continuation
  pins and `resumedFromRunId`, stall signatures and exemptions, Bash ceiling and partial output,
  heartbeat cadence, owner-gone reconciliation, event validators.
- Integration: a fake Pi session that makes 60 tool calls ends in one `checkpoint` event and a
  `slice_complete` run, and the continuation starts with the rendered checkpoint; a duplicated call
  is blocked once and then ends the slice; a dead owner is reconciled while the process is alive.
- `npm run typecheck`, `npm test`, `npm run prove` here; the App's `npm run typecheck`, `npm test`,
  `npm run check:layers`, `npm run check:ui` and `cargo test`; then compare the STUDY-0003 metrics on
  the same two tasks with real runs.

## Implementation status (2026-10-26)

Implemented in this tree:

- `checkpoint_write` (`src/tools/checkpoint.ts`) with its plugin descriptor, frozen capability entry,
  prompt group and terminal socket bridge; the run records `checkpoint`.
- The slice guard (`src/sessions/workSlice.ts`): budget refusal, checkpoint-aware handoff, targeted
  repeated-call and repeated-failure notes, success-only edit churn with progress-aware check retry
  resets, compaction-thrash guard, and per-reply reset. The broad file/check no-progress trigger is
  removed; plan-research children without `checkpoint_write` use the derived-checkpoint handoff and
  the same configured bounds without gaining tools. Wired for structured and terminal replies.
- The runner's `heartbeat`, derived fallback checkpoint, `slice_complete`/`stalled` terminal reasons
  and the third `finish` argument.
- Auto-continue with `maxSlices` 8, a fruitless-slice stop and a blocked stop, off for automatic,
  plan, subagent, command and worktree runs; the continuation renders the checkpoint.
- The command budget (120/300/900 s) on the Bash tool and both initial `!` paths.
- The liveness watchdog (`reconcileStaleRuns`, 60 s timer) with heartbeat-age and legacy silence
  rules.

Open, tracked as `PAR-004` in [`docs/parity.md`](../../parity.md): the terminal's checkpoint card,
`/slices`, and the App's event schemas, checkpoint card and slice line. Rerun of the STUDY-0003
tasks with real requests is still to be done with the account owner's permission.
