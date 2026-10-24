# Question wireframe border normalization

PROP-0028 / ADR-0029 verification, 2026-10-24. This is a terminal display projection change. The test used the production Harness CLI, OpenTUI bundle, Pi SDK, question registry and run writer with a controlled loopback provider. No live model requests, personal profiles or credentials were used.

## Result

The production PTY fixture renders a title-bearing top border as connected box glyphs and aligns missing or whitespace-shifted vertical edges to the matched frame columns. Interior labels and nested tables remain intact. The question dock continues to support compact and wide layouts, panning, resizing and staged answers.

`verification.json` records the tested CLI, terminal bundle and verifier digests. Cumulative PTY ANSI captures are retained as `.ansi.gz` at 40×20, 60×24, 80×24 and 120×40, plus a compact welcome capture. Replay each at its recorded dimensions. They capture the actual production renderer, not a mock layout.

## Checks run

| Check | Result |
|---|---|
| Harness typecheck | Passed |
| Harness full test suite | 1,084 passed; three skipped |
| Production question PTY | Passed at 40×20, 60×24, 80×24 and 120×40 |
| Original sketch and answer | Persisted ASCII remains unchanged; inferred glyphs do not enter answers |
| Terminal cleanup | All four PTYs restored termios, bracketed paste and cursor state |

The PTY screen assertions check fixed screen-coordinate edges for the title frame and repaired rows at 80×24 and 120×40. All four sizes verify the real question flow, resize/panning, and unchanged staged answer. Unit fixtures separately cover content preservation and ambiguous frames. The test required `pyte` for cell-level screen assertions; it was installed outside the repository in an isolated target.

```sh
npm run typecheck
npm test
npm run build
python3 -m pip install --target /tmp/harness-pyte pyte
PYTHONPATH=/tmp/harness-pyte python3 scripts/verify-terminal.py \
  --questions-only --sizes 40x20,60x24,80x24,120x40 \
  --save-evidence docs/evidence/terminal-wireframe-normalization
```

## Limits

This proves bounded structural behavior in deterministic production PTY fixtures. It does not guarantee every terminal emulator/font renders box glyphs identically or that live-model sketches have correct UI content. The App remains free to show the same validated ASCII literally.
