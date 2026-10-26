# EXP-0003 — Results

- **Status:** audit completed; one terminal behavior verification check failed (details below).
- **Run date:** 2026-10-25.
- **Code:** base commit `6f72a07` with a dirty worktree (81 changed/untracked paths were present).
  Product changes in that worktree predate this audit; this audit added benchmark tooling and report
  artifacts only.
- **Machine/runtime:** macOS 27.0, arm64, 8 logical CPUs; Node v26.8.2; Bun 1.4.2; Harness
  1.1.1; Pi 1.2.0; OpenCode v2.1.4; Python 3.12.12; pyte 0.8.2.
- **Credentials/network:** terminal comparisons used a loopback model in isolated temporary
  profiles. The session-runtime benchmark used an injected deterministic session. No provider,
  OAuth credential, or user profile was used; `--real` was not run.

Raw terminal and runtime JSON is in [`data/`](data/): `terminal-wide.json`,
`terminal-history.json`, `terminal-compact.json`, `terminal-question.json`,
`session-runtime.json`, and `session-runtime-replication.json`. The OpenCode executable field is
normalized to `opencode` to avoid publishing a machine-specific path; measurements are unchanged.

## Terminal comparison

Main repeated comparison: 160×45 PTY, five launches per target, 2 rounds of 30 characters at 35 ms
per key, 2 s warm-idle and 2 s idle measurement. The table shows the median of per-launch values;
latency is milliseconds p50/p95 and CPU is process-tree CPU during the typing window. Every target
had zero missed keys.

| Scenario | Target | p50 / p95 (ms) | CPU (%) |
|---|---|---:|---:|
| Idle typing | Xingular | 5.11 / 9.98 | 7.7 |
|  | Pure Pi | 5.32 / 6.39 | 3.1 |
|  | OpenCode | 7.17 / 10.41 | 26.5 |
| After ~240 transcript messages | Xingular | 5.09 / 10.05 | 8.9 |
|  | Pure Pi | 5.44 / 10.34 | 4.3 |
|  | OpenCode | 9.47 / 12.70 | 32.6 |
| Regular stream | Xingular | 9.13 / 19.91 | 14.2 |
|  | Pure Pi | 3.18 / 22.26 | 10.5 |
|  | OpenCode | 10.02 / 24.87 | 41.5 |
| Burst stream | Xingular | 5.01 / 10.73 | 12.3 |
|  | Pure Pi | 4.72 / 6.31 | 5.5 |
|  | OpenCode | 10.42 / 21.85 | 33.2 |

History setup took a median 7.5 s for Xingular, 6.5 s for Pi, and 9.8 s for OpenCode. Xingular's
idle p95 was 9.98 ms before history and 10.05 ms after it, so this run found no meaningful
history-related typing regression. The median streaming p95 was lower than both comparisons; burst
p95 was below OpenCode but above Pi. Xingular idle p95 was roughly on par with OpenCode and 1.56×
Pure Pi; burst p95 was 1.70× Pure Pi. Thus the prior EXP-0002 p95 criterion of “no worse than
OpenCode” held for these four scenarios, while “within 1.5× Pi” did not hold for idle or burst.

The five-run p95 ranges show why the medians should not be read as precise rankings: idle ranges
were 9.64–10.19 ms (Xingular), 6.04–9.92 ms (Pi), and 9.58–11.08 ms (OpenCode); stream ranges
were 18.32–20.25, 22.02–23.38, and 19.00–26.36 ms; burst ranges were 8.87–12.08, 5.81–33.23,
and 12.86–26.00 ms respectively. Each run scores 44 idle keys and 22 stream/burst keys; p95 values
are medians of per-run p95, not pooled per-key percentiles.

### Fresh launch and memory

`first visible` is the first nonblank PTY screen; `stable screen` is measured after 750 ms without
output. Process-tree RSS is sampled at that initial stable screen.

| Target | First visible (ms) | Stable screen (ms) | Process-tree RSS (MiB) |
|---|---:|---:|---:|
| Xingular | 2,814 | 3,768 | 392 |
| Pure Pi | 261 | 1,035 | 134 |
| OpenCode | 304 | 1,107 | 489 |

On this machine, Xingular's end-to-end first-visible time was about 10.8× Pi and 9.3× OpenCode;
its process-tree RSS was about 2.9× Pi and 0.8× OpenCode. This launch comparison includes the
Harness CLI and its terminal child, while Pi and OpenCode have different process architectures. It
measures the user-visible path, not the renderer alone. A separate 80×24 single-run sensitivity
check showed idle p95 of 4.66/5.08/8.11 ms and stream p95 of 10.95/5.72/18.61 ms for
Xingular/Pi/OpenCode respectively; it supports the same broad pattern but is not a repeated result.

The Harness-only plan-question scenario passed after the profiler was changed to enter plan mode:
44 keys, no misses, p50 5.03 ms, p95 9.53 ms (one run; not a cross-target comparison). The raw
record is `data/terminal-question.json`.

A separate 2 s post-warm-up idle-resource window in the wide run measured median process-tree CPU
of 2.0% for Xingular, 0.5% for Pi, and 1.5% for OpenCode. These short windows are coarse and should
not be treated as a stable ranking.

## Harness runtime overhead

Two invocations of the isolated runtime benchmark contributed ten measured samples per warm
operation (five iterations and one warmup per invocation). It imports the built SDK and uses a fake
session seam; these values exclude model/provider latency and real Pi startup.

| Operation | Median | Sample range |
|---|---:|---:|
| Warm `terminal.prepare` | 9.65 ms | 7.69–11.78 ms |
| `sessions.run` to first persisted delta | 25.65 ms | 21.78–29.44 ms |
| `sessions.run` to completion | 33.86 ms | 27.96–39.06 ms |
| Tool run to `tool.started` | 29.12 ms | 25.74–31.92 ms |
| Tool run to `tool.completed` | 29.50 ms | 26.12–47.31 ms |
| Tool run to completion | 38.96 ms | 37.07–58.24 ms |

Across the two process starts, SDK import was 246–347 ms and Harness initialization was 27.8–28.5
ms. Cold `terminal.prepare` varied substantially, from 261 to 1,158 ms; its description includes
first socket-listener setup. Treat the warm path as the repeatable figure and cold preparation as a
signal to instrument further, not as a stable estimate. Every run verified the persisted event
sequence; the temporary state/data roots were removed.

## CPU profile notes

Profiles were captured separately from the comparison runs and are not included in their latency
medians. A one-run Bun profile of Xingular during startup and streaming (16.19 s, 846 samples) had
highest self-time in terminal output writing (`writeBuffered` 14.0%, Node `_write` 9.3%), key
matching (`matchesKey` 5.6%), OpenTUI stdout draining (4.5%), and the terminal socket `send` (3.2%).
This identifies output/key/event plumbing worth inspecting, but does not isolate one application
function as the cause of input latency.

A separate one-run Node profile of the Harness process (6.98 s, 5,576 samples) was 69% idle in the
profiler, with `spawnSync` at 11.2% and `readdir` at 3.2%. This is consistent with a startup path
that includes process and I/O waits rather than being dominated by one CPU-heavy JavaScript loop;
it is not a phase-by-phase startup trace. Profiles are diagnostic single runs and profiling itself
adds overhead.

## Verification

- `npm run typecheck` — passed.
- `npm test` — passed: 150 test files, 1,140 tests passed, 3 skipped.
- `npm run build` — passed.
- `npm run prove` — passed all 15 standalone proof cases.
- `npm run profile:terminal-input` — passed; 120 local draft-control socket requests, p50 0.022 ms,
  p95 0.053 ms. This measures the socket path, not key-to-screen rendering.
- `profile-terminal-latency.py --real --targets pi` — rejected before launch as intended; `--real`
  is restricted to one Xingular run.
- `python scripts/verify-terminal.py` — **failed** during `/settings` at a narrow terminal width.
  The verifier expected `Esc close` on the last row; the observed footer was truncated to
  `Enter change · type to search · Tab/`. This is a terminal behavior verification failure, not a
  performance measurement. No product UI code was changed as part of this audit.

## Conclusions and follow-up

- **Steady typing:** competitive with OpenCode at 160×45, especially for streaming p95; history
  does not increase Xingular's measured p95. Xingular still trails Pi on idle and burst p95, and
  has higher CPU than Pi while typing/streaming.
- **Fresh start:** the clearest gap. Xingular takes about 2.8 s to first visible output and uses
  about 392 MiB at the initial screen. The runtime benchmark makes warm Harness preparation look
  inexpensive, but cold preparation is variable. Break startup into Node CLI, Harness account and
  context setup, terminal preparation, Bun launch, and first render before attributing or optimizing
  the gap.
- **Next measurements:** add phase markers for fresh startup and process-by-process RSS; repeat on a
  slower machine; investigate burst input alongside `matchesKey`/output writes; and triage the
  narrow `/settings` footer verification failure separately.

## Limits

One arm64 machine and a dirty worktree; no clean-commit A/B or slower-device run. The loopback stream
is regular and excludes network/provider delay. PTY/pyte timing excludes physical terminal paint.
The compact-screen and question results are single runs. CPU profiles are single instrumented runs.
The runtime benchmark's session is injected and deterministic, so it measures Harness runtime and
persistence costs, not real model inference or the complete Pi AgentSession startup path.
