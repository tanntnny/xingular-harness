# STUDY-0006 — How peer harnesses shape the final report

Status: **checked published docs and extracted prompts**, no contract change. Feeds
[ADR-0073](../decisions/ADR-0073-large-reporting-prompt.md) and extends
[STUDY-0004](STUDY-0004-turn-end-controls.md), which covers when a turn ends rather than what the
last message contains.

## The question

The person reading this harness's reports asked for three things:

1. Headings that fit the content, not a fixed set of labels.
2. A "how to test" block, and the other information a person needs to act.
3. A clear next step for the person.

What do Claude Code, Codex and the other studied harnesses put in their prompt to produce that
shape, and how much prompt space do they spend on it?

## What this harness did before ADR-0073

`REPORTING_GUIDANCE` was 3,400 characters: 14 bullets, three required headings
(`## Beyond what you asked`, `## Differences from the plan`, `## What would make this complete`), no
required test or next-step block, and no examples. The three headings came from
[ADR-0068](../decisions/ADR-0068-scope-and-completion-report.md); the flexible-heading rule came from
[ADR-0008](../decisions/ADR-0008-flexible-reporting-guidance.md). The section is stable-prefix text
for every session and every application.

## What peers do

| Peer | Evidence | Shape of the instruction |
|---|---|---|
| Claude Code | Official docs, [Output styles](https://code.claude.com/docs/en/output-styles), checked 2026-11-01 | Default and Concise styles: the first sentence states what happened; no preamble, narration or closing recap; a simple question is answered in one to three sentences; error reports, failing test output, security warnings and destructive-action confirmations stay complete. Output styles are session-level, not a fixed report template. |
| Claude Code | Extracted prompt, [Away summary generation](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/agent-prompt-away-summary-generation.md) (third-party extraction, `ccVersion` 2.1.173) | Recap in under 40 words, one or two plain sentences, no markdown: the overall goal, the current task, then the one next action; skip root-cause narrative and secondary to-dos. |
| Claude Code | Extracted prompt, [Subagent reporting notes](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/main/system-prompts/agent-prompt-subagent-reporting-notes-lean-rewrite.md) (third-party extraction, `ccVersion` 2.1.301) | The final message is the report; absolute paths; code snippets only when the exact text is load-bearing; do not recap code that was read. |
| Codex | Repository listing, [openai/codex `codex-rs/core`](https://github.com/openai/codex/tree/main/codex-rs/core) (checked 2026-11-01) | Per-model prompt files of 6.6k–24k characters (`gpt5codexprompt.md` 6,647; `gpt-5.2-codexprompt.md` 7,589; `gpt51prompt.md` 24,204; `gpt52prompt.md` 21,652). The exact final-answer wording could not be fetched: the raw files returned 404, so it is **unverified**. |
| Kimi CLI | [external/kimi-cli/src/kimi_cli/agents/default/system.md](../../external/kimi-cli/src/kimi_cli/agents/default/system.md) | No final-report format. The prompt says to inform the user that the task completed or failed, or to ask for more information; the shape is left to the model. |
| This harness | [src/prompt/reporting.ts](../../src/prompt/reporting.ts), [04-prompt.md](../architecture/04-prompt.md) | ADR-0073: ~15.8k characters, content blocks, required test and next-step blocks for changes, five examples. |

### What the peer evidence supports

- **Large prompt, short output.** Codex spends 6.6k–24k characters on a model prompt, and Claude
  Code's Concise style asks for one to three sentences on a simple question. The two are not in
  conflict: the prompt carries rules and examples; the reply stays economical.
- **"Next action" is named explicitly.** Claude Code's away summary names the one next action and
  skips secondary to-dos. This is the block the person asked for.
- **Evidence beats adjectives.** Claude Code asks for load-bearing snippets and the exact outcome;
  its Docs describe full test output and error reports as required content. This supports replacing
  "all tests pass" with a command and a count.
- **No single template.** Kimi has no shape; Claude Code changes shape by output style; Codex's
  per-model files differ. A fixed heading list is this harness's own invention, not a peer norm.

## What could not be verified

- Codex's exact final-answer rules: the raw prompt files in `openai/codex` returned 404 through the
  fetch path; only the file names and sizes are verified.
- Claude Code's prompt is a third-party extraction from the compiled package, not an Anthropic
  publication. The official output-styles page was used for the Default and Concise behavior; the
  extracted prompts are cited as a secondary source and versioned by `ccVersion`.
- The research pass did not measure how often each peer's reports carry a test block. The study
  describes instructions, not observed output.

## Design implications

1. Keep the section foundation-owned and stable; no variant or application should have to repeat it.
2. Define required **content blocks**, not fixed headings; the old three headings become examples.
3. Make "how to test" and "what to do next" required for a change, with a one-line fallback when
   nothing is user-visible or nothing remains.
4. Spend the prompt budget on rules, anti-patterns and five worked examples; measure the cache cost
   with real requests ([INV-PRM-8](../architecture/04-prompt.md)).
5. Keep the reply short: a question stays one to three sentences, and the change report leads with
   the outcome and the test block.

## Sources

- [Claude Code: Output styles](https://code.claude.com/docs/en/output-styles), fetched 2026-11-01.
- [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts),
  `README.md` and the two extracted prompt files linked above, fetched 2026-11-01.
- [openai/codex `codex-rs/core`](https://github.com/openai/codex/tree/main/codex-rs/core), directory
  listing fetched 2026-11-01.
- [external/kimi-cli/src/kimi_cli/agents/default/system.md](../../external/kimi-cli/src/kimi_cli/agents/default/system.md),
  read from the clone.
