# Arm 03 — Subagents

Status: **core four audited** (opencode, omp, dsh, plus our ADR-0003 lineage);
openhands/claude-code pending.

## Design space

Spawn model (tool vs scheduler vs server), child context (fresh, forked, or
continuable), isolation primitives (separate session, separate history, own
worktree/capabilities), delivery (block vs background + receipts), routing
(manual naming vs description-based auto-selection), and depth/capacity limits.

## Comparison

**this harness.** `spawn_subagent` + `wait_subagents` tools
(`src/tools/spawnSubagent.ts`): child is "a fresh child run for independent
work… no conversation history and no more capabilities than you"; spawn returns
the child run id immediately; results arrive **automatically before you finish**
(native-history delivery receipts per ADR-0003); 24k per-report cap
(`spawnSubagent.ts` `reported()`); depth limits live in
`src/sessions/subagents.ts` (exported constants). Architectural statement:
Architectural statement:
opaque-run children (runStore writes, opaque ids).

**opencode — subagent is a tool, not a scheduler.** Agents registry
(`mode: primary|subagent`) with selectability excluding subagents from direct
conversation (`.../core/src/agent.ts:74-75`). The `subagent` tool rejects
primaries/unknowns, enforces depth via config, asserts permission, then creates
a child session and prompts it "You are a subagent spawned by another session."
— **fresh context, nothing inherited** (`.../tool/plugin/subagent.ts:129-218`).
Foreground variant blocks and wraps the final text in
`<subagent sessionID=… state="completed">`; background replies immediately with
an explicit **never-poll instruction** and completion notification
(`.../subagent.ts:19-27,229-265`). **Routing is description-based**: a context
hook appends "Available subagents:" with each agent's own description to the
tool description (`.../subagent.ts:282-309`).

**omp — spawn machinery with isolation budgets.** The `task` tool; agent
definitions from bundled + `~/.omp/agent/agents/*.md` + `.omp/agents/*.md`
(`.../task/index.ts:4-10`). `SpawnRun` holds a semaphore permit and streams
progress; the owner adopts binding abort signal/sinks
(`.../task/spawn-run.ts:47-88`). **Speculative launch starts the child while
the `tasks[]` argument is still streaming** (`.../task/speculative-launch.ts`).
Isolation: pinned settings, advisor forced off, **mid-turn compaction forced on
(whole assignment is one turn)**, isolated runs get their own **worktree** and
may not expose roots outside it (`.../task/executor.ts:1132,4033-4055,4339`).
Structured children get `yield` to stream partial results
(`docs/task-agent-discovery.md:38`).

**dsh — services + backends, two child topologies.** `ctx.subagents` +
provider backends (local, ACP, Codex, Claude DSH-SDK) + a tool plugin
(`.../packages/subagent/README.md:27-35`). Spawn returns `started subagent
<childId>` immediately; a completion notice delivery later
(`.../tool-subagent/README.md:59`). `spawn` = fresh child; **`fork` = seeded
from the parent's completed history** (`.../subagent/README.md:28-29` — the one
source with tree-history in context children). Local children **continue
accepting messages** (cold-resume); external backends "execute once"
(`:12,61`). Defaults: 8 active, depth 1 (`.../subagent/README.md:53,49`).
The model names presets from an enum allowlist; **no description routing**
(`.../tool-subagent/README.md:52,68`).

**openhands (pending)** conversation-per-container REST server;
**claude-code (pending)** `.claude/agents/*.md` description routing.

## Trade-offs

- **Receipts vs block.** Ours receipts-then-auto-deliver; opencode's
  foreground blocks and the background variant needs a no-poll instruction to
  stop wasted loops — our "results arrive automatically" tool description does
  the same thing natively. block variants pay latency, buy simplicity.
- **What the child sees.** Everyone defaults fresh. dsh's `fork` (parent history
  as seed) is the only in-history-inherited design — powerful for "continue in
  the main context's condition", dangerous for either prosecution
  side-venting or slow joins; ours rejects it by `"no more capabilities than
  you"` + fresh-run rule.
- **Isolation granularity.** worktree (omp isolated runs) is the strongest
  world-isolation; ours ties isolation to account and run records instead. The
  `tools` CSV narrowing idea maps to our `capabilities.intersect` — same
  primitive, different vocabulary.
- **Routing.** Description-based auto-pick (opencode, and claude-code's docs)
  puts all selection power in the model's reading; ours requires named briefs
  and a Directory when names exist, which matches the opaque-id
  contract (no names in the harness; names arrive via Directory).

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| S1 | Inject capability-set summaries (slots "Current subagents") into the tool description **when names exist via Directory**, instead of static description | opencode context hook | tool provider building the spawn tool's description | T2 (only if app supplies names) |
| S2 | Receipt text carries child tool limits next to the 24k cap (`reported()` already does this only implicitly; make the receipt self-describing) | ours (deficiency) | `spawnSubagent.ts` | T1 |
