---
id: PROP-0026
title: Connect structural sketch lines in the terminal display
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-PAR-1, INV-PAR-2, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md]
---

# PROP-0026: Connect structural sketch lines in the terminal display

The owner approved this foundation presentation change with “yes, fix it” after inspecting a
screenshot of disconnected sketch lines. Implementation and rendered-topology verification passed
in isolated production fixtures; see [retained evidence](../../evidence/terminal-connected-sketches/README.md) and
[ADR-0027](../../decisions/ADR-0027-connected-sketch-display.md).

## Problem

The terminal preview's ASCII `+|-` table frame appears gapped, and bare horizontal divider rows
stop short of the surrounding preview frame. The absolute literal-render promise in PROP-0025
prevents a display-only correction even though the stored sketch and answer semantics need not
change. Historical PROP-0025 evidence establishes only the earlier presentation.

## Affected rules

- Page 11: “Sketches support up to 80 columns by 24 lines (page 02) and remain literal: no wrapping,
  reflow, truncation or markup interpretation.” Its absolute literal display requirement is amended
  by the bounded structural projection below; raw persistence remains literal.
- Page 14: “The terminal and each host render the same literal text as one shared preview,
  preserving whitespace and providing access to overflow; neither surface changes the answer
  payload.” The same validated source and content remain required; identical structural glyphs
  are not required across surfaces.
- INV-PAR-1/2 still require the same capability and acceptance on both surfaces. Terminal-only
  typography introduces no new capability or host contract. Page 02's validated ASCII bounds and
  literal persisted request event, and INV-RUN-3's validation requirement, are unchanged.

## Proposal

In `src/terminal/opentui/sketchPanel.ts`, project validated ASCII into display text only:

- Recognize ASCII table-border rows and enclosed vertical table edges, rendering their structural
  `+`, `-` and `|` cells as connected box-drawing glyphs. Keep internal framed tables at their
  original widths and positions; do not stretch them to the viewport.
- Expand bare standalone hyphen divider rows to `max(panel viewport width, original sketch widest
  line)`. Join these dividers to the outer single-line preview frame with `├` and `┤`; use the
  existing bounded two-axis viewport when the projected canvas overflows.
- Recognition is structural, not a global substitution. Preserve prose, content, arithmetic
  operators and ordinary pipes literally. Unrecognized rows remain literal. Apart from recognized
  border cells and standalone-divider expansion, preserve whitespace, blank lines and geometry.
- Do not wrap, reflow, truncate or interpret Markdown/ANSI. All content remains reachable through
  panning. Hover/focus preview behavior, navigation and staged answers remain unchanged.

Raw sketches remain exactly the validated 80-column × 24-line maximum ASCII source (1,943 bytes
maximum), including trailing spaces and blank lines, in request events and history. Display glyphs
and expanded dividers never enter persistence or answer payloads. A host may retain a literal ASCII
preview of that same source; terminal-only typography is permitted, not a host-only capability.

## Alternatives

- Do nothing: retains the screenshot's disconnected frame and short dividers.
- Globally replace `+|-`: corrupts content, operators and pipes without structural context.
- Stretch every table: destroys internal layout and relative geometry.
- Rewrite stored sketches as Unicode or introduce structured graphics: unnecessary schema,
  generation and migration changes for a display problem.

## Consequences

The terminal's absolute literal-render promise becomes a bounded structural display projection.
There is no wire/schema, tool, validation-bound, server, storage or answer change. Hosts need no
implementation change and may keep literal previews. This is foundation rendering work, not variant
data. Historical proposals, decisions and evidence remain records of the behavior they verified.

## Migration

No data migration. Existing ASCII sketches use the same display projection when shown; rollback
only restores literal terminal rendering. Implementation is terminal-only; host schemas and presentation
need no change.

## Checks

The checks below passed in the implementing working tree; see the linked evidence for commands,
counts, screen captures, bundle digests and limits. This is fixture verification, not a claim of
owner visual acceptance or live-model diagram quality:

- Connected table corners/tees/edges, with internal framed tables retaining original widths.
- Standalone dividers fill the larger of viewport width and original widest line and join the
  outer frame; test narrow/wide viewports, resizing and two-axis panning.
- Prose, arithmetic operators, ordinary pipes, unrecognized structures, whitespace and blank lines
  remain unchanged outside the explicit projection; persisted ASCII and answers are byte-for-byte
  unchanged, including 80×24 boundary fixtures.
- Isolated production PTY screenshots and interaction checks for the new rendering, independent of
  the retained PROP-0025 evidence. Confirm the host's literal preview remains contract-compatible.
- The implementing change runs Harness typecheck/tests and the applicable terminal checks, plus
  embedding App checks required by AGENTS.md. No live-provider request is authorized here.
