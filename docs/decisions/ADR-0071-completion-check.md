---
id: ADR-0071
title: A completion check decides whether a reply may end; finish is removed
status: accepted
created: 2026-10-31
updated: 2026-10-31
supersedes: partial — ADR-0069 (the `finish` tool and the `needs_person` it declared)
related:
  - ADR-0069
  - ADR-0070
  - STUDY-0004
---
# ADR-0071 — A completion check decides whether a reply may end; finish is removed

## Context

ADR-0069 added a deterministic todo gate and a `finish` tool. A live A/B with the Panisara account
on `openai-codex/gpt-6-luna` used the prompt "work for the handoff docs/handoffs/B-platform-and-api.md":

| Build | What happened |
|---|---|
| Before ADR-0069 | The reply branched, edited `package.json`, hit an `npm install` failure, and stopped. It marked every todo item `completed` while its own reply said "B0 remains incomplete", so it settled `completed`. |
| With ADR-0069 | The reply stopped after 23 seconds through `finish(needs_decision)`, asking to "confirm I should start with B0 and create the worktree". The handoff already answers both. |

The `role` section was missing from both runs, because the runner did not pass `launch.standard`,
so the prompt layer was not tested.

The A/B showed three ways a reply stops while it could continue:

1. it ends with todo items open (the gate catches this);
2. it marks items done falsely (the gate cannot see this);
3. it stops to ask permission for something inside its authority, which `finish` turned into a
   sanctioned exit.

Every harness studied keeps the agent doing the work from certifying its own early stop:

| Harness | Who decides the work may stop |
|---|---|
| Claude Code | A Stop hook, or the `/goal` evaluator: a separate model returning met / not met / impossible |
| Codex, Cursor, Amp | Stop hooks |
| OpenHands headless | Scripted auto-continue: "Please continue working on the task… Do NOT ask for more help" |
| Aider | Test exit codes |
| Anthropic long-running harness | Tests decide before a feature is marked passing |

`finish(blocked | needs_decision)` was the opposite: a self-declared exit.

## Decision

1. **Remove `finish`.** The model has no tool that ends or hands off its own work (INV-TOOL-9).
2. **Add the completion check** (`sessions/completionCheck.ts`, wired into `sessions/stopGate.ts`).
   - **When it runs:** at Pi's `agent_before_settle`, when the todo list is closed or absent and the
     reply made a work tool call (pure chat and one-line answers are never checked).
   - **What it asks:** the run's own model (`ctx.modelRegistry.streamSimple`, reasoning `low`, a
     fresh context and its own system prompt) judges the person's request against a clipped
     transcript of this reply and its todo list. For a continuation, the request is the one behind
     the chain.
   - **`continue`:** the reply is sent back with a displayed `xingular-completion-check` message
     carrying the reason and the next step.
   - **`needs_person`:** the reply settles `interrupted` / `needs_person`, with the check's reason as
     the checkpoint's `blocked`.
   - **`done`:** the reply ends `completed`.
   - **Limits:** it shares the todo gate's cap of three nudges per reply and the no-progress rule.
   - **Recording:** its request is recorded in the run's usage.
   - **Failure:** it fails open on any error.
   - **The request is the goal.** There is no `/goal` command and no condition to write.
3. **Same model, low effort.** Chosen by the person over a cheaper model. The trade-off is that the
   same model shares some blind spots with the doer. A separate system prompt, a fresh context
   holding only the request, list and transcript, and no tools limit that.
4. **Prompt.** `role` names the decisions that are the agent's own and the only reasons to stop. It
   says that a document the request points to is the request, and that a question the request or
   files already answer is not a question for the person. In a person's own session, the `Progress`
   group says replies are checked. The role budget is now 2,200 characters, so the role fits uncut
   with the subagent paragraph.
5. **Kill switches.** `XINGULAR_STOP_GATE=off` and `XINGULAR_COMPLETION_CHECK=off` at launch, for
   layer-by-layer experiments.

## Consequences

- A reply that did work costs one more model request when it ends, plus at most three nudges. A
  reply with no tool calls costs nothing extra.
- False "done" lists and permission questions are answered by the check rather than reaching the
  person. A real blocker still stops the reply, but a separate judgement decides it, and the record
  says why.
- The faux model in tests must answer the check too, so the test setup switches it off by default
  and the tests about it switch it on.
- **Measure, layer by layer**, with a live A/B on clean copies, 3 runs per arm:
  - (A) the old harness;
  - (B) the prompt only;
  - (C) the prompt plus the todo gate;
  - (D) everything.

  Compare tool calls before the reply ends, false "completed" lists, permission-question stops,
  nudges by layer, check verdicts and cost.

## Alternatives considered

- **Keep `finish` with a double check** (refuse the first `needs_decision`). Rejected: it still tells
  the model there is a sanctioned way out, and asks it to insist.
- **A `/goal` command.** Rejected by the person: ordinary requests must keep going without one.
- **A cheaper judge model.** Not chosen. It would be cheaper and more independent; the person
  preferred the run's own model.
- **Prompt only.** Rejected as the only layer: agent B ignored "dont stop" in the person's own
  message, and a live session keeps the prompt it started with.
