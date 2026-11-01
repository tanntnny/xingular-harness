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
| Codex | Repository listing, [openai/codex `codex-rs/core`](https://github.com/openai/codex/tree/main/codex-rs/core) (checked 2026-11-01) | Per-model prompt files of 6.6k–24k characters (`gpt5codexprompt.md` 6,647; `gpt-5.2-codexprompt.md` 7,589; `gpt51prompt.md` 24,204; `gpt52prompt.md` 21,652). Its final-answer wording is measured below from `models.json`. |
| Kimi CLI | [external/kimi-cli/src/kimi_cli/agents/default/system.md](../../external/kimi-cli/src/kimi_cli/agents/default/system.md) | No final-report format. The prompt says to inform the user that the task completed or failed, or to ask for more information; the shape is left to the model. |
| This harness | [src/prompt/reporting.ts](../../src/prompt/reporting.ts), [04-prompt.md](../architecture/04-prompt.md) | ADR-0076: ~3.7k characters. Codex's final-answer and technical-communication text: self-contained, outcome first, change/why/tested/risks, evidence summarized, tables, length by complexity, two examples. |

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

## Codex's prompt measured

Checked 2026-11-01 against `openai/codex` at `126a0ee` (2026-10-26). The prompts now live in
`codex-rs/models-manager/models.json` as `model_messages.instructions_template`; the `gpt-6.1-sol`
template is 21,769 characters, 4,212 tokens (o200k). `## Final answer` with its
`### Formatting rules` and `### Visualizations` subsections is 453 tokens, and
`## Intermediate commentary` adds 216: Codex spends 669 tokens (16%) on the text of its replies.
Its tone rules sit outside that block, in `## Writing style` (442) and
`## Technical communication` (190).

| Prompt | Characters | Tokens (o200k) | Share of its own prompt |
|---|---:|---:|---:|
| Codex `## Final answer` (with formatting and visualizations) | 2,318 | 453 | 10.8% |
| Codex final answer plus intermediate commentary | 3,413 | 669 | 15.9% |
| This harness's `reporting` section, ADR-0073 (superseded) | 15,808 | 3,736 | ~54% of a ~6.9k-token prefix |
| This harness's `reporting` section, ADR-0074 (superseded) | 8,921 | 2,108 | ~40% of a ~5.3k-token prefix |
| This harness's `reporting` section, ADR-0076 | 3,697 | 792 | ~20% of a ~4.0k-token prefix |
| The three worked examples inside it | 1,777 | 425 | 20.2% of the section |

ADR-0073's four required blocks did not survive use. Replies listed the agent's own commands —
`npm run typecheck — passed`, `npm test — 212 test files passed` — under a heading meant for the
person's testing, ended with "Nothing needed next", and reused "What changed / How to check / Next
step" on unrelated work. ADR-0074 replaced the blocks with content questions, made the by-hand
section optional and human-only, banned the filler ending, and cut the text to 8,921 characters
(2,108 tokens). The Codex numbers above are the baseline that made a large section defensible; the
failure was in what the blocks asked for, not in their size.

ADR-0076 then adopted Codex's wording for the report. The section is 3,697 characters, 792 tokens:
1.7 times Codex's final-answer block and 19% of Codex's 4,212-token prompt. It is no longer the
largest fixed section; the ranking and the remaining budget are recorded in
[04-prompt.md](../architecture/04-prompt.md). The section keeps one advantage over Codex's: a login
that blocks the work is answered with the exact command, in `autonomy` and in the blocked-publish
example.

The 6.6k–24k character sizes in the peer table above describe the per-model `*prompt.md` files that
earlier listings named; the prompt source has since moved into `models.json`, so those sizes are not
the text measured here.

## What could not be verified

- Claude Code's prompt is a third-party extraction from the compiled package, not an Anthropic
  publication. The official output-styles page was used for the Default and Concise behavior; the
  extracted prompts are cited as a secondary source and versioned by `ccVersion`.
- The research pass did not measure how often each peer's reports carry a test block. The study
  describes instructions, not observed output.

## Design implications

1. Keep the section foundation-owned and stable; no variant or application should have to repeat it.
2. Define content questions, not fixed blocks or headings; the four block names are gone.
3. Treat the agent's runs as one line of evidence, not steps for the person; a by-hand check covers
   only what a person alone can do, and is absent when nothing needs one.
4. Spend the prompt budget on rules, an anti-pattern table and three worked examples; measure the
   cache cost with real requests ([INV-PRM-8](../architecture/04-prompt.md)).
5. Keep the reply short: a question stays one to three sentences, and the change report leads with
   the outcome and the person's check.

## Sources

- [Claude Code: Output styles](https://code.claude.com/docs/en/output-styles), fetched 2026-11-01.
- [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts),
  `README.md` and the two extracted prompt files linked above, fetched 2026-11-01.
- [openai/codex `codex-rs/models-manager/models.json`](https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json),
  `model_messages.instructions_template` of `gpt-6.1-sol`, fetched 2026-11-01.
- [openai/codex `codex-rs/core`](https://github.com/openai/codex/tree/main/codex-rs/core), directory
  listing fetched 2026-11-01.
- [external/kimi-cli/src/kimi_cli/agents/default/system.md](../../external/kimi-cli/src/kimi_cli/agents/default/system.md),
  read from the clone.
