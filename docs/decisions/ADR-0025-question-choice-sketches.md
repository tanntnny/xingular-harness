---
id: ADR-0025
title: Store bounded ASCII sketches with question requests
status: accepted
created: 2026-10-24
updated: 2026-10-24
related: [PROP-0024, INV-RUN-3, INV-PAR-1, INV-PAR-2]
supersedes: null
superseded_by: null
---

# ADR-0025 — Store bounded ASCII sketches with question requests

**Accepted by the product owner on 2026-10-24.**

## Context

Choice labels and descriptions do not always communicate a layout or other compact visual
comparison. Both question surfaces need the same safely bounded representation, and the validated
`question.requested` event is the existing shared contract through which they receive choice data.

## Decision

- A question may set `uiSketch: true` to enable sketch previews. Each offered choice must then
  provide its own `sketch`; without the flag, a choice must not provide a sketch.
- Sketches are literal text of 1–8 LF-separated lines, at most 32 printable ASCII characters per
  line, with at least one visible character. The complete value is at most 263 bytes. Tabs, CR,
  control characters, escape sequences and non-ASCII text are invalid. Valid text, including
  interior blank lines and trailing spaces, is preserved exactly.
- Harness validates the flag/choice relationship and text bounds before emitting a request. The
  persisted `question.requested` event may carry the metadata; `question.answered` and
  `QuestionAnswer` remain unchanged. Older request events remain valid.
- The terminal and hosts render one shared monospace preview below the choices, following the
  hovered or focused choice. They render the sketch as text, not Markdown, ANSI or executable rich
  output.

## Consequences

- The existing event schema and persistence path carry the preview; no event kind, image type,
  storage file or protocol version is added. No data migration is needed.
- Hosts mirror the optional schema fields. Surface parity requires the terminal and each host to
  present the same choice sketches without changing answer semantics.
- The strict ASCII and dimension limits keep the diagram readable in a 40-column terminal and
  prevent markup, terminal controls and unbounded content from entering the question surface.

## Implementation and verification

Implemented under [PROP-0024](../architecture/proposals/PROP-0024-question-sketch-previews.md).
Verification evidence is recorded with that proposal and in the App's implementation-stage log.
