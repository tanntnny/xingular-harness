---
id: ADR-0076
title: Codex's final-answer guidance, adopted verbatim
status: accepted
created: 2026-11-01
updated: 2026-11-02
supersedes: ADR-0074 (its four content questions, human-check block, next-step block and examples)
amended_by: ADR-0079
related:
  - ADR-0074
  - ADR-0075
  - STUDY-0006
---
# ADR-0076 — Codex's final-answer guidance, adopted verbatim

> **Supersedes [ADR-0074](ADR-0074-report-content-not-report-blocks.md):** the four content
> questions, the human-check block, the next-step block, the evidence table, the anti-pattern table
> and the three examples are replaced by Codex's final-answer and technical-communication text.

> **Amended by [ADR-0079](ADR-0079-phase-led-reporting-guidance.md):** add the cold-reader test,
> explicit verification honesty, concise subagent reports and a preference for content-named `#` / `##`
> headings in substantial reports. The phase order is explicit; heading wording remains flexible.

## Context

ADR-0074 replaced four required blocks with four content questions, a one-line evidence rule, an
optional human-check block, a next-step rule and three examples. It removed the filler ending and
brought the section to 9,235 characters (2,188 o200k tokens).

A rule-by-rule comparison with Codex's `gpt-6.1-sol` prompt found that most of the autonomy and
permission text was already Codex's, word for word, while the report section carried the strictness:
18 prohibition phrases, 19 obligation words, a pre-send checklist and an anti-pattern table, against
Codex's 454-token `## Final answer` block, which mostly describes qualities and rendering.

The person chose Codex's wording for the report: self-contained final, technical communication,
evidence and limits, table guidance and length by complexity. They also added the model name to the
identity, adopted Codex's personality paragraph and unclear-scope sentence (with `ask_user`), and
adopted Codex's tool hygiene, test restraint and skill rules.

## Decision

- **Identity.** `harness-identity` carries the product name, `Launch.model` when the host knows it,
  and Codex's goal sentence: "You and the user share one workspace, and your job is to collaborate
  with them until their intended goal is completely handled." The model name is a stable-prefix
  line; a `/model` switch after the pack is compiled leaves it naming the model the session started
  with.
- **Personality.** A new standard section (`prompt/standard.ts`, order 22) carries Codex's
  personality paragraph, with "As Codex" changed to "As an AI agent" so the harness names no other
  product.
- **Unclear scope.** Codex's sentence replaces the harness wording: "If the user's intent or task
  scope is unclear, progress towards the user's goal with the information available and then ask the
  user for clarification while continuing independent work." A following sentence names `ask_user`
  for the question.
- **Reporting.** `REPORTING_GUIDANCE` becomes Codex's final-answer block and technical-communication
  paragraphs: self-contained, most important information, outcome first, what changed and why, how
  it was tested, material risks and limits, the evidence needed and its limits, verification
  summarized rather than listed, progress updates as learned/uncertain/next. Tables for mappings and
  comparisons. Headings stay free. A shape-by-work table says what different work needs. Length
  scales with complexity. Prose first, lists when the information is parallel or sequential. Two
  examples (a screen change, a blocked publish) and a four-line pre-send list replace the old
  blocks, the anti-pattern table and the three examples.
- **Removed from reporting.** The four content questions, "Your checks are evidence", "What only a
  person can check", "What the person does next", "What to leave out", "Tone", "Claims carry
  evidence" and the anti-pattern table. The exact command for a blocked login remains in
  `autonomy` and in the blocked-publish example.
- **Tools.** Codex's work rules join the Native guidance: `rg` first, no decorative command
  separators, shell text treated as code, no reused `$HOME`, no long blocking sleeps, no tests for
  reversible changes or tests that mirror the implementation, and broadening tests only when
  justified. Codex's skill rules (SKILL.md, user precedence, announce the first use, `$name`,
  missing skill) and its plugin principle join the Wiki guidance.
- `REPORTING_BUDGET` stays 12,000; the text is 3,697 characters (about 800 o200k tokens) and is
  never cut.

## Consequences

- The stable prefix shrinks by about 5.5k characters and 1.3k tokens. Existing sessions miss the
  provider cache once after the upgrade.
- The report no longer has a by-hand check block or a next-step block. A person reading a reply gets
  the outcome, the change, the evidence and the risks, and must notice when the reply leaves
  something undone; ADR-0075's removal of the todo gate already accepted that.
- The personality section adds a sixth standard section; the terminal and every host read the same
  text (INV-PAR-1).
- `Launch.model` is a new optional launch field; hosts that do not know the model get the identity
  without "based on".
- No data, storage or server-protocol change.

## Alternatives

- **Keep ADR-0074 and only trim the anti-patterns.** Rejected: the comparison showed the strictness
  was in the block structure itself, and the person chose Codex's wording.
- **Copy Codex's whole prompt.** Rejected: its channels, `update_plan`, `functions.exec`, apps and
  plugin mechanics do not exist in this harness; only the report, personality, permission and work
  rules apply.
- **Keep the human-check and next-step blocks alongside Codex's text.** Rejected: they were the two
  blocks the person asked to remove, and Codex's technical communication covers what remains.
- **Make the model name dynamic.** Deferred: a `/model` switch would need the identity in a dynamic
  section or a recompile, and both change the cache contract; the stable line is the simpler
  starting point.
