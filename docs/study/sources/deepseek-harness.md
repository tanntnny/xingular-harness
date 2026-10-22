# Source: deepseek-harness (dsh)

- Origin: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
  released Aug 2026, MIT, developer preview (compatibility-breaking expected).
  Built on the Cordis meta-framework ("spatiotemporal composability"); one radical
  claim: **everything is a plugin** — model adapters, tool registry, session log,
  sandboxes, and the agent loop itself have no privileged core.
- Local clone: `external/deepseek-harness` (205 MB).
- Status: **arm-01 audited; arms 02–06 audited** (explorer report; verified spot
  checks pending — treat claims below as explorer-verified until I re-read).

## Verified layout

`packages/` (arm-shaped): `acp`, `api`, `attachment`, `boot`, `browser-use`,
`bundle`, `client`, `compaction`, `computer-use`, `context`, `core` (with
`packages/core/tools`, `packages/core/system-prompt`, `packages/core/agent-loop`),
`credentials`, `deliverables`, `fs`, `guard`, `host`, `identity`, `interaction`,
`jobs`, `llm`, `lsp`, `mcp`, `plan`, `preset`, `ptc-runtime`, `sandbox`,
`schedule`, `session`, `session-query`, `settings`, `shell`, `skill`, `spill`,
`ssh`, `storage`, `subagent`, `subprocess`, `telemetry`, `terminal`, `todo`,
`util`, `web`, `workflow`, `workspace`.

## Core facts per arm (audited)

**02 tools.** Canonical registry is `ctx.tools` (dsh-tools), not the loop:
declaring a tool via `defineTool` makes it visible, and ToolRuntime feeds the
system prompt automatically (`packages/core/tools/README.md:30,34-62`;
`packages/core/tools/src/index.ts:857`). Two presentation modes: `native`
(all schemas) vs `ptc` (models see only `run_code` + generated SDK — programmatic
tool calling), with per-agent `presentAs` override
(`packages/core/tools/README.md:68-81`). Plain restriction API:
`ctx.tools.restrict(filter)` allow/deny masks that intersect and lift on dispose
(`README.md:85`). **The gate is inside dsh-tools**, a fixed pipeline:
`tools/pre-execute` (allow/deny/ask) → monotonic `ctx.tools.guard()` reasons →
`tools/execute` → `tools/post-execute` → observe-only `tools/result`
(`README.md:89,109`; ask at `packages/core/tools/src/index.ts:608-612,1513-1527`).
`packages/guard` is *not* the gate — it is loop hygiene (repeat-tool reminder,
timeout policy). `toolOrder` is validated config: explicit model-facing order,
exactly one `<unlisted-tools>` rest entry, unknown names fail assembly
(`packages/core/system-prompt/README.md:50-52,179`). Bundle = profile patch
layer stacked over `dsh-base`, which ships a default wallet policy confining
file writes and asking before risky actions
(`packages/bundle/README.md:12`, `packages/bundle/base/README.md:50`).

**03 subagents.** `ctx.subagents` + provider backends + tool plugins
(`packages/subagent/README.md:27-35`). Spawn returns immediately with
`started subagent <childId>`; completion notice delivered later
(`tool-subagent/README.md:59`). Two kinds: fresh child (`spawn`) vs `fork`
seeded from the parent's completed history (`README.md:28-29`); local children
are continuable; external backends (ACP/Codex/Claude Code) "execute once"
(`README.md:12,61`). Capacity defaults: 8 active, depth 1
(`subagent/src/README.md:53,49`). **No description-based auto-routing** in dsh —
the model names a preset from an enum allowlist (`tool-subagent/README.md:52,68`).

**04 skills.** Progressive disclosure: before the first request the model gets a
durable catalog of names + capped descriptions (default cap 500 chars), and
loads full body via the `skill` tool; `/name` invocation injects the same
instructions (`packages/skill/tool-skill/README.md:12,54-56`); catalog changes
append a complete replacement; empty catalog retires names
(`:57`).

**05 context.** `compaction-basic` triggers at
`floor(min(W×0.8, W−O−headroom))` with 65_536 headroom, keeps the newest 16%,
one extra model request, only the summary retained
(`packages/compaction/compaction-basic/README.md:12,32,62-68`; `config.ts:75-78`);
oversized tool outputs pruned first, image placeholders swapped for offloaded
images (`packages/compaction/README.md:31-32`). `session-query` = SQLite FTS5
search over the durable log, independent of compaction
(`packages/session-query/README.md:12,30`).

**06 memory.** No memory package by design. Durables: immutable canonical JSONL
sessions with checkpoint policy (`packages/session/README.md:38-39`), todo lists
persisting across sessions (owned by the session, whole-list replace,
`packages/todo/README.md:12`), `spill` = full text stored outside context with
locator + retrieval guidance (`packages/spill/README.md:12,30-31`),
`storage` = non-session app data, never model-visible
(`packages/storage/README.md:12,27-30`), `deliverables` = per-turn outputs as
client-only session events with `workspace/changes` derived from git snapshots
(`packages/deliverables/README.md:12,27-28`). Cross-session agent memory:
unaddressed.

**07–09 briefs.** Sandbox = file-effect policy classes
(read-only/workspace-write/danger-full-access) with Landlock/Seatbelt/Windows
backends and one-time approved escalation (`packages/sandbox/README.md:12,30`);
one shell executor per composition (`packages/shell/README.md:12,38`); one
`ctx.subprocess` service with bounded output and scrubbed env
(`packages/subprocess/README.md:12,27`); telemetry is an OTel transport with
`FEEDBACK_ONLY` default (`packages/telemetry/README.md:12,25`,
`packages/bundle/base/README.md:50`).

## Open questions, answered

1. Tool plugin interface → `defineTool` + `ctx.tools` registry; schemas flow to
   the prompt via ToolRuntime's self-registration.
2. `guard` → not the approval mechanism; gate = `tools/pre-execute` pipeline in
   dsh-tools.
3. `ptc-runtime` → programmatic tool calling: models get exactly `run_code` plus
   a generated SDK; executionInstructions carry syntax/state guidance.
4. `spill` → out-of-context storage returning locators; feeds compaction policy.
5. `acp` → Agent Client Protocol islands (one of several subagent backends).
6. Plugin prompt contributions → ordered sections incl. `.tools()` providers;
   ordering is a validated contract (see arm 01).
