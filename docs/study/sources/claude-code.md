# Source: Claude Code (Anthropic) — v2.1.88 source, leaked

- Origin: [Anthropic Claude Code](https://www.anthropic.com/claude-code). Not open source. On
  2026-03-31 the npm package `@anthropic-ai/claude-code` 2.1.88 shipped `cli.js.map`, whose
  `sourcesContent` is the complete TypeScript source; the package was pulled within hours and the
  source was widely mirrored. Anthropic's own toolchain is the suspected cause (a Bun issue about
  source maps served in production builds, [oven-sh/bun#28001](https://github.com/oven-sh/bun/issues/28001)).
- Local code: `external/claude-code-src` (clean `src/` tree, 1,884 `.ts`/`.tsx` files) and
  `external/claude-code-sourcemap` (the original npm tarball, unpacked `package/`
  with `cli.js` + the 57 MB map, and `restored-src/src`, 512,664 lines). Both are gitignored.
- Licence: the leaked code carries no grant ("SEE LICENSE IN README.md"). Read it for study; do not
  vendor or reuse it.
- Why studied: the de-facto reference for UX-shaped harness conventions — CLAUDE.md hierarchy,
  skills, subagents as first-class configs, hook events, plan mode, permission modes. Every other
  harness in this study copies it knowingly or not.

## What the source now answers

- Prompt assembly: `src/constants/prompts.ts` — `getSystemPrompt` returns an array of strings with
  `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`:114`) splitting globally cacheable text from per-session text;
  a section registry (`constants/systemPromptSections.ts`) holds cached and `DANGEROUS_uncached`
  entries. Measured in [STUDY-0007](../STUDY-0007-claude-code-prompt.md).
- Subagent prompt: the parent prompt plus `enhanceSystemPromptWithEnvDetails` (`prompts.ts:760`),
  and per-agent text in `src/tools/AgentTool/built-in/*`.
- Memory: `src/memdir/` — `MEMORY.md` entrypoint capped at 200 lines / 25 KB (`memdir.ts:35`),
  typed-memory sections, and a KAIROS daily-log mode.
- Compaction: `src/services/compact/` — auto-compact with a 3-failure cap (`autoCompact.ts:70`),
  function-result clearing, cached micro-compact.
- Tools: one `prompt.ts` per tool under `src/tools/*/`, which is where most tool instruction lives
  rather than in the system prompt.
- Final-reply text: `# Output efficiency` (`prompts.ts:416`), `# Tone and style` (`:430`), the
  ant-only `# Communicating with the user` (`:405`), faithful reporting (`:240`), the subagent report
  sentence and notes (`:758`, `:765-768`) and the away-summary prompt (`services/awaySummary.ts:22`).
  Measured in [STUDY-0009](../STUDY-0009-claude-code-reporting.md).

## Map to arms

- Arm 01 (prompt): static/dynamic split for the cache, per-section registry, `# Environment`,
  output styles, language section.
- Arm 02 (tools): rich per-tool `prompt.ts` files ("use when…" lives there, not in the prompt).
- Arm 03 (subagents): built-in explore/plan/verification agents, `subagent_type`, fork mode.
- Arm 04 (skills): `/<skill-name>` shorthand, Skill tool, experimental discover-skills.
- Arm 05 (context): compaction thresholds, `--continue/--resume`, tool-result clearing.
- Arm 06 (memory): CLAUDE.md hierarchy plus auto-memory with line and byte caps.
- Arm 07 (governance): permission modes, allow/deny rules, hooks (PreToolUse/PostToolUse),
  `# Executing actions with care` (`prompts.ts:256`), native client attestation (`constants/system.ts`).
- Arm 08 (execution): bash with working-dir constraints, scratchpad directory, worktree sessions.

## Open questions

1. Hooks: which events exist, and do they mutate tool input (`PreToolUse` update semantics) —
   contrast with the here-rule "a hook is told, never asked".
2. Plan mode mechanics (bilateral approval) — how its gate differs from our refinement probes
   (answer-free, no world effect).
3. Undercover mode and anti-distillation (`utils/undercover.ts`, `services/api/claude.ts`) — what a
   product prompt is allowed to hide, and what this harness's `INV-BND-2` says instead.
