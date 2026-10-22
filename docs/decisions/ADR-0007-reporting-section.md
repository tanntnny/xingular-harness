---
id: ADR-0007
title: A fixed Reporting section shapes the final reply
status: superseded
created: 2026-10-21
updated: 2026-10-21
superseded_by: ADR-0008
---
# ADR-0007 — A fixed Reporting section shapes the final reply

## Context and decision

Nothing in the compiled prompt said how a run should end, so final replies buried the answer and
rarely listed files changed, blockers or unverified work. Other harnesses (opencode, omp, Claude
Code, Codex CLI, kimi-cli) keep final-answer rules in their fixed prompt text; the comparison is in
[PROP-0001](../architecture/proposals/PROP-0001-reporting-section.md).

The compiler now adds a harness-owned `reporting` section to every pack (`SECTION_ORDER.reporting`
95, after `tools`; text `REPORTING_GUIDANCE` in `src/prompt/compile.ts`; budget 2,000, never cut,
never dynamic). It asks for the answer first, then only the parts with content — Files, Blocked,
Worth a look, Check by hand, Next steps — and Markdown tables where several items share fields. A
format the person, the application or the current mode asks for takes precedence.

## Consequences

- Every session and every application gets the same reply shape without configuration.
- The stable prefix changes once; existing sessions miss the provider cache once after upgrade.
- The model writes the file list. A harness-built list from run events remains possible later.

## Alternatives considered

Default tree text (old trees never get it, refinement could drop it); an application section
(every application repeats it, the terminal has none); doing nothing. All rejected.
