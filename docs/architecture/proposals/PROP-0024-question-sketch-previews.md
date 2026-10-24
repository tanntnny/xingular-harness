---
id: PROP-0024
title: Add bounded ASCII sketch previews to question choices
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-3, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, docs/parity.md, App/shared/contracts.ts, App/src/modes/chat/QuestionBatchForm.tsx, App/docs/features/FEAT-0013-plan-mode.md, App/docs/architecture/implementation-stage.md, ADR-0025]
---

# PROP-0024: Add bounded ASCII sketch previews to question choices

**Accepted by the product owner on 2026-10-24; implementation and verification completed in the working tree.**

## Problem

Question choices currently carry labels, descriptions and recommendation state. The validated
`question.requested` run event persists those fields, but neither the Harness question contract nor
the App's mirrored contract can carry a choice-specific visual sketch. As a result, an agent cannot
show a small text diagram to clarify a choice, and neither question surface can preview one while a
person compares choices.

This changes the persisted run-event payload contract. It must be accepted before changing code or
the architecture specification.

## Affected rules

- **INV-RUN-3:** “Every run event is validated against its schema, redacted, persisted, and only then
  relayed to listeners, in order. An event that arrives after the run settled is kept as evidence and
  never applied or relayed.” This proposal adds validated optional metadata to
  `question.requested`; it does not change event ordering or persistence.
- **INV-PAR-1:** “Every capability a person can use in a host is a Harness capability: a foundation
  service, a world part or a first-party plugin, reachable through server methods. The standalone
  terminal surfaces it. A host is a presentation of it.” Sketch metadata and the terminal preview
  are Harness-owned; the App presents the same question data.
- **INV-PAR-2:** “A capability is complete only when its terminal surface and its host surface both
  pass acceptance. It lands in the Harness first, together with its terminal surface; the host
  surface follows.” Both question surfaces must render and test the same metadata.

## Proposal

1. Extend each question input with optional `uiSketch?: true`. This question-level flag enables
   sketch mode; it applies to that question only, including questions in an `ask_user` batch.
2. Extend each choice with optional `sketch?: string`. When `uiSketch: true`, every choice must
   contain a valid sketch. When the flag is absent, choices must not contain sketches. Reject an
   invalid combination before emitting a question event; do not silently omit or truncate data.
3. Bound each sketch to 1–8 lines and at most 32 printable ASCII characters per line. Lines are
   separated by LF. Only bytes `0x20`–`0x7e` and LF are allowed; tabs, CR, terminal controls,
   escape sequences and Unicode are rejected. The sketch must contain at least one non-space
   printable character. Interior blank lines and trailing spaces are allowed and preserved exactly.
   The maximum encoded length is 263 bytes (eight 32-character lines plus seven LF separators).
4. Add the fields to both Harness question-tool schemas (`ask_user` and terminal
   `ask_user_question`) and their runtime validation. Add them to the `question.requested` payload
   schema and preserve them through `RunRegistry` into the persisted event. `question.answered` and
   `QuestionAnswer` stay unchanged: sketch metadata is never part of an answer.
5. The terminal question dock renders choice labels and descriptions in wrapping columns. It places
   one shared, monospace sketch canvas below the choice list, displaying the hovered choice's sketch
   or, with no hovered choice, the keyboard-focused choice's sketch. It does not create one canvas
   per choice. Sketch content is rendered as literal text, without Markdown or ANSI interpretation.
6. The App mirrors the payload schema and preview behavior in `QuestionBatchForm`. Its choice
   label/description columns wrap at narrow widths, and its shared preview is literal monospace
   text. Update plan-mode acceptance to cover sketch-enabled questions and record the implementation
   in the App's implementation-stage log. Update Harness architecture/terminal docs and
   `docs/parity.md` when implementing.
7. On acceptance, add ADR-0025 to record the stable question-event and sketch-bounds contract.

The optional flag is intentionally a positive literal, not a free-form renderer configuration.
Sketches do not introduce an image/attachment type, a host-only surface or a new answer format.

## Alternatives

- **Accept optional sketches without a mode flag.** This leaves it unclear whether sketches are
  expected, permits partially illustrated questions, and makes the preview's presence ambiguous.
- **Allow Markdown, Unicode diagrams, ANSI or unbounded text.** Rendering differs across terminal
  and host, escape/control content creates risk, and unbounded content can overwhelm a question
  surface.
- **Use image attachments or a rich-output event.** This adds a separate content/storage/rendering
  contract for a small, readable diagram and cannot provide the same text fallback in the terminal.
- **Do nothing.** Keeps the existing event stable but does not let questions explain choices with
  compact diagrams.

## Consequences

- New `question.requested` events may carry `uiSketch: true` and per-choice `sketch` strings. The
  event remains backward-compatible: both fields are optional, and old events continue to parse.
- The App's shared contract must accept the same bounded fields as Harness. A stale host that does
  not understand the optional metadata can still read the other question fields, but cannot show
  the preview; parity requires updating the App before marking the feature complete.
- The question surface gains a bounded preview with no answer semantics. Recommendation ordering,
  selection, free text, notes, submission and cancellation remain unchanged.
- There is no run-record layout change or migration. Sketches are stored only in the existing
  `question.requested` event payload, subject to the existing event redaction and persistence path.
- Existing question-tool and event callers that omit `uiSketch` behave as before. Calls that enable
  it must provide a valid sketch for every choice.

## Migration

No migration is needed. New readers accept old question events because the new payload fields are
optional; new writers validate the flag/choice relationship and bounds. Answer payloads are
unchanged. The Harness implementation and terminal surface must land first; then the App schema and
form are updated in a separate App repository change. No live-model request is required for
verification.

## Checks

After acceptance, verify schema bounds and flag/choice consistency, preservation of literal sketch
text through both tool paths and persisted events, compatibility with old events, unchanged answer
payloads, and terminal/App hover/focus preview behavior. Run the focused Harness and App question
tests, including the isolated question-form browser fixture. Also run:

- Harness: `npm run typecheck`, `npm test`, `npm run build`, `npm run prove`,
  `python3 scripts/verify-terminal.py --questions-only` at 40×20, 80×24 and 120×40, and a terminal
  input-latency profile.
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`,
  `cd src-tauri && cargo test`, and the isolated question-form browser fixture.

## Implementation evidence

- Harness: `npm run typecheck`, all 1,041 tests (3 skipped), `npm run build` and `npm run prove`
  passed. The isolated `--questions-only` PTY check passed at 40×20, 80×24 and 120×40 with
  `pyte`; the 40-column run checks compact sketch navigation and answers, while wider runs also
  check wrapped notes and free-text.
- Input latency profile (160×45, four rounds, loopback provider, no live requests): idle p50/p95/p99/max
  4.83/9.69/10.02/10.14 ms; history 4.72/9.79/10.41/10.60 ms; streaming 8.36/19.53/21.67/26.00 ms.
  No keystrokes were missed.
- App: `npm run typecheck`, `npm test` (566 renderer, 49 sidecar and 7 development-signing passed;
  one signing test skipped), `npm run check:layers`, `npm run check:ui` and Rust tests (168 passed,
  1 ignored) passed. The isolated question-form browser fixture passed all 5 tests using the installed
  system Chrome executable.
- The first App test run, executed concurrently with other checks, exceeded an existing run-event
  performance threshold; the full suite passed when rerun alone. No live-model request was made.
