---
id: ADR-0026
title: Align question columns and preserve contextual ASCII wireframes
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0025, ADR-0025, INV-RUN-3, INV-PAR-1, INV-PAR-2]
supersedes: null
superseded_by: null
---

# ADR-0026 — Align question columns and preserve contextual ASCII wireframes

**Accepted by the product owner on 2026-10-24** through the plan “Fix TUI question columns and sketch previews”. This is foundation work.

## Context

Content-dependent choice rows do not align label and description boundaries. The original 32×8
sketch limit cannot express contextual UI panels, and a caption plus left rule adds redundant
preview chrome. ADR-0025 records the original sketch contract and its historical evidence; this
decision amends its bounds and presentation without replacing the optional sketch/answer model.

## Decision

- Use one measured layout across every choice: marker gutter, one-third label cell, two-cell gap,
  remaining description cell. Wrap within cells, retain empty description cells, and never stack
  columns at compact widths. Use `(Rec.)` when the label column is fewer than 14 cells and a compact
  dock hint below 60 terminal columns.
- Accept 1–24 LF-separated lines of at most 80 printable ASCII characters each (1,943 bytes
  maximum), with at least one visible character. Reject tabs, CR, controls, escapes and Unicode;
  preserve whitespace literally. Both question tools and validated request events use these bounds.
- Ask models for contextual UI wireframes containing actual panel/table structure and neighboring
  elements, consistent across alternatives. This is generation guidance, not schema enforcement.
- Render one shared border-only literal preview without a visible caption or extra left rule.
  Preserve content without wrapping, reflow or truncation; bounded two-axis scrolling exposes
  overflow. Hover/focus chooses the preview without changing the staged answer.
- Bound and vertically scroll the dock body, keeping tabs and answer/action controls outside it.
  PageUp/PageDown and Ctrl+Home/End scroll that body while the dock is active. Shift+arrows pan the
  sketch; ordinary arrows keep question/choice navigation. Bring focused choices and notes into view.
- Terminal and hosts accept the same metadata and preserve literal content. Host presentation may
  differ, but the expanded contract requires acceptance on both surfaces under INV-PAR-1/2.

## Consequences

Existing sketches and events remain valid without a data rewrite. Readers enforcing the old limits
must update before accepting larger events; rolling readers back requires avoiding sketches above
those limits. `uiSketch` still requires a sketch on every choice and forbids sketches when disabled.
`question.answered`, `QuestionAnswer`, the gate, prompt compilation and storage ownership do not
change. No image format, event kind or executable rich-output contract is introduced.

## Implementation and verification

The accepted design is [PROP-0025](../architecture/proposals/PROP-0025-contextual-question-wireframes.md).
Implementation and isolated terminal/host acceptance are recorded in the
[retained verification](../evidence/terminal-question-wireframes/README.md), including four terminal
sizes, live resizing, sketch panning, literal persistence and the host's expanded-boundary fixture.
Earlier PROP-0024/ADR-0025 evidence remains historical; the new evidence does not claim live-model
diagram quality, every emulator's behavior or native Tauri presentation.
