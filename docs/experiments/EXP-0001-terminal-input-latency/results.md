# EXP-0001 — Results

- **Status:** completed on one local machine; slower-computer validation remains open.
- **Run date:** 2026-10-20.
- **Code:** base commit `24a9390` plus the shared, uncommitted worktree. Baseline and treatment
  used the same profiler and workload; only the draft synchronization implementation differed.
- **Runtime:** Node v26.8.2, Vitest 4.1.11, macOS arm64, Apple M2, 8 CPU cores.
- **Workload:** 520 keys; 4 ms inter-key timer; 8 ms mocked draft reply; full TUI layout rendered per
  key at 120 by 40, with terminal output intercepted. Separate local socket sample: 120 requests.

| Variant | Draft RPCs | Draft queue drain | Total sequence | Full TUI frame p50/p95 | Input plus frame p50/p95 |
|---|---:|---:|---:|---:|---:|
| Serialized baseline | 520 | 1,101.67 ms | 4,557.45 ms | 1.975 / 3.402 ms | 2.145 / 3.605 ms |
| Latest-state treatment | 401 | 11.63 ms | 3,440.87 ms | 1.953 / 3.199 ms | 2.155 / 3.410 ms |

The treatment reduced draft requests by 22.9%, queue drain by 98.9%, and total sequence time by
24.5%. Full-frame p95 was 6.0% lower and combined input/frame p95 was 5.4% lower in these single
runs; the p50 frame time was effectively unchanged. The small p95 differences are directional only
because there was one 520-key run per variant.

The separately measured local socket p95 was 0.122 ms for the baseline and 0.118 ms for treatment.
Editor-only input/render p95 was 0.157 ms and 0.161 ms respectively. These numbers indicate that
the editor itself was inexpensive on this machine; the treatment mainly prevents request backlog
when replies take longer than normal.

## Uncertainty, failures and limits

The mocked 8 ms response is about 65 times the measured 0.12 ms local socket p95, so the queue
improvement is strongest evidence for slow-reply conditions. The profile does not observe physical
terminal paint and was not run on the reported slower computer. That computer must run the profile
before claiming the user's lag is fixed there.

The focused Harness terminal/editor suites passed: 52 passed, 4 skipped. The opt-in profile passed
all three profile tests. The full Harness suite had 611 passing tests and one failure in the existing
untracked `src/terminal/tui/treeModel.test.ts` search expectation; Harness typecheck also reports
two errors in the existing untracked `treePicker` files. Neither failure is in the changed files.

Sibling App layer/UI checks, sidecar tests and Rust tests passed. App typecheck and root tests still
fail on existing Guide fixture/content mismatches in the shared App worktree.

## Conclusion

The hypothesis is supported for backlog under slow draft replies: coalescing cuts queued updates
and drain time without changing measured frame performance or the focused behavior tests. Whether
this resolves the reported slow-computer typing lag is inconclusive until the profile is run there
and the result is checked against interactive use.
