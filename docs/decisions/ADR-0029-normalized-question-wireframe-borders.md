---
id: ADR-0029
title: Normalize high-confidence question wireframe borders in the terminal preview
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0028, ADR-0026, ADR-0027, INV-PAR-1, INV-PAR-2]
---

# ADR-0029 — Normalize high-confidence question wireframe borders in the terminal preview

## Context

The terminal displays bounded, model-authored ASCII sketches. The existing connected-glyph projection misses text-bearing top rules and rows with missing or misaligned side edges. The raw source remains the right shared contract, but its terminal display needs a narrowly constrained frame-repair rule.

## Decision

Adopt [PROP-0028](../architecture/proposals/PROP-0028-normalize-question-wireframes.md). The terminal may normalize only high-confidence, explicitly framed sketch boundaries:

- Recognize title-bearing border rows and establish outer columns from matched frame rules.
- Align a boundary character only across whitespace, or fill a missing boundary cell only where it is whitespace.
- Preserve interior text, nested frame geometry, ambiguous rows, and ordinary content literally; no global symbol replacement.
- Keep the source ASCII byte-for-byte in persistence and retain the existing question schema, answer payload, viewport and panning behavior.

Hosts may continue rendering the same source literally. This decision changes terminal typography only; it adds no capability or host contract.

## Consequences

A valid framed sketch can display connected corners and continuous vertical edges even when its source omitted or misplaced a boundary glyph. Repairs are projection-only and deliberately conservative; ambiguous or content-conflicting rows remain untouched. No migration is required.

## Verification

Use structural unit fixtures and isolated production PTY runs at compact and wide terminal sizes. Verify the displayed topology, panning/resizing, and byte-for-byte source and answer preservation. This does not claim that every emulator/font renders box glyphs identically or that live-model sketches always describe the intended design.
