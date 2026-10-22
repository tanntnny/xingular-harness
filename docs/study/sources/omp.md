# Source: oh-my-pi (omp) — the open tuning of pi

- Origin: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi); a fork of
  [badlogic/pi-mono](https://github.com/badlogic/pi-mono) by @mariozechner. This
  harness family's Pi session runtime is upstream pi; omp is the sharpened sibling.
- Local clone: `external/omp` (907 MB incl. assets/Bazel).
- Status: **arm-01 verified in person; arms 02–06 audited** (explorer report;
  my spot-check of `date-cwd-reminder.ts` done).

## Verified layout

Rust crates (`crates/`): `pi-ast`, `pi-builtins`, `pi-diff`, `pi-edit`, `pi-iso`,
`pi-natives`, `pi-predict`, `pi-shell`, `pi-vcs`, `pi-vfs`, `pi-voice`,
`pi-walker`. Bun/TS packages: `coding-agent` (the surface), `metaharness`,
`mnemopi`, `snapcompact`, `agent`, `stats`, `tui`, `wire`, `catalog`.

## Core facts per arm (audited)

**02 tools.** 30 built-in tool names as a const list
(`packages/coding-agent/src/tools/builtin-names.ts:1-32`) + 3 hidden
(`think/yield/goal`, `:36`; root README's "31" claim disagrees — unverified).
`createTools` resolves/constructs/registers into `session.toolRegistry`
(`.../tools/index.ts:554-591,831-861`); settings gate each tool
(`:96-105`). Tool definition is rich: `AgentTool` extends `Tool` with label,
TypeBox parameters, execute, renderCall/renderResult hooks, an **approval tier
declaration** (read|write|exec, exec default), `loadMode` essential/discoverable,
`docTopics` (`xd://` links), per-call concurrency (shared/exclusive), and
speculation policy (`packages/agent/src/types.ts:1129-1243`). Descriptions are
rendered from static `.md` templates via a dynamic getter (`.../tools/read.ts:975-996`).
Tool prompts never inline (`AGENTS.md` "Prompts never in code"). Rust side:
`pi-natives` = PTY/grep/diff/EditStore/snapcompact.rs bindings;
`pi-edit` = patch engine; `pi-shell` = in-process bash host **with vendored
uutils coretools (`pi-builtins`) — a real Unix environment**; `pi-edit`+`pi-shell`
compose the editing/shell backbone
(`crates/pi-shell/Cargo.toml:18`; `crates/pi-builtins/src/`). MCP: `mcp__<server>_<tool>`
names, 64-char cap, deduped transforms before registry reconciliation
(`.../mcp/tool-bridge.ts:428,468-491`; `session/session-tools.ts:2231-2264`).

**Gate (02/07).** Tier × policy per tool: user-overridable `allow|deny|prompt`
per tool; modes `always-ask | write | yolo`; missing context **fails closed**
to always-ask (`.../tools/approval.ts:17-18,53-84,100`). Extension hooks wrap
every call (`extensibility/hooks/tool-wrapper.ts`).

**03 subagents.** The `task` tool; agent definitions discovered from bundled +
`~/.omp/agent/agents/*.md` + `.omp/agents/*.md` (`.../task/index.ts:4-10`,
`task/discovery.ts`). `SpawnRun` holds a semaphore permit, streams progress,
adopted by the owner on abort/binding (`task/spawn-run.ts:1-9,47-88`);
**speculative launch** starts children while the `tasks[]` arguments are still
streaming (`task/speculative-launch.ts`). Isolation: pinned child settings,
advisor forced off, **mid-turn compaction forced on** (whole assignment = one
turn), isolated runs get their own **worktree** and may not expose roots outside
it (`task/executor.ts:1132,4033-4055,4339`; `docs/compaction.md:76`). Structured
children always get `yield`; depth-limited recursion (`task/index.ts:45`).
`autoresearch` is a hillclimb/eval loop with dashboard + own git branch — no
spawn refs found (**unverified** whether it uses task).

**05 context.** Compaction triggers post-turn above
`resolveThresholdTokens`, mid-turn before requests, idle, and on
overflow-recovery (`.../session/session-maintenance.ts:626,2147,2246,2412`).
`compaction.methodOrder` strategy ladder: LLM summarize (regular/handoff), `shake`
(local mechanical elision to `artifact://` refs), `snapcompact`
(`docs/compaction.md:202-215`). **Snapcompact = deterministic, no LLM**:
discarded history serialized with caps into provider-aware PNG bitmaps
(fonts per provider family), persisted and re-attached each rebuild
(`packages/snapcompact/README.md:3-29,44-68`). Sizing: archive gets half the
headroom; kept context ≤ 60% of threshold, target ≤ 80%
(`docs/compaction.md:217,221`). Cache care: pruned outputs blanked only within
the model's `prompt-cache-lookback` bound (`docs/compaction.md:248`); summary
drops whole call/result pairs (`:250`); **byte-stable system prompt between
turns is a session invariant** (`session/agent-session.ts:2607`).
`compress/` is unrelated — a separate "dense prompt register" rewriter
(`compress/index.ts:2-11`).

**06 memory.** Five `memory.backend` modes: off | local | hindsight | mnemopi |
sharpshooter (`docs/memory.md:3-11`). Injection = Memory Guidance block at
session start from a project summary; outputs are per-project `MEMORY.md` +
lessons + `skills/` on disk. Pipeline: startup background job, two phases
(per-session extraction → global consolidation with lease+heartbeat; skipped
for subagents), SQLite job queues (`memories/index.ts:29-67`; `docs/memory.md:74-89`).
Injection budget shares 5000 tokens (summary+lessons, `docs/memory.md:132`);
`learn` lessons capped 100 × 2000 chars and redacted (`docs/memory.md:70`).
`hindsight` = remote vector service; recall on first turn, auto-retain every N
turns (`hindsight/state.ts:385-388`). `mnemopi` = local SQLite working/episodic
engine + `memory://` read protocol; user-facing tools `recall/retain/reflect/
memory_edit` (`packages/mnemopi/README.md:5-8`; `docs/memory.md:34-46`).
Written on minutes/days cadence — not immediately at task end.

**07–09 briefs.** `judgment/` resolves a Judge model role for typed judgments
(`judgment/index.ts:1-10`); `capability/` is the provider/extension loading
registry. Execution: inside-process unix env via pi-shell, always
non-interactive env (pagers off, TERM=dumb) (`exec/non-interactive-env.ts:6-25`);
no OS-level sandbox located (**unverified**). `omp stats` = local usage
dashboard, live ingest, port 3847 (`packages/stats/README.md:3,9,31-35`).
