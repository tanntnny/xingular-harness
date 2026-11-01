---
id: ADR-0072
title: Codex's prompts and /goal; the completion check moves behind /goal
status: accepted
created: 2026-11-01
updated: 2026-11-01
supersedes: partial — ADR-0071 ("every reply is checked", "there is no /goal command"); amends INV-TOOL-9
related:
  - ADR-0069
  - ADR-0070
  - ADR-0071
  - STUDY-0004
---
# ADR-0072 — Codex's prompts and `/goal`; the completion check moves behind `/goal`

> **Amended by [ADR-0075](ADR-0075-no-todo-gate.md):** the todo gate is removed, so ordinary replies
> rely on the prompt alone. The goal loop and its completion claim check stay.

## Context

ADR-0071 asked a model to judge, at the end of **every** reply that did work, whether the request was
done. Run history after it showed what was still wrong and what was not:

- In the "dont stop" handoff runs that ended on their own with work left (`62c7fc6c`, `d73804c8`,
  `b3ab2349`) every run still had an open todo item, and the final reply said "not complete" without
  a reason or a next step. The todo gate catches that; the check never ran for them.
- The check ran once in all history and failed: `sessionCheckModel` sent no session id, and
  opencode-go answered 400 `MissingSessionID`.
- The person wants the evaluator only for an opt-in, long-running goal, and ordinary requests to
  finish what they can and say plainly what is done, why it stopped and what is next. The person also
  observed that the todo list, written after a short look at the repository, becomes the boundary of
  the work: it is progress, not scope.

OpenAI Codex is open source (Apache-2.0). Read at commit 67f0994b53 (2026-10-31):

| Part | What Codex does |
|---|---|
| An ordinary turn | Ends when the model makes no tool call. No completion check, no plan gate. Completion pressure is prompt text only (gpt-6 "Autonomy and persistence", "When to ask the user for permission", "Compaction does not end the task"). |
| `update_plan` | Display only and stateless. |
| `/goal` | No evaluator. The model calls `update_goal(complete \| blocked \| paused)` after a strict audit prompt; the harness starts the next turn whenever the thread is idle and the goal is active. `blocked` needs the same blocker on three consecutive goal turns. Codex's history removed the "no tool call, so stop" rule and elapsed-time text because they made the model shortcut work. |
| Stop hooks | A hook's continuation is a user-role message, "to match training for turn loops". |

## Decision

1. **Ordinary replies** have no model-judged check. The deterministic todo gate (ADR-0069) stays:
   three nudges, the no-progress rule, and now the text "the list shows progress; it is not the limit
   of the work". Completion pressure is the prompt.
2. **The prompt adopts Codex's wording** for a person's own session, as separate stable sections:
   `autonomy`, `permission`, `steering` and `writing` (`src/prompt/standard.ts`), and a longer
   `reporting` section whose first rule is that unfinished work says so on the first line, with the
   reason and the next step. They apply to every model, so the terminal and a host read the same
   text (INV-PAR-1). Left out: text about Codex's own channels and tools, and "do not run tests
   unless asked", which contradicts this harness.
3. **The todo list is progress, not scope.** `TODO_GUIDANCE` says the request and any document it
   points to is the scope; list a handoff's steps instead of one "remaining work" item; compare the
   request, not the list, with what is done before ending the turn.
4. **`/goal <objective>`** is the person's opt-in long run (terminal command, and `goal` on
   `sessions.run`). The person sets it and the work starts at once. It adopts Codex's:
   - tools `get_goal` and `update_goal` (descriptions and errors verbatim; offered to the model
     only while a goal exists; **there is no `create_goal`**, the person creates goals);
   - prompts `continuation`, `budget_limit` and `objective_updated` (the objective escaped and
     wrapped as data);
   - states `active | paused | blocked | usage_limited | budget_limited | complete`;
   - brakes: three automatic rounds with no activity, three with only failed commands, a provider
     error (`blocked`), a usage-limit error (`usage_limited`);
   - the person's side: `/goal [<objective>|edit|pause|resume|clear]`, a replace confirmation, Esc
     pauses a running goal, a footer label, a provenance message for each change.
5. **A completion claim is checked.** `update_goal(complete)` only records a claim. At the next
   settle the same model, at low effort, with a fresh context and no tools, checks the claim against
   the objective and the transcript (Codex's audit: completion is unproven, weak evidence is not
   enough, quote the evidence). `done` completes the goal; `continue` keeps it active with the
   reason; no model, an error or an unreadable answer accepts the claim. This is the only completion
   check in the harness.
6. **Caps.** Rounds and hours, not tokens (the harness accounts for time, not a token budget): 30
   rounds or 8 hours by default, `--rounds N --hours H` per goal. At the cap the goal becomes
   `budget_limited` and gets one last round to wrap up (progress, what remains, the next step).
7. **INV-TOOL-9 is amended:** the model has no tool that ends or hands off its own work, except
   `update_goal` in a goal the person started, whose `complete` is checked and whose `paused` needs
   the person's word.
8. **Server runs.** `sessions.run` takes `goal: { objective, rounds?, hours? }` for a person's own
   top-level run; the run continues in place, and `goalMode` on `run.json` records the objective,
   status, rounds and time. A goal that crosses a work-slice boundary is carried by `continueSlice`.
   In this change a server goal belongs to one run chain; `goal.set | get | clear` as separate
   methods and pause/resume across unrelated runs are left for the App's screen.
9. **Also fixed:** `sessionCheckModel` passes the session id, so opencode-go accepts the request.
   `XINGULAR_COMPLETION_CHECK=off` now accepts every goal claim unchecked.

## Consequences

- An ordinary reply costs no extra model request. A goal costs one request per completion claim.
- The stable prefix grows by about 8 to 9 thousand characters (the new sections), once. Starting a
  goal changes the active tools once (the two goal tools), which can cost one cache miss.
- The goal's continuation prompt is long (about 6.5 thousand characters); it rides as a hidden user
  message in each round, and the claim check skips it.
- A restored conversation shows its goal as `paused`; nothing resumes by itself.
- Measure, as ADR-0071 asked: the same handoff prompt on clean copies, three runs per arm (old
  build, new ordinary reply, new `/goal`): tool calls before the reply ends, false "completed"
  lists, permission-question stops, the first line of the final report, claim checks and cost.

## Alternatives considered

- **Codex exactly (no evaluator).** Rejected for the goal's `complete`: run history shows models
  marking work done falsely, and a separate fresh-context look at one claim is cheap.
- **Keep the every-reply check, cheaper model.** Rejected by the person: ordinary requests should
  finish on their own, and no studied harness judges ordinary replies.
- **A model-created goal (`create_goal`).** Not adopted: it would put a goal tool in every session.
- **A harness nudge when a reply's own text says work remains.** Rejected by the person for now:
  prompt and the todo gate only.
