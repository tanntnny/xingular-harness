---
id: PROP-0028
title: Normalize high-confidence question wireframe borders in the terminal preview
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-PAR-1, INV-PAR-2, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md, parity.md, ADR-0027]
---

# PROP-0028: Normalize high-confidence question wireframe borders in the terminal preview

**Accepted and implemented on 2026-10-24** through “Implement the plan: Repair question wireframe borders.” The terminal-only display projection is amended; the persisted question contract and answers do not change. Verification is retained in [evidence](../../evidence/terminal-wireframe-normalization/README.md).

## Problem

The terminal currently projects horizontal rules only when a row contains decoration characters alone, so a title embedded between a frame's `+` corners remains ASCII. It recognizes vertical edges only when a row already contains both `|` delimiters. A missing or shifted side edge can therefore leave a visibly open or misaligned frame. Existing fixtures cover regular tables and dividers, not these screenshot-shaped cases.

## Affected rules

- Page 11 currently limits projection to recognized border characters and says whitespace and geometry are preserved except for structural glyph conversion and standalone-divider expansion. A high-confidence frame may now need a boundary glyph inserted or moved within whitespace to restore its declared rectangle.
- Page 14 currently promises preservation of whitespace and geometry in the shared sketch source. The validated source remains unchanged and hosts may remain literal; the terminal preview gains this narrowly bounded projection exception.
- The existing 80×24 ASCII source bounds, literal request-event persistence, answer payload, schema, server protocol and host contract are unchanged.

## Proposal

Keep the ASCII sketch as the wire and persistence format. In `src/terminal/opentui/sketchPanel.ts`, use a bounded cell-grid/topology pass to:

- Recognize explicit ASCII frame rows with `+` corners and horizontal `-` runs, including a frame title surrounded by horizontal runs.
- Establish a panel's left and right boundary columns from matched frame rules. Project only high-confidence panels; nested frames retain their own extents.
- Within a matched frame, normalize a displaced `|` only when the path to its established boundary is whitespace, and synthesize a missing boundary glyph only into a whitespace cell. Preserve all interior text. If a row conflicts with content or the frame is ambiguous, leave it literal rather than guessing.
- Resolve corners, tees, crossings and edges from neighboring structural cells. This is not a global `+|-` conversion: prose, arithmetic, ordinary content pipes, Markdown-like text and unmatched rows remain literal.
- Keep the existing bounded two-axis viewport, panning, standalone-divider behavior and source bounds. Projected or inferred glyphs never enter events, history or answers.

Strengthen both `ask_user` and terminal `ask_user_question` generation guidance to require stable left/right columns and matching border positions across rows and alternatives. Guidance is not validation; existing and externally supplied bounded ASCII sketches still receive the same safe display treatment.

## Alternatives

- **Prompt guidance only:** lowers the chance of new malformed sketches but cannot repair existing or externally supplied sketches.
- **Global symbol substitution:** can corrupt prose, pipes and operators.
- **Structured wireframe schema:** could make all geometry deterministic, but requires a wider protocol, persistence and host migration for a display-only correction.
- **Do nothing:** retains disconnected title rules and incomplete edges.

## Consequences

Only the terminal's display projection changes. A recognized frame may occupy previously blank boundary cells or move a boundary character across whitespace, while its interior text stays fixed. Stored sketches remain byte-for-byte ASCII, answer semantics remain unchanged, and hosts may continue to show the literal source. Unrecognized or ambiguous diagrams are not repaired automatically.

## Migration

No data, schema, protocol or host migration. Existing question records use the new projection when displayed. Rolling back the terminal restores the prior literal behavior without affecting stored data.

## Checks

- Unit fixtures for title-bearing top rules, missing and whitespace-shifted edges, nested frames, ordinary pipes/prose, blank lines and unchanged source text.
- Production PTY question fixtures at 40×20, 60×24, 80×24 and 120×40: connected cell topology, resize/pan behavior, and unchanged answers and persisted sketches.
- Harness typecheck, full tests and build; App typecheck, tests, layer/UI checks and Rust tests. No live-provider requests are needed.
