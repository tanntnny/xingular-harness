---
id: ADR-0073
title: A large, content-block reporting prompt
status: superseded
created: 2026-11-01
updated: 2026-11-01
superseded_by: ADR-0074
supersedes: partial — ADR-0068 (its required headings and fixed-label rule)
amends: ADR-0008 (flexible headings stand; required content blocks are added)
related:
  - ADR-0008
  - ADR-0068
  - ADR-0072
  - STUDY-0006
---
# ADR-0073 — A large, content-block reporting prompt

> **Superseded by [ADR-0074](ADR-0074-report-content-not-report-blocks.md):** the four required
> blocks, the "Nothing needed" ending, the five examples and the 18,000-character budget are
> replaced by content questions, an evidence line, an optional by-hand block and free headings.

## Context

The person reading final replies asked for three things the 3,400-character `reporting` section did
not give: headings that fit the content, a "how to test" block, and a clear next step. A forensic
pass on run `07974d6e` showed the structured report existed at seq 222, but the section was thin
enough that a terse follow-up could replace it, and it carried no example of what a good report looks
like.

The peer study in [STUDY-0006](../study/STUDY-0006-reporting-prompts.md) found:

- Claude Code leads with the outcome, drops preamble and recap, answers a simple question in one to
  three sentences, and keeps safety-critical detail complete. Its extracted reporting rules name the
  next action, use absolute paths, quote only load-bearing snippets, and treat the final message as
  the report.
- Codex keeps per-model prompt files of 6.6k–24k characters, so a large reporting section is within
  the norm it sets.
- Kimi CLI has no final-report shape at all; a large prompt is an authored choice, not a universal
  convention.

The old section mandated three headings (`## Beyond what you asked`, `## Differences from the plan`,
`## What would make this complete`) and no test or next-step block. It had no examples.

## Decision

Replace `REPORTING_GUIDANCE` with a ~15.8k-character text in
[`src/prompt/reporting.ts`](../../src/prompt/reporting.ts), imported by
[`src/prompt/compile.ts`](../../src/prompt/compile.ts). Raise `REPORTING_BUDGET` to 18,000 so the
section is never cut, and keep it last in the stable prefix.

The text keeps the outcome-first rule and defines **content blocks, not heading names**:

- Required for a change: outcome, what changed, how to test, what to do next.
- Optional when they apply: beyond the request, departures from the plan, unverified or needs a
  person, open questions.
- Headings are the model's choice. The guidance lists synonyms ("How to test", "Try it", "Verify")
  and says the requirement is the information, not the label.
- Five worked examples: a small change, a multi-file change with extra work, a blocked change, a
  research answer, and a one-line question. An anti-pattern table and a pre-send checklist follow.

"How to test" is required only for a change. It gives numbered steps, exact commands or URLs, the
expected result, what the agent already ran, and what the person must run. "What to do next" names
the person's action or says "Nothing needed". Pure research and one-line questions stay short and
carry no test block.

## Consequences

- The stable prefix grows by about 12.4k characters (roughly 3.5k tokens). Every session pays it
  once; the provider cache covers later requests, and the first request after an upgrade misses the
  cache. The cost is measured with real application requests only, under INV-PRM-8.
- [`src/prompt/compile.test.ts`](../../src/prompt/compile.test.ts) now checks the content blocks,
  the five examples, the size range, and that the section is not cut; the exact old phrases are gone.
- The spec ([04-prompt.md](../architecture/04-prompt.md)) and the old ADRs are updated; the three
  old headings become examples, not requirements.
- A shorter or different report shape for one variant is a variant prompt change through refinement,
  not configuration of this section.

## Alternatives

- **8k characters, three examples.** Rejected: the person chose the 16k balance for enough rules and
  examples to cover the shapes.
- **24k characters, eight examples.** Rejected for now: the largest prefix; the 16k text covers the
  five shapes the person named.
- **Keep the three fixed headings.** Rejected: fixed labels are what made the report rigid, and the
  person asked for headings that fit the content.
- **Move the examples to a skill.** Rejected: the guidance must shape every reply without a second
  load, and the person asked for the prompt itself to carry the rules and examples.
- **Always require the test and next blocks, even for a question.** Rejected: the person chose
  changes only, so a one-line question stays one to three sentences.
