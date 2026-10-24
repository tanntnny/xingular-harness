# Question columns and contextual wireframes

PROP-0025 / ADR-0026 implementation verification, 2026-10-24. All runs used disposable profiles and loopback providers; no live-model requests or personal account data.

## Functional evidence

`verification.json` binds the CLI, OpenTUI bundle and verifier SHA-256 digests. Eight cumulative PTY ANSI captures are retained as `.ansi.gz`, with readable final-screen `.txt` projections at their recorded dimensions. The captures precede live resizing, so their screen dimensions are unambiguous.

```sh
npm run typecheck
npm test
npm run prove
# Run with pyte installed in an isolated Python environment:
python3 scripts/verify-terminal.py --questions-only --sizes 40x20,60x24,80x24,120x40
```

All passed: 1,068 Harness tests, three skipped; standalone build/proof; all four question PTY sizes. The fixture exercises real Pi SDK, gate/socket, run writer and production OpenTUI bundle. Screen-coordinate assertions cover description-cell alignment despite uneven/unspaced labels, caption removal, complete ASCII preview frame after scrolling, horizontal and vertical panning, pinned answer controls, wrapped notes/free text, focus-driven previews and live-resize preservation of selection and text. All terminal exits restored termios, disabled bracketed paste and showed the cursor.

The compact screen may need PageDown to reveal the whole preview. Shift+arrows pans literal sketch content; it does not alter answers or effort. Larger screens devote more rows to the preview so a complete panel can fit without unnecessary clipping. Recommendations abbreviate to `(Rec.)` when the label cell is narrower than 14 columns.

## Input latency

`latency.json` records the isolated 160×45, four-round idle/history/stream profile against the final bundle. No missed keys.

| Scenario | p50 ms | p95 ms | p99 ms | Max ms |
|---|---:|---:|---:|---:|
| Idle | 4.87 | 10.00 | 10.53 | 54.95 |
| History | 5.01 | 10.06 | 10.34 | 16.55 |
| Stream | 5.94 | 22.02 | 26.96 | 30.98 |

This is a single controlled measurement, not a statistical before/after comparison or a claim of unchanged performance on every emulator.

## Host compatibility

The sibling App accepts 80×24 sketches, preserves literal whitespace and rejects invalid bounds/controls. Its isolated system-Chrome question-form fixture passed six tests, including an exact 80×24 diagram, accessible horizontal overflow at a 375-pixel viewport, no document overflow, one reused preview, and hover/focus without selecting an answer. App typecheck, full tests (566 renderer, 67 sidecar, seven signing passed; one signing skip), layer/UI checks and Rust tests (167 passed, one ignored) passed. Native Tauri presentation was not exercised; no native code or production App UI was changed.

## Limits

The deterministic transport establishes rendering, interaction and contract behavior, not the quality of diagrams produced by a live model. Tool guidance requests detailed contextual panels, but generation quality is not a schema guarantee. These captures do not establish every terminal emulator's rendering or real-provider availability.
