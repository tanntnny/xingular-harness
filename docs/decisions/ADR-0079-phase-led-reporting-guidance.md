---
id: ADR-0079
title: Phase-led flexible reporting guidance
status: accepted
created: 2026-11-02
updated: 2026-11-02
amends: ADR-0076 (report phases, reader context, verification honesty, subagent reports and headings)
related:
  - ADR-0076
  - STUDY-0009
---
# ADR-0079 — Phase-led flexible reporting guidance

> Amends [ADR-0076](ADR-0076-codex-final-answer-verbatim.md): keep its self-contained, outcome-first
> report and flexible structure, while strengthening the reader, evidence, heading and subagent
> guidance based on [STUDY-0009](../study/STUDY-0009-claude-code-reporting.md).

## Context

The study compared Claude Code's external and internal prompt phases with the Harness reporting
section. It found three useful gaps: the Harness did not explicitly help a reader who has lost the
thread, did not say directly how to report checks that were not run or failed, and gave subagents no
caller-facing report contract. The in-flight progress sentence also appeared in both `writing` and
`reporting`, although `reporting` shapes the final answer.

The user asked for phase-led final-report guidance and frequent Markdown `#` / `##` headings such as
"What changed", "Checks" and "Things to know", while explicitly rejecting a fixed heading vocabulary.

## Decision

- Keep the final reply self-contained, outcome-first, evidence-led and scaled to the work. Organize
  the guidance in final-report order: reader and purpose, opening, body, evidence and honesty,
  person-owned next step when one exists, headings, lists and tables, length, references and
  formatting, then examples and pre-send review. Follow citation and file-link rules already
  supplied by the active session or host. Pre-tool narration and in-flight updates remain in their existing prompt section;
  remove only the duplicate progress-update sentence from `reporting`. Do not add an away-recap
  surface or numeric word caps.
- Add the cold-reader test: assume the person may have stepped away and lost the thread; give enough
  context to pick the work back up and match the explanation to cues about their experience.
- State verification honestly. Say when a check was not run, never imply that it passed, report
  failures with relevant output, and state passes plainly.
- When writing as a subagent, give the caller a concise account of work done and key findings. The
  caller integrates and relays it. Include absolute paths and useful evidence, snippets only when
  exact text is load-bearing, and no recap of code merely read.
- For substantive replies with distinct parts, often use Markdown headings: a `#` title when useful
  and `##` headings for meaningful sections. Choose labels from the reply's actual content. Examples
  such as "What changed", "Checks" and "Things to know" are optional wording, not a fixed list or
  template. Short replies may stay in prose; headings are never forced and empty sections are not
  added.
- Revise one worked example to demonstrate a content-specific `#` / `##` structure and retain a
  short heading-free example. Keep the 12,000-character reporting budget.

## Consequences

- Reporting behavior changes the stable prompt prefix. Existing live terminal sessions retain the
  pack they started with; new sessions receive the updated text. Cache reuse after the prefix change
  must be measured only with real application requests and the account owner's permission
  (INV-PRM-8).
- No storage, server protocol or tool capability changes.
- The guidance favors headings for substantial multi-part reports without prescribing section names
  or forcing headings on simple replies.

## Alternatives

- **Require a fixed set of report headings.** Rejected: the user wants headings chosen for the
  content, and fixed labels become a template.
- **Keep reports prose-only unless a heading is requested.** Rejected: substantial reports should
  use headings often enough to make their parts easy to find.
- **Move progress updates or add an away recap to reporting.** Rejected: in-flight updates already
  belong in `writing`, and this harness has no away-recap surface.
- **Adopt Claude Code's numeric word limits.** Rejected: the study did not establish their quality
  effect for this Harness.
