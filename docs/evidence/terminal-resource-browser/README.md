# Resource browser verification — 2026-10-22

The built standalone terminal passed isolated PTY checks at 40×20, 80×24 and 120×40.
The fixture used disposable account profiles and a loopback provider; browsing and skill
insertion sent **zero model requests**. All three processes exited 0 and restored termios,
bracketed paste and cursor state.

Verified journeys: Overview and section shortcuts; actual loaded skill visibility; `$` completion;
inspect → Use; preserving a composed draft through Ctrl+K → Skills → Use; Installed/Discover;
Community filtering and empty results; pointer activation of the filter control; resize to 40×20
and back while retaining the filter; Connections navigation. Small terminals put the filter on its
own row. The wide terminal shows inventory and ownership inspector together.

`verification.json` records the exact CLI, frontend bundle and verifier SHA-256 digests and
capture hashes. Every `.ansi.gz` file is a cumulative PTY stream from startup; replay at the
capture dimensions, which may differ from the profile name for a resize capture. The frontend
digest was copied from the verifier's full report into the concise manifest.

`latency.json` records 2 rounds, 32-character target inputs, at 160×45 with the loopback provider.
There were no missed keys. Idle/history/stream p95 values were 14.81/14.27/17.32 ms. This is one
machine's measurement, not a provider availability or cross-machine performance guarantee.

Additional validation: Harness typecheck, full tests, build and standalone proof; sibling App
typecheck, layer check, renderer/sidecar tests, Rust tests, and sidecar bundle build. Focused tests
cover imports, bounded reads, symlink rejection, pinned/latest separation, protected socket calls,
masked MCP configuration, cancellation, duplicate provenance and draft/attachment preservation.

Reproduce after building (Python needs `pyte` for screen, pointer and resize assertions):

```sh
python3 scripts/verify-terminal.py --browser-only --sizes 40x20,80x24,120x40
python3 scripts/profile-terminal-latency.py --targets xingular --scenarios idle,history,stream --rounds 2 --length 32
```

No live OAuth provider, external MCP service or community package installation was exercised;
those network integrations retain their existing service tests. Local MCP setup is covered with
masked-input page tests. Imported Hub connector documents remain inert until explicit setup.
