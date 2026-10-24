# Full-screen browser evidence — 2026-10-23

Run after building the terminal bundle:

```sh
PYTHONPATH=/private/tmp/harness-pyte python3 scripts/verify-terminal.py --browser-only \
  --output /private/tmp/harness-fullscreen-browser-final \
  --save-evidence docs/evidence/terminal-fullscreen-browser
```

The PYTHONPATH points to an existing scratch installation of pyte; it enables rendered-screen
and pointer assertions. A normal Python environment with pyte installed needs no override.

`verification.json` contains the result, bundle/script digests, profile checks and compressed
capture inventory. Captures are cumulative ANSI streams replayable at their named dimensions.
Only bounded captures are retained; disposable accounts, sockets and session data are excluded.

The checks cover full-screen placement, persistent tabs, keyboard and mouse section changes,
resource inspection and skill insertion, draft preservation, Installed/Discover and Community
filters, pointer filter selection, MCP entry points and responsive resizing at 40×20, 80×24 and
120×40. There are no model requests. Wide inspector content, compact details, Escape handling,
loading-state navigation and pointer coordinates also have focused unit coverage.

Related: [PROP-0014](../../architecture/proposals/PROP-0014-fullscreen-browser-tabs.md),
[ADR-0016](../../decisions/ADR-0016-fullscreen-browser-tabs.md).
