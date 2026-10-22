# EXP-0002 — Results

- **Status:** completed on one machine; not yet repeated on a slower computer.
- **Run date:** 2026-10-21.
- **Code:** base commit `24a9390` on `harness2` plus the shared, uncommitted worktree (another session
  was editing the same frontend in parallel; every run used the tree as built at that moment).
- **Runtime:** macOS arm64, Apple M2, 8 cores; Node v26.8.2; Bun 1.4.2; OpenTUI 0.6.6; Pi 1.2.0;
  opencode 2.1.0; pyte for the virtual screen.

All latencies in ms, keystroke to visible on screen, p50 / p95 (p99 where it matters). Lower is better.

## Final comparison (loopback model, identical replies)

| Scenario | Xingular before | Xingular after | Pure Pi | opencode `--standalone` |
|---|---:|---:|---:|---:|
| idle | 13.1 / 19.2 | 5.1 / 10.1 | 3.9 / 6.2 | 7.5 / 10.9 |
| history (≈240 messages) | 13.2 / 20.3 | 5.2 / 10.6 | 5.1 / 10.4 | 9.8 / 13.1 |
| stream over history | 13.3 / 23.7 | 8.1 / 23.5 (p99 26.5) | 3.1 / 22.2 (p99 29.4) | 9.1 / 28.0 (p99 33.2) |
| CPU while streaming | 73.3% | 15.0% | 14.3% | 36.3% |
| CPU at rest, nothing typed | — | 2.5% | 0.0% | 3.4% |

Harness-only scenarios:

| Scenario | Before | After |
|---|---:|---:|
| typing into a tool-approval dialog during a run | 20.3 / 36.2 | 7.6 / 13.7 |
| typing while an `ask_user` question waits | 5.7 / 1,154.5 (max 1,402) — keys dropped | 5.0 / 12.9 (max 74) |

Real model (each tool's own login, `stream` scenario, three rounds while the reply streams):

| Target | Model | p50 / p95 / p99 / max | CPU |
|---|---|---:|---:|
| Xingular, after | Codex account, `openai-codex` / `gpt-6-luna` | 6.2 / 12.9 / 32.5 / 48.1 | 15.2% |
| opencode | its own login, MiniMax M3.1 Flash Free | 11.6 / 24.8 / 30.8 / 40.5 | 33.6% |

Pure Pi was not run with real credentials: its only real logins are OAuth accounts whose refresh
tokens rotate, and copying them into a second client could sign the Harness account out.

## What each change did

Full-run rows stream on top of `history`; the "stream only" rows start fresh and are compared only
with each other.

| Step | idle | history | stream | stream CPU |
|---|---:|---:|---:|---:|
| Baseline | 13.1 / 19.2 | 13.2 / 20.3 | 13.3 / 23.7 | 73.3% |
| 1. Render on demand (no `renderer.start()`) | 4.9 / 9.0 | 7.2 / 8.5 | 16.5 / 26.3 | 72.2% |
| 2. Store + `reconcile` by id, `<markdown streaming>`, coalesced `change()` at 16 ms | 4.8 / 8.8 | 4.7 / 9.1 | 18.0 / 28.1 | 30.2% |
| stream only: 2 + publish at 33 ms | | | 19.4 / 28.1 | |
| stream only: 2 + `maxFps: 120` | | | 13.6 / 20.0 | |
| stream only: 2 + both | | | 7.7 / 20.0 | |
| 3. 33 ms only while running, `maxFps: 120` | 4.8 / 9.7 | 4.8 / 9.0 | 10.0 / 24.0 (p99 34.7, max 45.0) | 25.0% |
| 4. Socket keep-alive, statistics cache, per-message transcript cache | 4.9 / 6.0 | 4.7 / 6.1 | 6.0 / 19.2 (p99 23.3) | 14.9% |
| 5. Input publishes at once, draft read at key time, dock reply fix | 5.1 / 10.1 | 5.2 / 10.6 | 8.1 / 23.5 (p99 26.5) | 15.0% |

The CPU profile of the baseline stream (Bun `--cpu-prof`) attributed 34% of samples to `change()` →
Solid updates, 18% to re-highlighting text (`startHighlight` → `setStyledText`), about 12% to
destroying and recreating renderables, about 30% to native painting, and 16% to socket requests:
two 100 ms polls and every draft update each opened a new Unix-socket connection.

Step 5 fixed correctness problems found while measuring, at no material latency cost:

- **Dropped keys:** while a question waited, letters the dock did not use reached nothing, so typing
  showed only after an `x` happened to collapse the dock. They now move focus to the composer.
- **Stale draft on Enter:** OpenTUI reports composer text in a microtask after all keys of one input
  chunk. Keys and Enter arriving together (a busy machine, a paste ending in a newline) sent an empty
  or truncated draft. The root now reads the composer before each key.
- **Composer not cleared:** with coalesced publication, a send's cleared draft could be overwritten by
  the composer's late report. Changes made while handling a key publish synchronously.

An A/B of the per-key composer read gave idle p95 6.7 and 9.4 ms without it and 10.0 and 6.8 ms with
it. Idle p95 alternates between about 7 and 10 ms from run to run: a key that lands within one
120 Hz frame (8.3 ms) of the previous frame waits for it.

## Against the success criteria

- p95 at or below opencode's: met in every scenario (10.1 vs 10.9, 10.6 vs 13.1, 23.5 vs 28.0).
- Within 1.5 times Pi's p95: met for history and stream; idle is 1.6 times in the final run and
  1.1 times in step 4 and the A/B runs, inside the run-to-run spread above.
- No growth with history: met (idle 5.1 / 10.1, history 5.2 / 10.6).
- Streaming CPU no higher than opencode's: met (15.0% vs 36.3%).

## Limits

- One machine, one run per row; the spread of p95 between repeats is about 3–4 ms.
- The metric includes PTY and pyte parsing but not a terminal emulator's paint.
- The loopback stream is regular (60 chunks per second); real providers burst. The Luna run agrees
  with the loopback figures at p50/p95.
- `scripts/verify-terminal.py` still fails after `/settings` on a `Try "` placeholder from the
  removed Pi frontend; that check predates this work (`verification.json` recorded `passed: false`
  for OpenTUI on 2026-10-20). It now matches the rendered screen when pyte is installed, which fixed
  the earlier false failure on "Keyboard controls".
