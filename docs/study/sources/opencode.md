# Source: opencode

- Origin: [sst/opencode](https://github.com/sst/opencode), the coding agent this
  harness family uses day-to-day. TypeScript/Bun monorepo.
- Local clone: `external/opencode` (shallow, cloned 2026-10-21).
- Why studied as an anchor: battle-tested open harness; this harness already borrows
  its mental model of sessions/agents/tools, so deltas are cheap to evaluate.

## Verified layout

- `packages/core/src/` — the harness core. Observed top-level: `agent.ts`,
  `permission.ts`, `mcp.ts`, `filesystem.ts`, `instructions` dir,
  `instruction-discovery.ts`, `compaction`? (not yet verified below alphabet
  cut), `codemode/`, `config/`, `event-logger.ts`, `persistent-pty.ts`,
  `models-dev/`, `job.ts`, `kv.ts`.
- `packages/` of interest beyond core: `agent`, `cli`, `plugin`,
  `plugin-browser`, `plugins`, `server`, `session-ui`, `tui`, `codemode`,
  `httpapi-codegen`, `protocol`, `sdk`.
- AGENTS.md at repo root states their engineering expectations.

## Map to arms (pending verification per claim)

- Arm 01 (prompt): `instructions/`, `instruction-discovery` — AGENTS.md-style
  instruction discovery; ayurveda of stable/dynamic sections unknown.
- Arm 02 (tools): built-in tool set + MCP (`mcp.ts`) + tool providers via plugins.
- Arm 03 (subagents): `agent.ts` — primary/secondary agents by description.
- Arm 04 (skills): plugins and community plugins; the `plugins/` package.
- Arm 05 (context): compaction (verify location), message queueing.
- Arm 06 (memory): no first-class memory beyond instructions; community plugins.
- Arm 07 (governance): `permission.ts` — permission model, per-tool approval modes.
- Arm 08 (execution): `persistent-pty.ts`, `terminal/` package, containers package.
- Arm 09 (observability): `event-logger.ts`, events bus (`bus.ts`), TUI
  trajectories.

## Open questions for the audit

1. Where is the session system prompt assembled, and is any of it cache-stable?
2. How do tool descriptions reach the model: generated, hardcoded, or provider
   overridable?
3. What compaction exists in core, and is it triggered in-band?
4. How does the permission model express "always/deny/ask" per tool and per
   pattern?
5. What do plugin tool providers get access to (context object shape)?
