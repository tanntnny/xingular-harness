---
id: PROP-0046
title: Progress-aware stall guards and bounded plan research children
status: Implemented
created: 2026-10-27
updated: 2026-10-27
affects: [INV-RUN-13, 02-sessions-and-runs.md, PROP-0041, terminal-tui.md, ADR-0039]
---

# PROP-0046: Progress-aware stall guards and bounded plan research children

## Problem

The stall guard currently has a broad 25-call rule: it nudges after substantive calls without a file change or passing check. It is disabled for plan-mode research, but remains active for ordinary runs. A long, legitimate sequence of reads can be stopped in normal mode but not plan mode; the rule imposes a mode-specific file/check-progress boundary rather than detecting a loop.

Two targeted rules also ignore successful code changes. Failed-check counts and identical Bash-check calls can persist after an edit, so a fixed test command may be blocked even though its input code has changed. The per-file edit-churn count is incremented in `tool_call`, before the edit runs, so a denied or failed attempt can count as an edit.

Finally, plan-research children receive only the explicit read-only research tool intersection, which excludes `checkpoint_write` (`src/agents/planResearch.ts`). `Sessions` installs the work-slice guard only when that tool is in the frozen capability set (`src/sessions/sessions.ts`). These children consequently lack the call/time boundary that the work-slice proposal says applies to subagent runs. The terminal guide also says plan-mode shell commands are unavailable even though the parent may run OS-sandboxed read-only Bash (`docs/terminal-tui.md`; PROP-0043).

## Affected rules

- **INV-RUN-13** currently says: “The file-change/check-based no-progress detector does not apply to plan-mode read-only research.” This proposal removes the detector for all runs, rather than preserving a mode-specific exception. It also clarifies how successful edits affect the remaining stall counters and how a bounded child without `checkpoint_write` hands back.
- **PROP-0041, §4 Stall guard** currently includes “25 non-bookkeeping tool calls without a file change or passing check,” counts edit attempts before execution, and describes repeated Bash failures without resetting for a changed code state. Its stall-guard description must match the new rule.
- **INV-RUN-8** remains unchanged: plan-research children keep their existing frozen, read-only capability intersection, with no connectors, questions, writes, commands or nested subagents. The child work-slice bound does not add a tool or widen that set.
- **`docs/terminal-tui.md`** must distinguish the parent's sandboxed read-only Bash from the child's no-command restriction.

## Proposal

### 1. Remove the broad no-progress trigger

Remove the 25-call file-change/check detector from every run. Remove its counter and plan-mode exception; do not replace it with another general “no file change” threshold. The tool-call/time work-slice budget remains.

Keep the targeted stall protections: the same exact call signature still receives one nudge at its existing threshold and ends the reply on a subsequent trigger; the same Bash check failing twice remains a trigger; per-file edit churn remains limited to four successful edits without a passing check; and the existing third-compaction thrash guard remains. Todo bookkeeping remains exempt from repeated-call detection and remains counted toward the work-slice tool-call budget.

### 2. Tie check retries and edit churn to observed results

Use the post-execution `tool_result` for native `edit` and `write` tools. A result with `isError === false` and a path is a successful edit for this rule; a blocked or failed call does not count. After four successful edits to one path without a passing check, the next edit attempt for that path receives the existing nudge/block, and a further trigger ends the slice. A passing check continues to clear the per-file edit counts.

A successful native edit/write starts a fresh check-retry episode: clear failed-check counts, the exact-repeat count for Bash check calls, and the pending one-shot nudge so the same check can run against changed code. Exact-repeat protection remains active for unchanged code and for other calls. The successful-edit counts used by the per-file churn rule are not cleared by this reset; only a passing check clears them. Failed or denied edits reset none of these counters.

The cross-surface success signal is the tool result, not a byte-level file comparison. The guard must count only a confirmed non-error result and use its path; no filesystem watcher or new event schema is introduced.

### 3. Bound read-only plan-research children

When work-slice policy is enabled, attach the existing guard to plan-research child runs even when their frozen capabilities omit `checkpoint_write`. Use the existing policy/defaults (320 calls and 60 minutes, no token cap); inherit an explicit parent policy override. Plan and subagent runs still do not auto-continue.

A child without `checkpoint_write` must not be told to call an unavailable tool. The first budget or stall refusal tells it to stop using tools and return a concise partial research report; if it attempts another tool, the existing termination rule applies. The runner's existing evidence-derived checkpoint records the handoff when the model did not write one. The child receives no additional tool or connector permissions. This proposal bounds each child, not the aggregate number of siblings; the existing parent-controlled fan-out is unchanged. The time limit remains checked at tool-call boundaries and is not a cancellation timer for an in-flight tool.

### 4. Keep plan-mode action restrictions

Do not enable generic browser clicks or `mcp_call_tool` in plan mode. Existing per-call safety classifications and read-only restrictions remain unchanged. A future need for connected-app research must add server-validated read-only classification rather than admitting the generic broker call.

Clarify `docs/terminal-tui.md`: an interactive plan parent may run Bash in the OS-enforced read-only sandbox (PROP-0043); plan-research children still cannot run commands. Writes, network access and generic connected-app actions remain unavailable in plan mode.

## Alternatives

- **Keep the 25-call trigger outside plan mode.** Rejected: it still mistakes legitimate read/research sequences for lack of progress and preserves an arbitrary mode distinction.
- **Remove all stall protections.** Rejected: exact repeated calls, repeated failing checks, edit churn, compaction thrash detection and the independent work-slice budget remain useful, targeted bounds.
- **Give plan-research children `checkpoint_write` or broader tools.** Rejected: the existing derived-checkpoint path is sufficient and preserves the frozen read-only capability intersection.
- **Add a tighter child-only budget or sibling concurrency cap.** Deferred: this change applies the established work-slice policy per child; aggregate fan-out remains a separate decision.
- **Detect byte-level file changes.** Rejected for this change: the post-execution native tool result is the consistent signal available to the shared guard across surfaces.

## Consequences

A run may make any number of distinct reads without hitting a file/check-based no-progress stall, subject to the work-slice budget and the retained targeted loop protections. After a successful edit, the same Bash check can be retried against the changed code; unsuccessful edit attempts do not consume the four-edit churn allowance.

Plan-research children can stop at the same call/time boundary without receiving a new capability. A child that reaches the bound is recorded as an interrupted slice with the runner-derived checkpoint and can return partial findings; it is not automatically restarted. No server method, run-event schema, stored-data layout or App presentation changes are required. Existing plan-mode browser and connector restrictions remain in force.

This lasting foundation guardrail decision is recorded in [ADR-0039](../../decisions/ADR-0039-progress-aware-stall-guards.md).

## Migration

None. Existing run records and checkpoints remain readable. The proposal changes only future run behavior; no event or capability snapshot is rewritten. A child stopped at its slice boundary uses the existing `checkpoint` event and terminal reason contracts.

## Checks

After acceptance:

- Focused Harness tests: `npx vitest run src/sessions/workSlice.test.ts src/sessions/sessions.test.ts src/sessions/subagentService.test.ts src/sessions/planMode.test.ts`.
- Add regressions for more than 25 distinct reads in normal and plan runs; unchanged exact repeats; failures followed by a successful edit and a retry of the same Bash check; failed/blocked edits not counting; four successful edits to one path; and a plan child receiving a work-slice bound without gaining `checkpoint_write` or other tools, using a derived checkpoint and no auto-continuation.
- Run Harness `npm run typecheck`, `npm test`, `npm run prove`, and `git diff --check`.
- Run Xingular Agent `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
