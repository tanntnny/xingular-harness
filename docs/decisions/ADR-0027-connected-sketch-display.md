---
id: ADR-0027
title: Project structural ASCII sketch lines into connected terminal borders
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0026, ADR-0026, ADR-0029, INV-RUN-3, INV-PAR-1, INV-PAR-2]
supersedes: null
superseded_by: null
---

# ADR-0027 — Project structural ASCII sketch lines into connected terminal borders

**Design accepted by the product owner on 2026-10-24** with “yes, fix it” after screenshot review.
This foundation presentation change is implemented and verified in isolated production fixtures;
see [retained evidence](../evidence/terminal-connected-sketches/README.md).

## Context

ASCII `+|-` table frames appear disconnected in the terminal, and bare hyphen dividers do not
reach the preview frame. ADR-0026's absolute literal-render promise prevents correcting those
structural lines without a documented exception. Raw ASCII persistence and shared host metadata
remain appropriate; the problem is terminal typography, not the question contract.

## Decision

Adopt [PROP-0026](../architecture/proposals/PROP-0026-connected-sketch-display.md). The terminal
preview in `src/terminal/opentui/sketchPanel.ts` uses a bounded structural display projection:

- Recognized ASCII table-border rows and enclosed vertical table edges become connected
  box-drawing glyphs. Internal framed tables retain their original widths and positions.
- Bare standalone hyphen divider rows expand to the larger of the panel viewport width and the
  original sketch's widest line, joining the outer single-line preview frame with `├` and `┤`.
- No global substitution: prose, content operators and ordinary pipes remain literal. Unrecognized
  rows remain literal. Whitespace and geometry remain unchanged except for recognized structural
  border glyphs and standalone-divider expansion, subject to the high-confidence boundary-cell
  repair separately specified by [ADR-0029](ADR-0029-normalized-question-wireframe-borders.md).
- Keep bounded two-axis panning, with no wrapping, reflow, truncation or markup interpretation.
  Focus, selection, navigation and answers do not change.

The validated source remains at most 80 printable ASCII columns by 24 lines. Persist that source
literally, including whitespace; never save projected Unicode or divider expansion. No wire/schema
or answer change is introduced. Hosts may retain literal previews of the same source. INV-PAR-1/2
require equivalent capability and accepted metadata, not identical structural typography.

## Consequences

This amends only ADR-0026's terminal literal-render requirement and cross-surface typography
promise; its bounds, raw persistence, layout and answer decisions remain in force. No migration or
host code change is needed. Reverting the display projection does not affect saved events.
Historical decisions and verification evidence remain unchanged.

## Verification status

The [PROP-0026 verification](../evidence/terminal-connected-sketches/README.md) covers structural
recognition, content preservation, four terminal sizes, resizing/panning, original ASCII persistence
and unchanged answers, alongside Harness and host checks. The later [ADR-0029 verification](../evidence/terminal-wireframe-normalization/README.md)
covers title-bearing rules and bounded repair of missing or displaced frame edges. Prior PROP-0025
evidence remains a record of the old presentation. Fixture verification is not owner visual
acceptance, an every-font guarantee or evidence of live-model diagram quality.
