# Arm 05 — Context management

Status: **core three audited** (opencode, omp, dsh); smolagents skeleton;
ours=pending inventory beyond contracts; claude-code/openhands pending.

## Design space

What is sent per turn vs fetched on demand; compaction triggers and strategies;
where summarization sits relative to the cache; truncation of tool outputs;
token accounting granularity (uncached input / cache read+write separation).

## Comparison

**this harness (contracts).** Stable system prefix + hidden `xingular-context`
native-history message for changing state; usage accounting: `inputTokens` is
uncached input, cache reads/writes separate, reasoning inside output,
`usage.updated` cumulative per run (repo contracts). Compaction story pending
inventory (whether sessions rely on Pi native history management + context
updates).

**opencode — summarizer as a resident agent.** Triggers: `auto` when estimated
context ≥ ceiling (window − max(15%, 16k) reserve), `overflow` after provider
rejection, `manual` (`.../session/compaction.ts:53-57,93-101,849-856`); auto
skips until a fresh provider measurement exists (`:245-253`).
Strategy: a dedicated compaction agent/model summarizes every dialog into a
**fixed template** (Objective / Requirements / Decision / Work State / Next
Move / Relevant Files) while keeping the newest `keep` tokens verbatim as a
`<conversation-checkpoint>`; **the whole conversation is sent to the
summarizer to reuse the prefix cache** (`:107-138,256-332`). Rejection retries
at 70/50/35% of the rejected size (`:455-461`). Generic ToolOutput truncation to
maxLines/maxBytes with `metadata.truncated`
(`.../core/src/tool-output.ts:28-88`); shell saves full output to a file and
returns a bounded tail (`.../tool/plugin/shell.ts:42-43`).
Accounting: latest assistant response is the anchor
(`input+cacheRead+cacheWrite+output+reasoning` measured) plus an estimate of
unmeasured since (`:812-842`); 4 chars/token estimate ±15%
(`.../session/model-request.ts:53-54`).

**omp — the strategy ladder + deterministic frontier.** Trigger points: post-turn
over `resolveThresholdTokens`, mid-turn, idle, overflow-recovery
(`.../session/session-maintenance.ts:626,2147,2246,2412`).
`compaction.methodOrder` ladder: LLM summarize (regular/handoff), `shake`
(local mechanical elision to `artifact://` refs), `snapcompact`
(`docs/compaction.md:202-215`). **Snapcompact is local/deterministic, no LLM**:
discarded history serialized with per-result caps into provider-aware PNG
bitmap frames (typography per provider family), persisted and re-attached each
rebuild (`packages/snapcompact/README.md:3-29,44-68`). Budgets: kept context
≤60% of threshold, target ≤80% (`docs/compaction.md:217,221`). Cache care:
pruning blanks outputs only within the model's `prompt-cache-lookback`
(`docs/compaction.md:248`); summaries drop whole call/result pairs (`:250`).
Byte-stable system prompt between turns is an invariant
(`.../session/agent-session.ts:2607`).

**dsh — formulas + query-ability.** `compaction-basic` trigger:
`floor(min(W×0.8, W−O−headroom))`, headroom 65_536, keeps newest 16% of the
usable window, one extra model request, summary-only retention
(`.../packages/compaction/compaction-basic/README.md:12,32,62-68`).
Oversized tool results pruned first; images offloaded to placeholders
(`.../packages/compaction/README.md:31-32`). `session-query` = SQLite FTS5
full-text search over the durable log, independent of compaction
(`.../packages/session-query/README.md:12,30`).

**smolagents.** `AgentMemory` is a step log (ToolCall/ActionStep/PlanningStep/
FinalAnswer) rebuilt to messages with `summary_mode` each step — replay-style,
no incremental fades (`external/smolagents/src/smolagents/memory.py:25,46,92,206-229`).

## Trade-offs

- **Summarizer economics.** opencode sends the *whole transcript* to the
  summarizer to reuse the prefix cache — larger paid input per compression, but
  cache-discounted and higher-fidelity. dsh keeps only the summary (cheapest
  retention). The choice hinges on whether compaction runs once or repeatedly.
- **A deterministic rung is the safety net.** omp's ladder means a compaction
  never fully depends on a slow/failing LLM pass (shake/snapcompact). That
  resilience has no counterpart in opencode/dsh (dsh retries on overflow).
- **Searching beats re-shipping.** dsh's session-query (and omp's shard
  omp's shard-style retrieval in `shake`) treat old context as a database, not a
  transcript; "retrieve details through tools when needed" matches our
  CONTEXT_GUIDANCE wording (`src/prompt/compile.ts:333`).
- **Accounting honesty.** opencode's anchor-measured + estimated-elsewhere and
  our uncached/cached split are compatible; the 4-chars/token estimate is the
  common fixed-density fallback (dsh token-meter identical semantics).

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| C1 | A fixed-template summary shape (named sections) for any summarization run, so restored context is predictable and diffable | opencode compaction template | refine/trajectory or session docs; needs Pi-native compaction knowledge first | T2 verify-first |
| C2 | Prune-first ordering (oversized tool outputs) before any summarization | dsh + omp | facet of the context update path | T2 verify-first (what already trims?) |
| C3 | Keep a verbatim tail checkpoint marker in any summary | opencode | same home as C1 | T2 |
