---
id: ADR-0069
title: A stop gate and a finish tool; the model's checkpoint tool is removed
status: accepted
created: 2026-10-31
updated: 2026-10-31
supersedes: partial — PROP-0041 (the model-written checkpoint), ADR-0068 (when the completion heading applies), ADR-0063 (scope of the unfinished-work guidance)
related:
  - STUDY-0004
  - ADR-0068
---
# ADR-0069 — A stop gate and a finish tool; the model's checkpoint tool is removed

> **Amended by [ADR-0071](ADR-0071-completion-check.md):** `finish` is removed; a completion check (the run's own model, fresh context) now decides `continue` / `needs_person` / `done` when a reply that did work ends with its list closed.

## Context

A reply the model ended on its own settled `completed` (`sessions/runner.ts`), and only a
guard-ended slice auto-continued (`continueSlice`: `terminalReason === 'slice_complete'`). Nothing
read the todo list when a reply ended.

- **Scale.** 207 of 822 runs in the week to 2026-10-30 ended with work left, at a median of 17 tool
  calls; 81 left open todos (`outputs/diagnoses/2026-10-30-sweep.md`).
- **Worst case.** One terminal session, "Complete platform and API handoff", stopped three times in
  a row with an open todo, at 23, 65 and 94 of 320 tool calls, after being told "dont stop". Its own
  answer in between: "I stopped prematurely… the unfinished work was not all blocked by approval
  gates."
- **Prompt fixes did not reach it.** ADR-0068's wording was in `src/` but not in `dist/`, and a live
  terminal session keeps the pack and the extension code it started with.

**Hypothesis: the harness's own exit ramps make stopping easier.** Several texts made a polished,
incomplete stop a first-class outcome, with nothing pushing back:

- `checkpoint_write`, whose description said to call it "before you stop on purpose";
- `TODO_GUIDANCE`'s "before your final reply… leave unfinished or blocked steps accurate";
- ADR-0063's unfinished-handoff guidance;
- ADR-0068's `## What would make this complete`, "when the run could be more complete".

**What the run records show:**

- `checkpoint_write` was rarely called: 3 calls in 41 eligible top-level code runs.
- In run `62c7fc6c` the model wrote a checkpoint on its own ("the handoff remains incomplete…
  continue remaining implementation", nothing `blocked`), made zero further tool calls, and ended.
  It used the checkpoint as a sign-off.
- Runs that ended with open todos rose from 8% (146 runs before the tool existed) to 42% (19 after).
  The second sample is small and mostly huge handoffs, so this is a signal, not proof. Stopping
  early predates the tool.

Other harnesses enforce the end of a turn rather than describe it (STUDY-0004):

| Harness | Mechanism |
|---|---|
| Claude Code, Codex | `Stop` hook with `decision: block` and a reason |
| Cursor | `followup_message` with a loop limit |
| Amp | `agent.end → continue` |
| Ralph loop | A stop hook with a completion promise and an iteration cap |
| Gemini CLI | `complete_task` is "the ONLY way to finish" |
| Cline | `attempt_completion` with a double check |

## Decision

1. **Stop gate.** An extension at Pi's `agent_before_settle` boundary (`sessions/stopGate.ts`) runs
   in every attended top-level run, structured and terminal. It is off in plan, command, automatic,
   subagent and other related runs.
   - When the reply's own `todo_write` list holds an open item and nothing was declared with
     `finish`, it appends a displayed `xingular-stop-gate` message naming the open items and
     continues the same run.
   - It nudges at most three times per reply, and never again after a nudge that produced no tool
     call other than `todo_write` or `finish`.
   - It is silent for a reply with no todo list or a complete one, an aborted or failed reply, a
     slice the guard ended, or a continuation another handler already requested.
   - Each nudge is an `extension.notice` from `stop-gate`.
   - It is deterministic: it reads the todo list and the declaration, never a model judgment.
2. **`finish`.** This is the one explicit way to stop with work open (`tools/finish.ts`):
   - `blocked` or `needs_decision` with a reason, plus an optional `needs`;
   - `done` is refused while any item is open;
   - read-only and plan-safe.
3. **Honest stop codes.** A reply that settles with open items is `interrupted`, never `completed`:
   - `needs_person` after a `finish` declaration;
   - otherwise `unfinished`.
   The runner (or the terminal extension) writes its checkpoint from evidence: done and next from the
   todo list, blocked from the declaration, files and checks from the reply. Neither auto-continues;
   the person continues the run. (A terminal reply that ended at its work-slice budget, not one of
   these, continues in place since ADR-0070.)
4. **No model-written checkpoint.** `checkpoint_write` is removed. At a work-slice budget the guard
   asks the model to stop and report, and the harness writes the checkpoint. A capability set pinned
   before the removal gets `finish` in its place.
5. **One budget per reply.** The work-slice guard and the gate reset only on a person's message
   (`before_agent_start` with `messageType: 'user'`). Pi emits `agent_start` for every continuation,
   so resetting there gave every nudge, delivered subagent result or plan repair a fresh 320-call
   budget.
6. **Exit ramps rewritten.**
   - `role` names the only reasons to stop, and the gate.
   - `TODO_GUIDANCE` asks for a list that is true at all times.
   - `## What would make this complete` applies only when the work stopped short (blocked, needing
     the person, or handed back by the guard), "never stop early in order to write this section".
   - The `Progress` group explains the gate and `finish`.
   - The terminal's launch tools now include `finish`, so its prompt says so.
7. **Subagent tool mismatch is visible.** `spawn_subagent` returns the child's effective `tools`, and
   the read-only profiles say in their first line when a brief needs a tool they lack.

## Consequences

- A reply with open todos costs up to three more model requests before it is handed back. A reply
  without a todo list costs nothing extra.
- A model can still stop with work open, but only by naming a blocker (`needs_person`) or by
  exhausting the gate (`unfinished`). Both are visible in the record and offer Continue.
- Hosts must accept the two new stop codes (`10-server-protocol.md`). The external App needs a
  release that shows Continue for them.
- The stable prefix changes once (`role`, `TODO_GUIDANCE`, `reporting`, `Progress`). Measured with
  real requests only, under INV-PRM-8.
- A live terminal session keeps the code and pack it started with. The gate reaches it only after a
  rebuild and a restart.
- **Measure:**
  - the share of runs that end with open todos (baseline 81 of 207 `model_behaviour` runs);
  - nudges per run (expected mostly 0–1; more than 3 in a row means the gate's test is wrong);
  - the `unfinished` and `needs_person` rates.

## Alternatives considered

- **Widen `continueSlice` to `completed` runs with open todos** (STUDY-0004 option 2). Rejected for
  the first layer: it starts a new run per continuation, needs `continuationOf` to reopen a
  completed run, and does not cover the terminal, where the failing session ran. The gate keeps one
  run and works on both surfaces.
- **Keep `checkpoint_write` and reword it.** Rejected: any always-available "record where you
  stopped" tool is a sign-off. The harness already derives a better record from evidence.
- **A model-judged goal evaluator** (Claude Code `/goal`). Rejected, as in STUDY-0004: it adds a
  model call per reply and judges only what the transcript shows.
- **Prompt only** (ADR-0068 as it stood). Rejected: the record shows the wording does not hold under
  long tasks, and it cannot reach a live session.
