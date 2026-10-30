---
id: STUDY-0004
title: How other harnesses stop a turn early — and what to adopt
status: adopted-with-changes
created: 2026-10-30
updated: 2026-10-31
related:
  - STUDY-0003
---
# How other harnesses control the end of a turn

> **Update (2026-10-31, [ADR-0071](../decisions/ADR-0071-completion-check.md)):** the model-judged evaluator rejected above was adopted after all, as an automatic completion check on the run's own model, because a live A/B showed a closed todo list hiding unfinished work and `finish(needs_decision)` used as an early exit; `finish` is removed.

> **Outcome (2026-10-31):** adopted with changes in [ADR-0069](../decisions/ADR-0069-stop-gate-and-finish.md).
> - **Gate placement.** The continuation is a stop gate at Pi's `agent_before_settle` boundary
>   inside the same run, not a widened `continueSlice`. That covers the terminal and avoids
>   reopening a `completed` run.
> - **Cap.** Three nudges per reply, plus a no-progress rule.
> - **`finish` tool.** Added as the explicit way to stop for the person.
> - **`checkpoint_write` removed.** Run `62c7fc6c` used it as a sign-off and stopped with work open.

**Recommendation:** keep the prompt rules that landed today (scope of the work, the end rule, two
completion headings) as the cheap layer, and add **one** deterministic layer: let the existing
work-slice policy continue a reply that ended by itself while the run's todo list still holds an
open, unblocked item — the same machinery that already continues a budget-ended slice, with a cap
and the same guards. Do not adopt a model-judged evaluator, and do not adopt unconditional
"keep going" loops.

This note is analysis. It changes no contract; the prompt change it refers to is recorded in
[ADR-0068](../decisions/ADR-0068-scope-and-completion-report.md) and
[04-prompt.md](../architecture/04-prompt.md#when-a-reply-may-end).

## Why this note exists

207 of 822 runs in the week to 2026-10-30 ended with work left, at a median of 17 tool calls, and 191
of those wrote no checkpoint. The clearest case, `d73804c8`, ended at 63 of 320 tool calls with
B3–B10 of a handoff untouched and no approval, question, refusal or compaction in the record
(`outputs/diagnoses/2026-10-30-d73804c8.md`). The prompt was the first lever; this note asks what
harnesses with more users do about the same failure.

## What Xingular does today (verified in this repository)

| Mechanism | Where | What it can do |
|---|---|---|
| Work-slice guard | `src/sessions/workSlice.ts:40` (320 calls / 60 min / 8 slices), refusal path and derived checkpoint in `src/sessions/runner.ts:710` | Ends a reply at the budget and records `interrupted{slice_complete}` |
| Slice continuation | `src/sessions/sessions.ts:410` `continueSlice` | Starts the next slice as a new run — but only when `terminalReason === 'slice_complete'`, the slice progressed, no checkpoint is `blocked`, and it is not automatic, plan, command or a worktree run |
| Continuation by request | `src/sessions/continuation.ts:60`, `continueFrom`, `runs.continuation`; `CONTINUE_TEXT` = "Continue from where you stopped." (`src/sessions/sessions.ts:157`) | The host or a subagent's parent can reopen a stopped run with its pinned account, variant and capability set |
| Plan repair | `src/sessions/runner.ts:702` (`PLAN_REPAIR_INSTRUCTIONS`, `triggerTurn: true`) | Re-asks once for a missing plan block |
| Human affordance | App `src/app/AppState.tsx:353` (notice only for `interruptedRuns`), `Continue` on a paused reply | The person resumes; the app never continues by itself |

The gap is exact: a reply the model ends by itself settles `run.finish('completed')`
(`src/sessions/runner.ts:718`) and `continueSlice` returns at its first check
(`terminalReason !== 'slice_complete'`). So the layer that already exists never fires for the
failure mode that dominates the record. `INV-RUN-4` allows this: continuing is always a new run with
`continueFrom`, asked by the application **or the work-slice policy** (`INV-RUN-13`).

## What other harnesses do (live documentation, read 2026-10-30)

| Harness | Mechanism (exact name) | Trigger | What it can force | Source |
|---|---|---|---|---|
| Claude Code | `Stop` / `SubagentStop` hook returning `decision: "block"` with a required `reason`; `hookSpecificOutput.additionalContext` | "Runs when the main Claude Code agent has finished responding" | Keeps the model working; the `reason` is fed back | <https://code.claude.com/docs/en/hooks> |
| Claude Code | `/goal` — a separate small-model evaluator | Each reply end | Judges whether the goal is met; stops when there is no tool use "for several turns in a row" | <https://code.claude.com/docs/en/goal> |
| OpenAI Codex CLI | `Stop` hook, `{"decision":"block","reason":…}` or exit code 2 | Turn stop; input carries `stop_hook_active`, `last_assistant_message` | "tells Codex to continue and automatically creates a new continuation prompt" | <https://learn.chatgpt.com/docs/hooks> |
| Cursor | `stop` hook output `followup_message`; input `loop_count`; `loop_limit` (default 5, `null` = uncapped) | "Called when the agent loop ends" | Submits the message as the next user turn | <https://cursor.com/docs/hooks> |
| Amp | Plugin hook `agent.end` returning `{ action: 'continue', userMessage }` | End of a turn | Starts another turn | <https://ampcode.com/docs/plugin-api> |
| Cline | Completion tool `submit_and_exit`; plugin hooks can only end a run | Model calls the tool | Nothing — a text-only reply ends the turn | <https://docs.cline.bot/tools-reference/all-cline-tools.md> |
| OpenHands | `finish` tool (`FinishAction`) | Model calls `finish` | Nothing; its description permits finishing when "you cannot proceed further due to technical limitations" | <https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/tool/builtins/finish.py> |
| Gemini CLI | `complete_task` tool (`CompleteTaskTool`) | Model calls it | Nothing, but the strictest completion wording found: "This is the ONLY way to finish" | <https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/complete-task.ts> |
| Aider | `--auto-lint` / `--auto-test` / `/test` | Non-zero exit of the lint/test command after an edit | Re-prompts until the command passes — failure-driven, not confession-driven | <https://aider.chat/docs/usage/lint-test.html> |
| Goose | unconfirmed — `final_output` not located in two fetches | — | — | — |
| OpenCode | No stop hook; `session.idle` is an observational event | — | Nothing | <https://opencode.ai/docs/plugins/> |

## Failure modes these documents themselves record

- **Runaway refusal.** Claude Code "overrides a Stop hook after it blocks eight times in a row with no
  tool call"; a hook must check `stop_hook_active` or it "block[s] on a condition that will never
  resolve". <https://code.claude.com/docs/en/hooks-guide>
- **Per-reply cost.** "`Stop` hooks fire whenever Claude finishes responding, not only at task
  completion" — a verification hook runs on every reply, trivial ones included.
  <https://code.claude.com/docs/en/hooks-guide>
- **A judge cannot act.** `/goal`'s evaluator "does not call tools, so it can only judge what Claude
  has already surfaced".
- **Uncapped loops are a switch, not an accident.** Cursor exposes `loop_limit: null`.
- **Conflicting controls.** Codex: "If any matching `Stop` hook returns `continue: false`, that takes
  precedence over continuation decisions."
- **Completion tools do not check the world.** OpenHands `finish` and Gemini `complete_task` validate
  only that the final message is non-empty; a model that declares done is believed. (Inference from
  both sources — no harness documents a done-ness check at the tool boundary.)

## What to adopt, in order

1. **Scope + headings (landed today).** `ROLE` now names the job the request implies and its bounds;
   `REPORTING_GUIDANCE` requires `## Beyond what you asked` and `## What would make this complete`.
   Zero runtime risk, no new state, one cached-prefix invalidation
   ([ADR-0068](../decisions/ADR-0068-scope-and-completion-report.md)).
2. **Policy continuation on an unfinished reply (recommended next).** Widen `continueSlice`'s first
   check from `terminalReason === 'slice_complete'` to also accept `completed` when the run's own
   `todo_write` list holds an open item, no `checkpoint` is `blocked`, no question or approval is
   pending, and the reply is not answer-only (no tool call in the run). Reuse everything else: the
   `continueFrom` pin, `CONTINUE_TEXT` naming the open items, `maxSlices`, and the `progressed` test
   so a fruitless slice does not loop. This is the stop-hook mechanism the table shows, expressed in
   our own vocabulary instead of a new hook surface.
3. **A cap and a person's escape.** Continue at most N times in a row (3, like Cursor's default of 5
   but tighter), and never when the last reply asked the person something. Record the continuation as
   its own run so the transcript shows the handoff; `runs.continuation` already reports it.
4. **Do not adopt** a model-judged goal evaluator: it adds a second model call per reply and can only
   judge what the transcript shows, which is exactly the information the doer already has.

What to measure after 2: the share of `completed` runs with an open todo at the end (baseline 81 of
207 `model_behaviour` runs), and the count of continuation runs per session (should be small — more
than 3 in a row means the acceptance test is wrong, not that the model is lazy).

## Evidence grade and gaps

- The Xingular rows are first-party: file and line in this repository, today's checkouts.
- External rows were read from live documentation on 2026-10-30 by a research pass with URLs cited;
  they are **not** pinned to commits, so a later docs edit can invalidate a row. Where the wording is
  quoted, it is verbatim from that page.
- Not covered: Goose's completion tool, Cline's verbatim `attempt_completion` text, OpenCode step
  limits, and the outer-loop literature (Ralph-style re-prompt loops, LangGraph recursion limits,
  budget-forcing token loops). Treat any use of those as unverified.
