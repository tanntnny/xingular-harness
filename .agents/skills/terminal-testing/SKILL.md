---
name: terminal-testing
description: Test the Harness terminal (OpenTUI frontend) for behaviour and typing/streaming performance, including real-model runs. Use when changing src/terminal/, measuring input lag, or comparing with opencode or pure Pi.
---

# Terminal testing

## Model for real-credential runs

Use **GPT-6 Luna (`openai-codex` / `gpt-6-luna`) on the Codex account** for every test that talks to a
real model. Other models on that ChatGPT login are refused (`gpt-5.5` on `openai` or `openai-codex`,
`gpt-5.3-codex-spark`). Select it in the terminal with `/model`, search `gpt-6-luna`, Enter; the
profiler does this with `--setup /model '\r' gpt-6-luna '\r'`.

Never copy an OAuth account's tokens into another tool's folder: refresh tokens rotate, and a second
client can sign the account out. Never launch against `~/.pi`, `~/.codex` or `~/.claude`.

## Order

1. `npm run typecheck`, `npm test` (focused: `npx vitest run src/terminal`).
2. `npm run build` — the terminal runs `dist/terminal-opentui.js`; source edits do nothing until built.
3. Behaviour: `python3 scripts/verify-terminal.py` (loopback provider, no credentials).
4. Latency: `python3 scripts/profile-terminal-latency.py --targets xingular --output <scratch dir>`.
   Scenarios `idle`, `history` (240-message tool loop), `stream` (~200 tokens/s). Add `pi,opencode`
   to `--targets` to compare; opencode runs `--standalone` in isolated XDG folders.
5. Real model: `python3 scripts/profile-terminal-latency.py --real --targets xingular --setup /model '\r' gpt-6-luna '\r' --output <dir>`.
   Check `<dir>/xingular/stream-end.txt` shows streamed text, not an error; a refused model makes
   the run measure an idle screen.
6. App checks after a Harness change (see `../AGENTS.md`).

## Reading the numbers

- Latency is keystroke → character visible on a pyte screen; report p50/p95/p99/max.
- Runs that only use `stream` start fresh; the full run streams on top of `history`. Compare like
  with like.
- CPU% is the whole process tree from `ps`, including the Harness node process.
- To find hot code, set `XINGULAR_HARNESS_BUN` to a wrapper that runs
  `bun --cpu-prof --cpu-prof-md --cpu-prof-dir=<dir> "$@"`.

Results and method history: `docs/experiments/EXP-0002-opentui-typing-latency/`.
