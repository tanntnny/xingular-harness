---
id: PROP-0025
title: Strict question columns and contextual ASCII wireframes
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-3, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 11-terminal.md, 14-surfaces-and-parity.md]
---

# PROP-0025: Strict question columns and contextual ASCII wireframes

The owner accepted the design with “Implement the plan: Fix TUI question columns and sketch previews”. This is foundation work. Implemented and verified in the working tree; see [ADR-0026](../../decisions/ADR-0026-contextual-question-wireframes.md) and [retained evidence](../../evidence/terminal-question-wireframes/README.md).

## Problem

Choice rows independently distribute width based on their content, so label and description boundaries differ. Sketches are limited to 32 columns by eight lines and presented beneath a redundant caption and left rule. These limits cannot represent a contextual UI panel like the owner's reference.

## Affected rules

- INV-RUN-3 validates every persisted question event. Its sketch bounds change from 32×8 to 80×24.
- INV-PAR-1/2 require the same capability and accepted metadata on terminal and host surfaces.
- Page 11's wrapping columns become strictly aligned columns at compact widths too.

## Proposal

Use one measured layout for every choice: marker gutter, one-third label cell, two-cell gap, remaining description cell. Preserve cells even without a description; never stack them on compact terminals. Text wraps within its cell.

Support up to 24 LF-separated lines of 80 printable ASCII characters each (1,943 bytes maximum), preserving whitespace and rejecting controls, Unicode and empty diagrams. Tool guidance requests contextual UI wireframes with actual panel/table structure and neighboring elements, consistent across alternatives.

Render one border-only ASCII preview without a visible caption. Preserve literal content with bounded two-axis scrolling. Keep tabs and answer/action controls outside the dock body's vertical scrolling region. PageUp/PageDown and Ctrl+Home/End scroll that body; Shift+arrows pan the sketch, leaving ordinary arrows for question/choice navigation. Focused choices and notes are brought into view. No answer semantics change.

## Alternatives

- Keep the old bounds: cannot show the reference's contextual layout.
- Only change flex ratios: leaves per-row content-dependent boundaries.
- Reflow or truncate diagrams: destroys structure or hides content permanently.
- Rich images or structured scene graphs: unnecessary new storage/rendering contracts.

## Consequences

Both question tools, event validation and host contracts use the larger bounds. Existing clients with old limits must update before accepting larger new events. Existing event and answer formats, gate, prompt compilation and storage ownership remain unchanged. Generation quality is guidance, not a schema guarantee.

## Migration

No data rewrite. Old diagrams and events remain valid. Keep host contract compatibility in a separate repository change. Rollback of readers requires avoiding newly generated diagrams above the old bounds.

## Checks

Geometry and schema boundary tests, literal persistence and unchanged answers; isolated production PTY checks at 40×20, 60×24, 80×24 and 120×40 including resizing, scrolling and keyboard focus; Harness typecheck/test/build/prove and latency profile; App typecheck/test/layer/UI/Rust checks and isolated question-form fixture. No live requests or personal profiles.
