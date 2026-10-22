# Source: Claude Code (Anthropic) — no local code

- Origin: [Anthropic Claude Code](https://www.anthropic.com/claude-code). Not open
  source: no clone. Material to audit: the npm package (`@anthropic-ai/claude-code`,
  bundled JS — inspect for system prompt and tool descriptions), Anthropic's
  engineering blog posts on Claude Code (agent loop, harness internals, sub-agent
  guidance, compaction), the skills spec (agent skills API), and observed CLI
  behavior (`/hooks`, `Permission` modes, CLAUDE.md hierarchy, memory
  instructions).
- Why studied: the de-facto reference for UX-shaped harness conventions — CLAUDE.md
  hierarchy, skills, subagents as first-class configs, hook events, plan mode,
  permission modes. Every other harness in this study copies it knowingly or not.

## Map to arms (from public, verifiable material — no code claims)

- Arm 01 (prompt): CLAUDE.md hierarchy (enterprise/user/project/local), `@file`
  imports, `#` quick-memory, output styles forcing; the leak-history repo
  (community) documents the shipped system prompt — cite carefully, it changes.
- Arm 02 (tools): bundled tools w/ rich descriptions ("use when…" instructions
  live in tool descriptions, not the prompt); MCP support.
- Arm 03 (subagents): `.claude/agents/*.md` subagent files w/ own name/description/
  toolset/model; auto-delegation by description matching.
- Arm 04 (skills): SKILL.md progressive disclosure (name+description only loaded;
  body read on demand), script support.
- Arm 05 (context): compaction thresholds, `--continue/--resume`, context restore
  via note files.
- Arm 06 (memory): `CLAUDE.local.md`, `#` memory notes, user memory file.
- Arm 07 (governance): permission modes (default/acceptEdits/plan/
  bypassPermissions), allow/deny rules patterns, hooks (PreToolUse/PostToolUse)
  as policy handlers, sandboxed bash per platform.
- Arm 08 (execution): bash w/ working-dir constraints; desktop app tooling.

## Open questions for the audit (each needs its citation landing)

1. SKILL.md spec: exact progressive-disclosure contract; compare against this
   harness's skill loader c7/c8 + trust requirements.
2. Hooks: which events exist, do they mutate tool input (``PreToolUse`` update
   semantics) — contrast with the here-rule "a hook is told, never asked".
3. Subagent file spec: fields, tool inheritance, model pinning; our extension
   point answer.
4. Plan mode mechanics (bilateral approval) — how does its gate differ from our
   refinement probes (answer-free, no world effect).
5. Verbatim from a recent npm bundle: capture current system prompt + tool
   descriptions and date-stamp them.
