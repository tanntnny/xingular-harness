---
id: EXP-0003
title: Layered Xingular terminal and Harness runtime performance audit
status: completed
created: 2026-10-25
updated: 2026-10-25
related: [EXP-0002]
---

# EXP-0003 — Layered performance audit

## Question and falsifiable hypothesis

How much of the user-visible delay belongs to terminal input/rendering, fresh-process startup, and
Harness session orchestration? After the OpenTUI work in EXP-0002, the hypothesis is that steady
keystroke-to-screen latency is comparable to Pi and OpenCode, while the Harness layers show up more
strongly in cold startup and memory. A long transcript should not materially increase Harness input
latency.

The comparison can falsify this: if Harness p95 grows after history, stays above OpenCode during
streaming, or Harness session calls contribute large repeatable latency with the injected session,
those are separate regression candidates.

## Targets and controls

- **Xingular Harness:** built `node dist/cli.js`, with temporary `--state` and `--data` roots, an
  isolated API-key account, and a loopback OpenAI-compatible model.
- **Pure Pi:** `@earendil-works/pi-coding-agent` 1.2.0 with an isolated `PI_CODING_AGENT_DIR`.
- **OpenCode:** v2.1.4 with `--standalone`, isolated XDG roots and a loopback-compatible provider.
- Each terminal target runs in its own PTY and temporary profile. A local deterministic SSE provider
  supplies the same fixture response to all targets. No external provider, OAuth profile, or
  credential is used.
- Main terminal runs use a 160×45 PTY, 35 ms key interval, two rounds of 30 typed characters and
  five independent launches for idle, stream and burst. The first eight keys in each round are
  excluded from latency scoring; each idle run therefore scores 44 keys and each stream/burst run
  scores 22. Target order rotates between repeats.
- History uses three launches per target. Each history is an 80-turn local tool loop (about 240
  transcript messages) before typing is measured. The question scenario is Harness-only and uses
  plan mode. A separate 80×24 run checks a compact terminal once per target; it is sensitivity data,
  not a repeated comparison.
- The runtime benchmark runs in a separate Node process with temporary state/data and a deterministic
  injected session. It measures SDK import, Harness initialization, cold/warm `terminal.prepare`,
  run-to-first-persisted-delta/completion, and one local tool-event path. It does not start Bun or a
  real model.

## Metrics

- Input latency is the time between writing a key to the PTY and the first time its typed prefix is
  visible on a `pyte` virtual screen (p50/p95/p99/max). Missed keys are reported separately. This
  includes the PTY and `pyte` parser, not a terminal emulator's physical paint.
- Startup is measured from process launch to first output, first nonblank visible screen, and a
  quiet screen (750 ms with no further output). Process-tree RSS is sampled at that initial stable
  screen. CPU and RSS are process-tree measurements; typing CPU is measured over the typing window.
- Terminal comparison summaries take the median of each run's metric (including each run's p95); they
  are not pooled per-key percentiles. Session-runtime summaries use the median of measured samples.
- No credentialed run is required. The profiler rejects `--real` unless it is exactly one Xingular
  run; this audit does not invoke `--real`.

## Reproduction

Build the CLI and create an isolated Python environment for the PTY screen parser:

```sh
npm run build
python3 -m venv /tmp/harness-perf-venv
/tmp/harness-perf-venv/bin/python -m pip install -r scripts/requirements-performance.txt
```

Main repeated comparison:

```sh
/tmp/harness-perf-venv/bin/python scripts/profile-terminal-latency.py \
  --targets xingular,pi,opencode --repeats 5 --scenarios idle,stream,burst \
  --rounds 2 --length 30 --interval 0.035 --width 160 --height 45 \
  --warm-idle-seconds 2 --idle-seconds 2 --stream-seconds 4 \
  --output /tmp/harness-perf-wide
```

History and compact-terminal sensitivity runs:

```sh
/tmp/harness-perf-venv/bin/python scripts/profile-terminal-latency.py \
  --targets xingular,pi,opencode --repeats 3 --scenarios history \
  --rounds 2 --length 30 --interval 0.035 --width 160 --height 45 \
  --warm-idle-seconds 1 --idle-seconds 1 --stream-seconds 2 \
  --output /tmp/harness-perf-history

/tmp/harness-perf-venv/bin/python scripts/profile-terminal-latency.py \
  --targets xingular,pi,opencode --repeats 1 --scenarios idle,stream,burst \
  --rounds 2 --length 30 --interval 0.035 --width 80 --height 24 \
  --warm-idle-seconds 2 --idle-seconds 1 --stream-seconds 4 \
  --output /tmp/harness-perf-compact
```

Harness-only question latency and deterministic runtime overhead:

```sh
/tmp/harness-perf-venv/bin/python scripts/profile-terminal-latency.py \
  --targets xingular --repeats 1 --scenarios question --rounds 2 --length 30 \
  --width 160 --height 45 --warm-idle-seconds 1 --idle-seconds 1 \
  --stream-seconds 3 --output /tmp/harness-perf-question

npm run profile:session-runtime -- --iterations 5 --warmup 1 \
  --output /tmp/harness-session-runtime.json
```

For terminal behavior verification, run `python scripts/verify-terminal.py` with the same Python
environment. `npm run profile:terminal-input` measures the local draft-control socket separately;
it is not a substitute for the PTY latency run.
