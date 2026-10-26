---
id: STUDY-0003
title: Why a long run takes hours — measured diagnosis of two long sessions
status: measured-diagnosis; fix proposed in PROP-0041
created: 2026-10-26
updated: 2026-10-26
related:
  - PROP-0033
  - PROP-0041
---

# Why a long run takes hours

**Answer.** Neither session was looping on a single action — both kept changing files and running checks. But both ran as **one unbroken reply**: 448 and 274 tool calls, 5 and 2 context compactions, and a single assistant message at the very end, or none at all. The 75-minute session produced one final report and said **"release is still blocked"**. The other was **still running at 114 minutes when measured, with 448 tool calls and not one word to the person**. 41 of those minutes were three Playwright runs, 25 of them on two timeouts, and 55 minutes were 307 model requests averaging 10.7 s each over a ~140k-token context.

The loop is in the **shape of the reply**, not in the goal. The fix is not a better prompt; it is a bounded reply, a durable checkpoint, and a loop guard. [PROP-0041](../architecture/proposals/PROP-0041-bounded-work-slices.md)
proposes them.

## What was measured

Both sessions are ordinary records under the dev data root
(`~/.xingular-harness-dev/data/runs/<id>/`), read together with their native Pi session. Nothing was
re-run; every number below comes from `events.jsonl`, `run.json` and the native `*.jsonl`.

| | A — "Finish App Harness parity integration" | B — "Complete secure Harness release candidate" |
|---|---|---|
| Run | `64cdd5f0` | `2d62eaec` |
| User text that started it | "continue where you left of" | "continue where left of" |
| Started / last event | 17:50:43Z / 19:44:57Z at the cut, still active | 18:27:46Z / 19:42:40Z |
| Wall clock | **114.3 min at the cut, still running** | **74.9 min** |
| How it ended | no end: the same reply was still going | one final report, `completed` |
| Recorded state afterwards | `running` | `completed` |
| Model requests | 307 | 197 |
| Model time | 3299 s (55.0 min), mean 10.7 s, p90 20.0 s | 2924 s (48.7 min), mean 14.8 s, p90 30.4 s |
| Tool calls | 448 | 274 |
| Tool time | 3491 s (58.2 min), 51 % of the run | ~1420 s (23.7 min), 32 % |
| Reads | 163 over 96 paths (`host.rs` 11×) | 101 over 56 paths (`verify-terminal.py` 6×) |
| Edits | 61 over 35 files (`app.test.ts` 10×) | 78 over 30 files (`07-tools-and-gate.md` 9×) |
| Identical repeated calls | 42 instances, 20 signatures | 10 instances, 5 signatures |
| Billed tokens | 18.85 M input + 25.01 M cache read | 16.70 M input + 12.94 M cache read |
| Output tokens | 221 k, of which 175 k reasoning (79 %) | 205 k, of which 173 k reasoning (84 %) |
| Cost recorded by the harness | $2.23 | $1.66 |
| Compactions inside the run | **5**, at 255 852–269 591 tokens | **2** (7 across the 5-hour thread) |
| Cold re-sends (no cache read, >20 k input) | 9 requests, 1.58 M uncached tokens | 9 requests, 1.51 M uncached tokens |
| Assistant text inside the run | **0 characters** | **0 characters until 74.9 min**, then one 2 028-character report |
| Approvals | 49, all remembered, 0.0 s wait | 2, both remembered |

Run A was still producing events while this was written (314 model requests at 19:48Z); every number
for it is frozen at 19:44:57Z, 114.3 minutes in. Run B had already settled.

### Where run A's 114 minutes went

| Bucket | Time | Share |
|---|---|---|
| Model requests (307) | 55.0 min | 48 % |
| Bash (129 calls) | 57.6 min | 50 % |
| — three Playwright runs: 600 s timeout, 900 s timeout, 986 s success | 41.4 min | 36 % |
| Reads, edits, searches, subagent waits | ~0.5 min | 1 % |
| Unaccounted idle | ~1.2 min | 1 % |

The harness was busy for 98.5 % of the wall clock. Nothing was hung; the reply was simply too long,
and every step paid full-context latency. The same browser suite ran three times because it timed out
twice without narrowing itself, and each retry cost the full command budget.

That 986-second command is also why a heartbeat matters: from request 306 at 19:27:56 to request 307
at 19:44:29 there is **no event for 16.6 minutes**. A busy run and a wedged one look identical on the
record.

### Was it progressing?

Yes, measurably:

- 57 `file.changed` events in A at a steady rate (13, 6, 9, 6, 4, 9, 10 per ten minutes), longest gap
  between changes 23.6 min; 74 in B, longest gap 17.5 min.
- 57 successful test/typecheck commands in A; 28 of 129 Bash calls failed and were retried.
- The checklist moved (B: 3 of 7 items completed across 9 checklist writes, and items were added as
  gaps were found).
- B's last message is a real report: what changed, which checks passed (1 255 Harness tests, 586 App
  tests, 185 Rust tests), and what remains blocked. That is genuine incremental work with an honest
  ending — after 75 minutes and 274 tool calls.

But the same data shows the waste:

- 42 calls in A were byte-identical repeats of an earlier call; 20 distinct signatures were repeated.
- `host.rs` was read 11 times; `07-tools-and-gate.md` was edited 9 times as the checklist reworded
  what "done" meant.
- Run B read its own trajectory 63 times and searched it 8 times — recovering, inside the run, state
  that earlier compactions had dropped.
- Neither session produced a commit. The worktree is still dirty: B's own report counts 119 tracked
  changes and 267 untracked files, which failed release preflight's clean-tree check. So "continue
  where you left off" had no unambiguous answer — the work is real, but it is not a deliverable.
- A's checklist was rewritten 7 times (B's 9) and its items were reworded each time
  ("Complete Harness launch…" → "Complete App commands…" → "Complete App shared-profile…" →
  "Close profile-root migration…" → "Finish App shared-profile…"). That is scope drift, not a
  maintained plan.

So: **incremental work, at roughly half efficiency, with no visible progress and no way to stop
cleanly.** A person watching saw tool rows for 75–114 minutes, then either a single report or nothing
at all.

## The mechanisms that are missing

Measured against the code (all verified in this tree):

| Mechanism | State in this tree | Consequence |
|---|---|---|
| Reply budget | Only the opt-in `budget-guard` plugin (`src/plugins/firstParty.ts:31,105-140`), **off by default** and a blunt stop: it refuses tools and terminates the reply with no checkpoint | One reply ran 114 min and 448 calls |
| Checkpoint | PROP-0033's checkpoint exists (`src/sessions/compactionCheckpoint.ts`), but it restores only *goal + checklist + plan*, and `renderCompactionCheckpoint` returns `null` when there is no checklist (`src/prompt/compile.ts:196`) | No files, no failing commands, no decisions; A wrote no assistant text at all |
| Compaction discipline | Pi compacts at ~94 % of the window; the harness only observes it (`src/sessions/runner.ts:470-478`) | 5 compactions in one reply, each a cold re-send; state rebuilt by re-reading files |
| Command ceiling | Bash `timeout` is optional, "no default timeout" (`src/core/workspaceBashTool.ts:23`) | 41 minutes in three Playwright runs; 36 % of run A |
| Loop / stall detection | None (`rg loop|stuck|repeat` finds nothing in `src/sessions`) | 42 duplicate calls; 9 edits to one document |
| Liveness | Reconciliation runs only at startup and is keyed on the owner pid (`src/sessions/runStore.ts:228`); `owner.json` holds a bare pid | A run that stops producing events while its process lives is never settled, and a recycled pid can make a dead owner look alive. A long command already writes nothing for 16.6 minutes |
| Progress visibility | No mid-reply text requirement; `REPORTING_GUIDANCE` shapes only the final reply | 0 characters in 114 minutes and counting for A; one message at 74.9 minutes for B |

The layer boundary matters for the fix: task and goal lifecycle belong to the application
(`docs/study/feature-gap-review.md:7,35`). Everything above is **run execution**, which the harness
owns. PROP-0041 keeps it there.

## What other harnesses do about this

Fetched 2026-10-26; URLs are the primary sources.

| Mechanism | Who | Trigger | What it prevents |
|---|---|---|---|
| Stop hook that blocks the turn from ending until a check passes, with a cap on consecutive blocks | [Claude Code](https://code.claude.com/docs/en/best-practices) | Turn end | "Looks done" endings and endless turns |
| Auto-compaction thrash guard: after a few refills, stop compacting and report the offending oversized result | [Claude Code troubleshooting](https://code.claude.com/docs/en/troubleshooting) | Repeated compaction in one turn | Summarise–refill loops |
| Post-compaction re-injection of the plan file and up to five recently touched files (path only above 5k tokens) | [Claude Code context window](https://code.claude.com/docs/en/context-window) | Compaction | State lost to the summarizer |
| Tool-result clearing before summarisation | [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context pressure | Unbounded context growth |
| Subagents with a 1–2k-token return contract | [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) | Model decision | Exploration flooding the main context |
| `todo.md` recitation at the end of context; restorable compression (drop content, keep URL/path); keep failed actions | [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | Every step / compression | Goal drift, repeated mistakes |
| Loop detection by hashing `toolName + args`, cycle length 1–5 repeated 5×, plus an LLM judge after 30 turns | [Gemini CLI loopDetectionService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts) | Every streamed tool call | Oscillation and repeated failing commands |
| Stop hook with `loop_count` and `MAX_ITERATIONS = 5` | [Cursor](https://cursor.com/blog/agent-best-practices) | Turn end | Unbounded single turn |
| `max_requeries = 3` on malformed or blocked actions | [SWE-agent config](https://swe-agent.com/latest/reference/agent_config/) | Action error | Infinite retry |
| Repo map under a 1k-token budget (PageRank over the dependency graph) | [Aider repomap](https://aider.chat/docs/repomap.html) | Every request | Re-reading files to re-orient |
| Auto-commit, lint and test after each edit | [Aider git](https://aider.chat/docs/git.html) | Each edit | Long stretches with no checkpoint |
| Event-count condenser that keeps the first events | [OpenHands context condenser](https://docs.openhands.dev/sdk/guides/context-condenser) | History size | Cost and latency growth |
| Pre/post-turn compaction phases and pre/post-compact hooks | [Codex compact.rs](https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/compact.rs) | Turn boundaries | Unpredictable compaction |
| Truncate-then-summarise plan saved to memory because the window will truncate | [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system) | Context limit | Losing the plan |

Two reference scales are worth stating plainly: Manus reports **~50 tool calls per task**, and
Claude Code's published loop cap is **5 iterations**. Both runs here exceeded those by 5–9× inside a
single reply that addressed the person once, at the end, or not at all.

Context rot compounds it: performance degrades as input grows and is worst for content in the middle
of a long context ([Chroma](https://www.trychroma.com/research/context-rot),
[Lost in the middle](https://arxiv.org/abs/2307.03172)). A 250k-token context is therefore both slow
and less reliable — the re-reads and reworded checklists are what that looks like.

## What to adopt, in order

1. **P0, configuration only, today.** Switch on `output-trim` (20 000 chars) and `budget-guard`
   (120 requests) in the plugin attachments of the affected account/project. That alone caps the
   reply and shrinks tool results. No architecture change, reversible per account and per project.
2. **P0b, small foundation fixes.** A default Bash timeout that returns partial output, and a stall
   watchdog keyed on heartbeat age rather than only the owner pid. Both are narrow and independent of
   the slice design below.
3. **P1, bounded work slices (PROP-0041).** A reply budget of 160 tool calls / 40 min / 320k new
   tokens, a validated checkpoint at the boundary, and a continuation that starts from that
   checkpoint. This is the structural fix.
4. **P2, the checkpoint as state, not prose.** Bounded, evidence-linked (files, failing checks,
   decisions, next step) and injected at every slice start and after compaction, so the model never
   re-derives state by archaeology.
5. **P3, deterministic loop guard.** Identical `tool + args` three times, the same command failing
   twice, or 25 steps with no file change and no passing check: nudge once with the evidence, then
   end the slice as `blocked`.
6. **P4, command budget.** Hard ceiling, and long suites (Playwright, full CI) as background work
   rather than 16 blocking minutes.
7. **P5, compaction pipeline.** Clear old tool results first; summarise with restorable references
   (path + line range); stop after three compactions in one reply and hand off instead.
8. **P6, visible progress.** Record narration as `progress` events and a heartbeat with steps,
   elapsed time, slice and compactions; show "next checkpoint in N steps" in both surfaces.

## How to judge whether it worked

Baseline from these two runs, to compare after PROP-0041:

| Metric | Baseline |
|---|---|
| Time to first user-visible text | never (A) / 74.9 min (B) |
| Tool calls per user-visible text | ∞ (A) / 274 (B) |
| Longest reply | 114 min and counting / 448 calls |
| Compactions per reply | 2–5 |
| Repeated identical calls | 42 per 448 (9 %) |
| Reads per distinct file | 1.7 (163/96), worst 11 |
| Time in three Playwright runs | 36 % of run A |
| Runs left `running` after owner death | 1 of 2 |

A working slice policy should keep the longest reply under ~45 minutes, put text in front of the
person at every boundary, hold compactions to at most one per slice, and never leave a run
`running` after its owner is gone.

## What this does not fix

Model latency per token, the correctness of the work itself, or a task whose acceptance criteria
were never written down. A slice boundary cannot invent a definition of done; it can only make the
absence of one visible early.

## Appendix: how to reproduce

Read-only, from the dev data root:

```sh
R=~/.xingular-harness-dev/data/runs/64cdd5f0-da45-43a1-9130-89c54f298f21
jq -r 'select(.type=="usage.updated") | .payload.request.durationMs' "$R/events.jsonl" | awk '{s+=$1/1000; n++} END {print n" requests, "s" s"}'
jq -r 'select(.type=="tool.completed") | .payload.name' "$R/events.jsonl" | sort | uniq -c | sort -rn
jq -r 'select(.type=="message.completed") | .payload.role' "$R/events.jsonl"
```

The assistant's own text lives in the native session named by `run.json`
(`nativeSessionId`), as `message` entries whose `content` blocks have `type: "text"`.
