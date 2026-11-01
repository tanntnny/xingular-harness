---
id: ADR-0074
title: Report content, not report blocks
status: superseded
created: 2026-11-01
updated: 2026-11-01
superseded_by: ADR-0076
supersedes: ADR-0073 (its four required blocks, five examples and 18,000-character budget)
amends: ADR-0008 (human inspection is the only by-hand block)
related:
  - ADR-0008
  - ADR-0073
  - STUDY-0006
---
# ADR-0074 — Report content, not report blocks

> **Superseded by [ADR-0076](ADR-0076-codex-final-answer-verbatim.md):** the four content
> questions, the human-check and next-step blocks, the evidence table, the anti-pattern table and
> the three examples are replaced by Codex's final-answer and technical-communication text.

> **Supersedes [ADR-0073](ADR-0073-large-reporting-prompt.md):** the four required blocks, the
> "Nothing needed" ending and the 18,000-character budget are replaced.

## Context

ADR-0073 made a change carry four required blocks — outcome, what changed, how to test, what to do
next — and put both the agent's own runs and the person's steps inside "how to test". In real
replies the two merged: a section headed for the person's testing listed `npm run typecheck —
passed` and `npm test — 212 test files passed`, checks the person was never going to repeat. The
same guidance required "or say 'Nothing needed'", and replies ended with "Nothing needed next"
even when the work was complete and visible.

Headings also collapsed. The four block names and their synonyms ("How to test", "Test it", "Try
it", "Verify") gave the model one vocabulary, so unrelated work — a document, a diagnosis, a
publish — arrived under "What changed / How to check / Next step".

The person asked for three things: a by-hand section for checks only a person can make (a screen,
a sign-in, a diff or PR, a publish), no filler ending, and headings that follow the content. The
earlier design already had the principle: ADR-0008 made **Need human inspection** optional and said
not to use it "for checks already performed or generic risks". ADR-0073 folded that block into the
required set and lost the distinction.

## Decision

Replace `REPORTING_GUIDANCE` in [`src/prompt/reporting.ts`](../../src/prompt/reporting.ts) with a
~8.9k-character text (about 2.1k o200k tokens) that defines content questions rather than blocks:

- The reply answers what happened, what changed or was decided, what only a person can check, and
  what they do next — in any words and any order. Most replies answer two or three.
- The checks the agent ran are evidence: one line each, command and result. They are never steps
  for the person, and never appear in a section headed for the person's testing.
- A by-hand check is optional and covers only what the agent could not do: open a screen, sign in,
  read a document for tone, review or merge a diff, publish, deploy, use a device. It gives the
  shortest sequence, what to look at, and the result that means it works. When nothing needs a
  person, the block is absent — no "no manual check" line.
- A finished reply with nothing left ends on its last real point. "Nothing needed", "Nothing needed
  next" and "No action required" are banned.
- There is no required heading and no preferred set; the section gives cross-domain examples and a
  shape-by-work table, not a vocabulary, and says not to repeat one heading set.
- Three worked examples: a screen change, a backend change, a publish. The old examples' "Nothing
  needed next" endings are gone.

`REPORTING_BUDGET` falls from 18,000 to 12,000 characters. The section stays last in the stable
prefix and is never cut.

## Consequences

- The stable prefix shrinks by about 6.9k characters (15,809 → 8,921) and about 1.6k o200k tokens
  (3,736 → 2,108). Existing sessions miss the provider cache once after the upgrade; the price of a
  request is measured only with real application requests under INV-PRM-8.
- [`src/prompt/compile.test.ts`](../../src/prompt/compile.test.ts) checks the content questions, the
  evidence rule, the by-hand rule, the ending ban, the heading freedom, three examples, the size
  range and the 12,000 budget.
- No data, storage or server-protocol change; the App needs a rebuilt harness only.
- Risk: without four required blocks, a reply could go thin. The four content questions and the
  "before you send" list are the guard; whether replies keep the shape is checked on real work, not
  by a test.

## Alternatives

- **Keep the four blocks and only ban "Nothing needed".** Rejected: the merge of the agent's runs
  with the person's checks is the defect, and it comes from the block's own text.
- **Give the agent a separate "what I ran" block.** Rejected: one line of evidence is enough, and a
  block invites the ceremony the person objected to.
- **Ban headings entirely.** Rejected: short replies drift into prose, and a report still needs
  names for its parts.
- **Keep ~15.8k characters and rewrite the rules in place.** Rejected: the person chose a leaner
  text, and the five examples restated rules already in prose.
- **Require the by-hand block on every change.** Rejected: most backend work has nothing a person
  can check, and an always-present block produces filler.
