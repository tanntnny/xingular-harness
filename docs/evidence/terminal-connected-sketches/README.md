# Connected sketch panels

PROP-0026 / ADR-0027 verification, 2026-10-24. This is a terminal display change, not a sketch schema or storage change. No live model requests or personal credentials were used.

## Result

The frame uses single-line box-drawing characters. Structural ASCII table corners, tees, crossings and edges are projected into connected glyphs. Bare horizontal divider rows expand to the larger of the viewport width and source diagram width and join the outer frame with `├` / `┤`. Nested framed tables keep their source widths; prose, command pipes and arithmetic are not globally replaced. Malformed or ambiguous source geometry is not a general-purpose layout language and is not automatically reconstructed.

Eight actual cumulative PTY captures are retained as `.ansi.gz`, with final-screen `.txt` projections at their recorded sizes. `verification.json` binds the CLI, terminal bundle and verifier digests. `120x40-question-connected-frame.txt` shows the full frame and table; compact captures show the same computed connections within the scrollable viewport.

## Checks run

| Check | Result |
|---|---|
| Harness typecheck | Passed |
| Harness full test suite | 1,078 passed; three skipped |
| Harness `npm run prove` (includes production build) | Passed |
| Isolated production questions PTY | Passed at 40×20, 60×24, 80×24 and 120×40 |
| App typecheck, tests, layer/UI checks | Passed; 566 renderer, 67 sidecar, seven signing tests; one signing skip; existing UI baseline unchanged |
| App Rust tests | 167 passed; one ignored |
| System-Chrome question-form fixture | Six passed, including literal 80×24 host preview compatibility |

The terminal screen assertions check connected outer corners, full-width divider lengths, matching frame/divider x-coordinates, nested table tees, strict choice columns, keyboard panning, live resizing, retained drafts and submission. Real registry events still contain the original short ASCII divider and ASCII table; Unicode presentation does not enter request persistence or answers. Existing notes/free-text checks also pass. A global-key routing guard keeps `?` and `!` in question editors instead of consuming them as shortcuts. The verifier's wrapping expectation accounts for the concurrently added description-aligned note field.

```sh
npm run typecheck
npm test
npm run prove
# Requires pyte (use an isolated Python environment):
python3 scripts/verify-terminal.py --questions-only --sizes 40x20,60x24,80x24,120x40
python3 scripts/profile-terminal-latency.py --targets xingular --output <scratch>
```

## Input latency

`latency.json` records a four-round, 160×45 isolated profile against the tested bundle. No missed keys. These are single-run measurements, not a statistical comparison with the prior version.

| Scenario | p50 ms | p95 ms | p99 ms | Max ms |
|---|---:|---:|---:|---:|
| Idle | 2.62 | 4.79 | 7.31 | 13.32 |
| History | 3.38 | 4.54 | 7.69 | 8.50 |
| Stream | 7.45 | 19.01 | 23.91 | 25.96 |

## Limits

This verifies the production renderer/runtime with a deterministic loopback provider and checks rendered character-cell topology, not every emulator/font combination or live-model diagram quality. Host compatibility uses isolated browser fixtures, not a native Tauri visual inspection. Historical PROP-0025 evidence remains unchanged and describes the previous literal-ASCII display.
