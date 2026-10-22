---
id: EXP-0001
title: Harness terminal input latency
status: completed
created: 2026-10-20
updated: 2026-10-20
related: [ADR-0001]
---

# EXP-0001 — Harness terminal input latency

## Question and falsifiable hypothesis

Does replacing the serialized per-change draft queue with a single-flight latest-state publisher
reduce draft synchronization backlog while preserving the final dirty state, submit ordering, and
editor behavior?

The hypothesis is that, when draft replies are slower than incoming keys, the treatment will send
fewer than one control request per key and reduce queue drain time. Full TUI frame p95 should not
increase materially. The real local control socket is measured separately from the delayed stress
workload.

## Baseline, treatment and controls

- **Baseline:** `TerminalApplication.syncDraft()` appends one socket request to a promise chain for
  every editor change.
- **Treatment:** one in-flight request plus the latest pending dirty boolean. A pending value is
  always sent after the in-flight request, including when it has the same boolean, because raw
  terminal input can change controller state independently.
- **Fixed controls:** same working tree, Node/Vitest versions, 520-character input sequence, 4 ms
  inter-key timer, synthetic 8 ms draft reply, 120 by 40 terminal dimensions, and test runtime.
  The full-frame test calls `renderNow()` for each key and intercepts terminal writes.
- **Behavior controls:** focused application tests cover submit waiting for the empty-draft reply,
  coalescing to the latest state, and existing editor callbacks; the controller test covers a
  multiline raw-input/Ctrl+U correction and the send guard.

## Data, sampling and protocol

Run `npm run profile:terminal-input`. It emits nearest-rank p50/p95 samples for editor input/render,
full TUI layout frames, and 120 real local draft-socket requests. Its application workload types
`abcdefghijklmnopqrstuvwxyz` 20 times, waits 4 ms between keys, and injects an 8 ms mock reply for
each draft update. `XINGULAR_PROFILE_TERMINAL_INPUT_RPC_DELAY_MS` changes that injected delay.
No model or provider request runs.

The full-frame profile measures Harness layout and diff computation up to `ProcessTerminal.write`;
the write itself is intercepted, and direct `renderNow()` bypasses the TUI's scheduled frame
throttle. It does not measure terminal-emulator paint or the user's slower computer.

## Versions and environment

- Harness package: 3.0.0; Pi dependency: 1.2.0.
- Base commit: `24a9390` on `harness2`; profile and product changes were uncommitted in the shared
  worktree during the runs.
- Runtime: Node v26.8.2, Vitest 4.1.11, macOS arm64, Apple M2, 8 CPU cores.
- No random seed is used; the input string and timing controls are fixed.
- Profile script SHA-256: `fdcc0d901aae87bbd3e72481471b22dd3d55d1d0d7685ffab4b0d5df0486b509`.

## Metrics and success criteria

Primary metric: draft queue drain after the 520-key sequence. Secondary metrics: draft request
count, full-frame and combined input/frame p50/p95, and real local socket p50/p95. The change is
useful if it materially lowers queue drain and request count while keeping the final dirty state,
submit order and focused behavior tests passing. Frame p95 is checked for regressions, but one run
per variant is not enough to establish a statistically stable p95 difference.

## Risks and stopping criteria

The injected reply delay is intentionally much slower than the measured local socket. The test can
show backlog behavior under slow replies, but it cannot establish that socket latency causes the
reported lag on a different computer. Stop optimization if the exact draft or send guard changes,
or if repeated slow-machine measurements show no meaningful queue or frame improvement.

## Reproduction

From `Harness/`, run `npm run profile:terminal-input`. For the same synthetic stress profile on
another computer, use the same Node and dependency versions and leave the default delay unchanged.
Run the focused suite to verify behavior:

```sh
npm test -- src/terminal/tui/application.test.ts src/terminal/tui/editor.test.ts src/terminal/terminal.test.ts
```
