---
id: ADR-0083
title: One live session runtime in the harness
status: accepted
created: 2026-11-03
updated: 2026-11-03
related: [ADR-0001, ADR-0035, ADR-0056, INV-RUN-1, INV-SRV-1, INV-SRV-4, INV-TUI-2, INV-RC-5, INV-PAR-1, INV-PAR-2, PAR-008, PAR-018]
supersedes: null
superseded_by: null
---

# ADR-0083 — One live session runtime in the harness

## Context

The harness runs a conversation in two different runtimes:

- **Structured sessions** (`xagent serve`, the App sidecar): `Sessions.run` opens a Pi session for
  one run and disposes it when the run settles (`sessions/runner.ts`, `piSessionFactory` and the
  `finally` of `runTurn`).
- **The terminal**: a Bun child keeps one Pi `AgentSessionRuntime` alive across turns
  (`terminal/tui/runtime.ts`). Its gate, telemetry and run accounting go through
  `terminal/piExtension.ts`, the session socket and `TerminalController`.

ADR-0001 chose the second runtime because calling `sessions.run` per prompt "recreates and disposes
the runtime per turn, losing persistent plugin UI/queue state". That reason still holds for the
structured path as it is built today.

Two runtimes mean many lifecycle features are built twice and drift: plan-outcome repair (D-22),
the queued-message rules, work slices (a headless run continues as a new run, a terminal reply in
place), stall guards (`terminal/stallWatch.ts`, now `sessions/stallWatch.ts`), `get_capabilities`, and about fifteen private
`terminal.*` routes that mirror public methods. A terminal session cannot be reached from the App
(PAR-018) and the two keep separate session catalogs (PAR-008). A run ends when its window closes.

Codex keeps the agent loop in one server process (`codex app-server`) and makes every front end a
client of it: threads, turns and items over JSON-RPC, approvals as server-to-client requests.
Claude Code keeps the loop inside the CLI process and lets other front ends spawn that process.
The harness's server protocol (page 10) and run events (page 02) already have Codex's shape
(session ≈ thread, run ≈ turn, run events ≈ items). The missing part is a live session the server
owns across runs.

## Decision

The harness owns one session runtime. A *live session* is a Pi session the harness keeps open
across runs of the same native conversation. Every front end, including the terminal, reaches it
through server methods. The terminal keeps its owned OpenTUI presentation (the screen half of
ADR-0001); only its private runtime goes away.

Work proceeds in phases; each lands with its spec pages and checks.

1. **Live sessions.** A `LiveSessions` service in `src/sessions/` keeps a Pi session open between
   runs. `Sessions.run` reuses it when the new run's pins match the open session, and opens a fresh
   one otherwise. Unattended triggers (`probe`, `improver`, `reflection`) and refinement keep the
   per-run open and dispose. A caller opts in with `sessions.run { live: true }`; the first such run
   opens the live session. Additive methods: `sessions.live`, `sessions.close`, `sessions.followUp`,
   `sessions.followUp.clear`. Steering stays `runs.steer`, and replay stays `runs.since`, which
   already exist. The App adopts this first.
2. **The terminal as a client.** The OpenTUI child talks to the harness over the protocol on a
   local socket and renders from run events. The private `terminal.*` mirrors give way to the
   public methods, scoped by the caller identity the control key proves. The old path stays behind
   a flag until production PTY acceptance at 40x20, 80x24 and 100x30, then is removed.
3. **Optional daemon.** Decided after phase 2: a long-lived `xagent serve --daemon` on a Unix
   socket under the state directory, with one writer per data root, so a run outlives its window,
   and remote control belongs to a live session rather than a terminal (PAR-018).

### Phase 1 design: what a run binds

A run pins its account, variant version and capability set (INV-RUN-1), so a live session may only
serve a run whose pins equal the session's. The reuse key is: account, variant version, frozen
capability fingerprint, working folder and workspace root, plan flag, allowed tool names, the
stable system prompt, and the loaded plugin set. Model and effort changes go through Pi's own
setters. Any other difference closes the live session at the turn boundary and opens a new one on
the same native history, as `/variant` already does (ADR-0065).

Today these are created per run and baked into the Pi session when it opens
(`sessions/sessions.ts`, the `params` and `factory` call; `sessions/runner.ts`,
`piSessionFactory`). Each must read a *current run binding* that `LiveSessions` swaps at the start
of every run:

| Bound per run today | Where | Becomes |
|---|---|---|
| The gate (`checkDetailed`, workspace scope requests, plan refusals) | `gatedExtension` in `piSessionFactory` | A session-level `tool_call` handler that asks the current binding's gate |
| Custom tool specs bound to the run (`spec.execute`) | `customTools` in `piSessionFactory` | Session-level tool definitions that call the current binding's spec of the same name |
| The extension host (`ask`, `notice`) | `bindExtensions` in `piSessionFactory` | A host that forwards to the current run, and refuses between runs |
| `runLineageJoin(root, runId)`, `subagents.extension(runId)` | `params.inline` | Extensions that read the current run id |
| Compaction checkpoint (`initialTodo`, plan instructions) | `params.inline` | Reads the current run's todo and plan flag |
| Work-slice guard and goal loop (their state and controller) | `params.inline` | Installed once, enabled and fed by the current binding |
| `onRefusal`, `activatedPlugins`, the heartbeat and `settle` | `params`, `runTurn` | Already per run in `runTurn`; unchanged |

`runTurn` stops disposing the session; `LiveSessions` disposes it on `sessions.close`, on a pin
change, after an idle timeout, and at harness shutdown. A live session runs one run at a time; a
second `sessions.run` while one is active is refused, or delivered as a steer or follow-up when the
caller asks for that.

## Alternatives and rejection reasons

- **Keep two runtimes.** Every lifecycle feature keeps its second copy, and the drift and parity
  lists keep growing.
- **Claude Code's model** (the terminal process is the engine, hosts spawn it). Simple for one front
  end, but the App, the phone surface and evaluation would each drive a terminal process, and the
  structured path would remain a second runtime.
- **Make the terminal call today's `sessions.run`.** Rejected by ADR-0001 for the same reason it
  gives: a per-run runtime loses queues and persistent plugin UI. Phase 1 removes that reason first.
- **A rewrite in one release.** Too large to verify; each phase must pass the full checks and, for
  phase 2, production PTY acceptance.

## Consequences and risks

- This is a 2.0-level change: it adds methods and a socket transport (INV-SRV-1, INV-SRV-4),
  changes who owns execution in the terminal (INV-TUI-2), and moves remote control's lifetime
  (INV-RC-5). Pages 02, 10, 11, 14 and 15 change as each phase lands.
- Every inline extension must be safe to keep across runs. A missed per-run closure would leak one
  run's state into the next; phase 1 tests run two turns on one live session and check each run's
  events, refusals and records belong to that run only.
- Streaming over IPC adds latency to the terminal; phase 2 measures first-delta latency before and
  after.
- Live checks may use real model requests only with the owner's permission (granted for this work
  with a Codex account on Luna 6, or the OpenCode account on DeepSeek V4.1 Flash), never against
  `~/.codex`, `~/.claude` or `~/.pi`.

## Evidence — phase 1, 2026-11-03

Implemented in `src/sessions/live.ts`, `src/sessions/runner.ts` (`rebind`, `release`, run slots),
`src/sessions/sessions.ts` (`live`, follow-ups) and `src/server/methods.ts`. `src/sessions/live.test.ts`
covers reuse across runs, a pin change, the per-run default, busy refusal, queued, idle and parked
follow-ups, close and shutdown, refusal for unattended runs, and a rebind of a real Pi session (an
`input` handler and a bound tool replaced by the next run's) with no model request. Harness:
1,803 tests passed, `npm run prove` passed. App sidecar typecheck and 89 tests passed against this
tree.

Live check with owner permission, account OpenCode, model `opencode-go/deepseek-v4.1-flash`, a
throwaway data root and the installed sign-in:

| Run | Live | Status | Native session | Session ready (ms) | Input tokens | Cache read |
|---|---|---|---|---|---|---|
| b1 | no | completed | `01a19f83-2ef3…` | 1002 (cold start) | 4796 | 0 |
| b2 | no | completed | same | 73 | 73 | 4736 |
| l1 | yes | completed | `01a19f83-408c…` | 75 | 4796 | 0 |
| l2 | yes | completed | same, reused | 52 | 73 | 4736 |
| l3 | yes, steered | completed | same, reused | 59 | 326 | 9472 |

The live session served three runs (`runs: 3`). Reuse keeps the provider cache exactly as the
per-run path does. A steer sent after the first delta was recorded as `message.steered` and the
model answered it in the same run. A reused session is ready slightly sooner (52–59 ms against 73 ms
warm); the larger gains are steering, follow-ups and plugin state that survive between runs.

## Evidence — phases 2 and 3, 2026-11-03

**Phase 2, the terminal as a client.** `XINGULAR_TERMINAL_RUNTIME=harness` selects
`terminal/tui/harnessRuntime.ts`; the parent side is `terminal/liveTerminal.ts`. The in-process
runtime stays the default. Decision recorded with the owner: plugin presentation that needs an
in-process terminal is unavailable in client mode (INV-TUI-8), as it is in a host.

- Tests with real Pi and a scripted model: `terminal/liveTerminal.test.ts` (two turns on one live
  session, the native event journal, a plan-mode `ask_user` answered through the decision routes,
  busy refusal) and `terminal/tui/harnessRuntime.socket.test.ts` over the real session socket (the
  mirrored transcript, one native session, the in-process tool set, `/todo` and `/trajectory`
  lookup, the system prompt, a plan question, `/new` on a new file).
- Live, OpenCode account, `opencode-go/deepseek-v4.1-flash`, real OpenTUI frontend in a PTY at
  100x30, 80x24 and 40x20: five turns and a queued follow-up each, all completed on one native
  session. Mean time from Enter to the reply on screen for turns 2–5: client 1.60 s, 1.79 s and
  1.37 s against in-process 1.59 s at 100x30, within the model's own variation. The fixed overhead
  from Enter to the harness run starting is about 30 ms against about 5 ms in process. Startup to
  ready: 2.2–2.9 s client, 2.6–2.8 s in process.
- Found and fixed on the way: the client first lacked the world tools and had `grep`, `find` and
  `ls`, which the in-process terminal does not activate; a new conversation re-adopted the old file
  from stale state; a mode with no saved model sent none; child runs inherited `live: true` (caught
  by the App's sidecar test).
- Not passing yet: the production PTY suite stops early in client mode on a record-contract
  difference (Known drift D-28).

**Phase 3, the long-lived harness.** `server/socket.ts`, `terminal/daemon.ts`, `Terminals.detach`
and `prepare { attach }`, CLI `xagent daemon start|stop|status`, `xagent --daemon`, `xagent attach`.

- Tests: `terminal/daemon.test.ts` (one lock per state folder and a stale lock replaced, the
  protocol on an owner-only socket to several connections, a full daemon run that prepares over its
  socket, reports and stops); `harnessRuntime.socket.test.ts` (a reply keeps running when its
  window closes and a new window reattaches and sees it finish; a detached session ends when its
  reply settles).
- Live, same account and model: `xagent daemon start`, a `--daemon` window asked for 600 numbers,
  the window was hung up (SIGHUP) mid-reply; it printed the `xagent attach <id>` line, `daemon
  status` reported one live session and one reply without a window, `xagent attach` showed the
  reply finish 3.6 s later, and the run recorded `completed`. Afterwards no live or detached
  session remained and `daemon stop` removed the lock and socket.
- Found and fixed: the daemon took its lock before the state folder existed.

Checks at the end: harness typecheck clean, 1,820 tests pass, `npm run prove` passes; App sidecar
typecheck and 89 tests pass against this tree, `check:layers` flags none of the new files. Open
and unrelated to this change: the App's `soloCommands.test.ts` expects Solo to handle `/goal`
(PAR-017), and the App's root typecheck reports button-prop errors in its UI.

## The client terminal is the default — 2026-11-03

The owner asked to finish the client terminal and make it the default once it works. `xagent` now
runs the client terminal unless `XINGULAR_TERMINAL_RUNTIME=inprocess` is set. The in-process
runtime stays for plugins that need their own terminal components.

What finishing it took, each with a test:

- Parity of what a person sees: plugin notices, status lines, widgets and titles (`harness_notice`);
  a failed reply's message; a settle marker when Pi's loop never started; plugin `select`,
  `confirm`, `input` and `editor` shown with the window's own dialogs (`question.requested.dialog`);
  plugin commands listed before the first turn and sent by their owner-qualified route; a plugin
  that cannot load stops the window's start; `/goal` run as a harness goal with its state shown.
- Parity of what a turn does: plan runs carry only the plan's tools (`planTools: 'active'`); `!`
  commands run as the turn's initial Bash on a resumed history; `/session` takes a file or a session
  id; `/new` and steering ask the harness whether a reply really runs before refusing.
- Lifecycle: `/stop` and Esc return at once and Pi's abort finishes behind them; the window closes
  cleanly when its harness is gone; an uncaught error in the host closes the window before exiting
  1; a frontend left after its terminal hangs up is ended after three seconds (this also leaked
  in-process windows); the long-lived harness survives one plugin's uncaught error.
- A harness fix every host gets: a provider request that timed out and was retried and answered no
  longer marks the run failed.

Evidence:

- Harness: typecheck clean, 1,829 tests pass, `npm run prove` passes; App sidecar typecheck and 89
  tests pass; `check:layers` flags none of the new files.
- Production PTY suite (`scripts/verify-terminal.py`, its local provider, no real requests) in the
  default client terminal: the full run passes at 40x20, 80x24, 100x30 and 120x40, and so do the
  welcome, click-focus, composer, file-completion, history, resume, todo, questions, jump-latest,
  help, command-completion, attachments, dialog-paste, thinking, queue and compaction suites. The
  script now accepts what differs by design: either approval title, a question asked with or without
  an approval, either `nativeSessionId` contract, a plugin overlay the client cannot draw, a size
  shown in bytes, a varying usage-event count, and a long command name wrapped after its owner
  prefix. Browser, palette, accounts at 120x40 and trajectory at 120x40 fail the same way on the
  previous commit (Known drift D-30); markdown fails only with uncommitted work outside this change
  (D-31). The full run's `/stop` step, which allows 0.8 seconds, failed twice while the machine's
  load average was above 20 and passed every time below it.
- Live, OpenCode account, `opencode-go/deepseek-v4.1-flash`, real frontend at 100x30: five turns
  and a queued follow-up on one native session; `/stop` and Esc recorded the reply interrupted in
  33–77 ms against 35–62 ms in process; turn latency within the provider's variation. One turn hit
  a ten-minute provider timeout and its retry answered; the run now records `completed`. With
  `--daemon`, a window hung up mid-reply left the reply running; `xagent attach` showed it complete.

## Closing the migration — 2026-11-04

- **Stall guard for every harness run.** The terminal's stall rule (15 minutes without an event, 30
  with a tool running; ADR-0054, ADR-0078) lived only in the in-process controller, so a client
  terminal reply, a live session and an App turn had only Pi's own request timeout (about ten
  minutes, retried). `runTurn` now applies it to every run (`sessions/stallWatch.ts`, moved from
  `terminal/`): the run settles `interrupted` with `stalled`, the native turn is aborted, and a live
  session is closed (queued follow-ups parked), or closed under the turn if the abort has not
  unwound it after 30 seconds. A pending approval or question, and a wait for subagents (each child
  has its own guard), restart the clock. Pi's request timeout is unchanged: a shorter one multiplies
  with the retry policy and could cut a slow reasoning model's first token, so the progress rule is
  the cap.
- **Heartbeat for every run.** `runTurn` emitted `heartbeat` only for work-slice runs, against
  INV-RUN-14; a live reply with a quiet tool for 30 minutes could be settled `owner_gone`. It is now
  unconditional (slice counters zero without a slice).
- **Verifier.** The four D-30 suites asserted stale layouts, not product faults, and are fixed; the
  `/stop` step polls the run record up to 8 seconds instead of reading for 0.8; the in-process
  fallback's full run passes at 80x24 (the deny/approval-cancel stop did not reproduce). D-31 (the
  markdown suite) is the other change's fixture overflowing the screen. Tests: `sessions/stall.test.ts`
  (8) cover the guard and heartbeat.
- Not done: PAR-018 (remote control bound to a live session). Notes in HANDOFF.md.
