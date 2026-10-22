---
id: EXP-0002
title: OpenTUI terminal typing latency against pure Pi and opencode
status: completed
created: 2026-10-21
updated: 2026-10-21
related: [EXP-0001, ADR-0006]
---

# EXP-0002 — OpenTUI terminal typing latency

## Question and falsifiable hypothesis

Why does typing in the Harness terminal feel slow, and do targeted frontend changes bring its
keystroke-to-screen latency and CPU use in line with pure Pi and opencode while idle, after a long
history, and while a reply streams?

Hypotheses, from code review before measuring: (1) the renderer's continuous mode makes every key
wait for a frame tick; (2) every change rebuilds the whole view and the Solid tree, and a streamed
delta recreates the reply's markdown renderable; (3) each runtime event publishes synchronously, with
no coalescing; (4) per-request socket connections add steady CPU. EXP-0001 measured the old Pi
frontend, which ADR-0006 removed, so it says nothing about this frontend.

## Targets and controls

- **Xingular Harness:** `node dist/cli.js` with isolated `--state` and `--data`, an API-key account,
  and the loopback model in the account's shared `models.json`.
- **Pure Pi:** `@earendil-works/pi-coding-agent` 1.2.0 `dist/bundle/cli.js` with an isolated
  `PI_CODING_AGENT_DIR` (never `~/.pi`).
- **opencode:** v2.1.0, `--standalone`, isolated XDG folders and an `OPENCODE_CONFIG` that points an
  `@ai-sdk/openai-compatible` provider at the loopback model.
- **Fixed:** 160 by 45 PTY, `TERM=xterm-256color`, `COLORTERM=truecolor`; four rounds of 60 keys
  from `zqxjkvwy` (never produced by the replies) at 35 ms; the first 8 keys of a round are not
  scored; the loopback server answers all three targets identically.

## Scenarios

- **idle:** a fresh session, nothing running.
- **history:** after the model has looped 80 `read` tool calls (about 240 messages).
- **stream:** three rounds typed while a reply streams 60 markdown chunks per second for 30 s, with
  headings and code blocks. In a full run this follows `history`, so it streams over a long session.
- **approval / question** (Harness only): typing while a tool approval, then an `ask_user` question,
  waits above the composer.
- **real:** `--real` runs `stream` with each tool's own login; for Harness, the Codex account on
  `openai-codex` / `gpt-6-luna`.

## Metric and measurement

Latency is the time from writing a key to the PTY until the typed prefix ending at that key is
visible on a pyte virtual screen (nearest-rank p50/p95/p99, max). CPU is the tree's CPU time from
`ps` over the typing window. Bytes per key is PTY output divided by keys. Hot paths were found with
`bun --cpu-prof --cpu-prof-md` through `XINGULAR_HARNESS_BUN`.

The metric includes the frontend, the PTY and pyte parsing; it does not include a terminal emulator's
paint. A key that never appears (dropped) is stamped when later text shows, so dropped keys appear
as very large latencies rather than as misses.

## Success criteria

Harness p95 at or below opencode's and within 1.5 times pure Pi's in every scenario, idle latency
that does not grow with history, and streaming CPU no higher than opencode's.

## Reproduction

```sh
npm run build
python3 scripts/profile-terminal-latency.py --targets xingular,pi,opencode --output <dir>
python3 scripts/profile-terminal-latency.py --targets xingular --scenarios question --output <dir>
python3 scripts/profile-terminal-latency.py --real --targets xingular --setup /model '\r' gpt-6-luna '\r' --output <dir>
```
