---
id: ADR-0080
title: Use a fixed 80-column canvas for question sketches
status: accepted
created: 2026-11-28
updated: 2026-11-28
related: [PROP-0026, ADR-0027, ADR-0029, INV-PAR-1, INV-PAR-2]
supersedes: null
superseded_by: null
---

# ADR-0080 — Use a fixed 80-column canvas for question sketches

## Context

The shared question-sketch contract permits up to 80 printable ASCII columns, but neither validation
nor the tool guidance required the model to use that full width. The terminal's display width also
followed the viewport, so the same sketch could appear at different widths on different terminals.
A fixed design canvas gives the model room for contextual UI detail and makes terminal previews
consistent without breaking callers that provide shorter sketches.

## Decision

Ask the model to design detailed `uiSketch` wireframes on a fixed 80-column canvas. This remains
guidance: preserve the existing validator, which allows sketches shorter than 80 columns and does
not require trailing spaces.

The terminal projects every valid source sketch to 80 content columns, padding shorter rows and
extending standalone divider rows to the same width. Keep the outer preview frame no wider than the
available dock; the content remains horizontally pannable when the canvas does not fit. Keep the
existing structural-border projection within the canvas. Padding and projected glyphs are display-only;
source events and answer payloads remain unchanged.

The App may keep its literal ASCII preview and overflow behavior. Both surfaces use the same source
contract and model guidance; identical preview typography is not required. This amends only the
viewport-relative canvas and divider sizing in [ADR-0027](ADR-0027-connected-sketch-display.md) /
[PROP-0026](../architecture/proposals/PROP-0026-connected-sketch-display.md). Their structural
recognition and persistence rules remain in force.

## Consequences

Short source rows appear padded in the terminal but remain unchanged in history. A model may still
return a narrower drawing because canvas usage is not schema-enforced. There is no data migration,
wire-contract change, or answer-payload change.

## Verification

Cover fixed width and padding in unit tests; verify the viewport-bounded frame and horizontal panning
at compact, standard, and wide PTY sizes. Confirm persisted sketch text and submitted answers remain
unchanged. Fixture verification does not guarantee every live-model sketch uses the full canvas.
