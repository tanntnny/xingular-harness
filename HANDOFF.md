# Handoff — 2026-11-05 (second session)

The long-lived harness (the "app-server", `xagent daemon`) is now the **default** for the terminal and for
the App's sidecar (ADR-0085). It was opt-in at `2.1.0-unstable`. Decisions and evidence:
[`ADR-0083`](docs/decisions/ADR-0083-one-live-session-runtime.md) (one live-session runtime),
[`ADR-0084`](docs/decisions/ADR-0084-hosts-on-the-long-lived-harness.md) (hosts connect to it),
[`ADR-0085`](docs/decisions/ADR-0085-the-long-lived-harness-is-the-default.md) (it is the default).

## Commit state

- `agent-harness`: `cfd697a` holds the first session's work (version handshake, idle exit, remote control of
  live sessions, hosts). **This session's work is uncommitted** (daemon robustness, terminal parity, host
  layer fixes, the flip, docs). `docs/study/00-index.md` and `docs/study/STUDY-0010-plugin-reach.md` are not
  ours; leave them out of the commit.
- `agent-app`: nothing from either session is committed. The repository has a lot of the owner's own
  uncommitted work, and `src/modes/solo/soloCommands.ts` and its test are **untracked as whole files**, so the
  `/rc` change cannot be split from the owner's file. Touched files are listed below.

## What changed this session

**`agent-harness`**

| Area | Files |
|---|---|
| Daemon robustness | `server/daemonClient.ts` (lock created whole and linked; stale lock when the socket refuses; start logged to `harness.log`, child watched, fail fast; lock records `dataRoot`, `accountState`, `build`), `terminal/daemon.ts`, `server/socket.ts` (a closed client rejects at once; a dropped window is detached or disposed) |
| Terminal parity and default | `terminal/standalone.ts` (`DAEMON_BY_DEFAULT = true`, `daemonSource`, `daemonUnsupported`, connect-phase fallback, host-credential guard, frontend env), `terminal/daemon.ts` (`--worktree`, account label, `beforeFrontend`), `scripts/dev.mjs`, `scripts/verify-terminal.py`, `scripts/profile-terminal-latency.py`, `tests/setup.ts` (`XINGULAR_DAEMON=0`) |
| Host layer | `server/hostHub.ts` (call context, LRU owners, waiting for a host, private notices), `server/serve.ts`, `server/socket.ts`, `server/methods.ts` (`harness.open` refused while windows exist), `terminal/daemon.ts` (every `daemon run` reads `<state>/host-launch.json`; no default account for a host's daemon) |
| Docs | ADR-0085, pages 10, 11, 12, 14, ADR-0083/0084, D-33 resolved, **D-34 new**, `README.md` (daemon section), `src/cli.ts` USAGE, `CHANGELOG.md`, `docs/parity.md` |

**`agent-app`** (take these hunks only)

- `sidecar/src/daemonMode.ts` (+ test), `main.ts` (daemon by default, falls back to the in-process sidecar and
  sends `harness.fallback`), `agentRuns.ts` (`ensureHarness` async, `seedVariant`), `app.ts`, `host.ts`,
  `pageNotesMigration.ts` (`migrateBrowserAnnotationsVia`), `schemaType.ts`.
- `src-tauri/src/sidecar.rs` (`daemon_wanted`, `hosted`, 2-minute grace), `runs.rs` (followed-runs journal,
  extended `catch_up`), `harness.rs` (`remote_control`), `lib.rs`.
- `src/bridge/commands.ts`, `src/modes/solo/soloCommands.ts` (+ test), `SoloConversation.tsx`;
  `docs/architecture/overview.md`, `implementation-stage.md` (quit text).

Kill switches: `--no-daemon`, `XINGULAR_DAEMON=0` (terminal); `XAGENT_HARNESS_MODE=inprocess` (App).
`XINGULAR_DEV_DAEMON=0` for `npm run dev`.

## Verified (2026-11-05)

- Harness: typecheck clean; `npm test` 1,890 passed, 4 skipped (1,852 at the start of the first session);
  `npm run prove` passed. The PTY verifier (`python3 scripts/verify-terminal.py`) passed the full run at
  40x20, 80x24 and 120x40 against the window's own harness, and seven focused suites (welcome, composer,
  history, resume, queue, questions, compaction) pass with the daemon as the window's harness
  (`VERIFY_TERMINAL_DAEMON=1`). **Not run in daemon mode:** the full run and the browser, palette, accounts,
  trajectory, attachments, thinking and other focused suites.
- **A flaky test, not ours:** `src/terminal/tui/runtime.socket.test.ts` ("submits grouped terminal answers
  atomically...") fails with `ECONNREFUSED` on the terminal's session socket in some full runs, never alone.
  The code from before the first session (`30b5c49`) failed it in 2 of 3 full runs, the current code in 1 of 5
  (3 of 3 clean in the controlled comparison). Neither the test nor `terminal/socket.ts` changed.
- Sidecar: typecheck clean, 97 tests (13 new). App root: 613 pass, 1 fails (the old `/goal` test, PAR-017);
  `check:layers` reports the same nine `computer_*` names; `check:ui` passes at its baseline.
  Rust: `cargo test` 197 passed.
- **Real processes** (not unit tests): the built sidecar (`node sidecar/dist/main.js`, default mode) started a
  real detached daemon and was ready in 1.5 s; `system.ping` reported `mode: daemon`; 256 methods answered
  (`refine.list` included); the daemon survived the sidecar's exit and was stopped by `xagent daemon stop`; its
  lock carried the launch hash, data folder and build. With a terminal's daemon already in use, the sidecar
  stayed up, ran its own harness and sent `harness.fallback`.
- **Not verified:** the Tauri desktop app has not been launched (it needs an Apple development identity and a
  display, which a headless run does not have), so the Rust relaunch path, the renderer, the `/rc` page, and
  the fallback notice's display have only unit-level or protocol-level checks. No real model request was made.
  The sidecar's npm dependencies are not installed in `agent-app/sidecar` on this machine (the real-process
  runs linked the harness's `node_modules`); a normal `npm --prefix sidecar install` is needed to run the
  desktop app.

## What is left

1. **Launch the desktop app** in default mode on a throwaway profile and walk it: a chat turn, a follow-up and a
   steer, refinement, a side question, `/rc` from a phone, a terminal window open at the same time (start it
   first, then the App, and the reverse), quit mid-reply and reopen, kill the daemon during a reply.
   Needs `npm --prefix sidecar install`, `npm run build:sidecar` and `npm run tauri dev`.
2. **Soak**: one day with several windows and the App on one state folder (`xagent daemon status`). A live
   stall-guard check only on `opencode-go/deepseek-v4.1-flash` or `openai-codex/gpt-6-luna`, with permission.
3. **D-34**: the agent's shell runs with the daemon's environment. Fix by sending an environment snapshot in
   `terminal.prepare` and applying it through Pi's `BashSpawnHook` (`node_modules/@earendil-works/pi-coding-agent`,
   `core/tools/bash.d.ts`). Until then, `--no-daemon` for work in a different environment.
4. Methods the Rust host and renderer call that no harness table has, in either mode (listed and enforced in
   `sidecar/src/daemonMode.test.ts`, `ALREADY_UNANSWERED`): `annotations.queue|dequeue|queued`,
   `memory.permissions`, `references.pin`, `wiki.ingest`, `blocks.list`, `context.profiles`, `skills.list`,
   `wiki.reindex`. They were already `unknown_method`; each is its own bug.
5. A hung plugin in the daemon is untested. The doctor's `live` probe for computer control is not registered
   with the daemon (its local check is).
6. Carried over: D-32 (list wrapping), plugin presentation in the client terminal (INV-TUI-8), the provider
   request timeout, the App's `/goal` test and UI typecheck errors, and the nine `computer_*` names in
   `check:layers`.

## Things that are easy to get wrong

- A live session closes at a pin change without ending the conversation; only a close on request, idle, or at
  harness close ends a host's pairing (`LiveSessions.onEnd`). A terminal's pairing ends with its window, or with
  the reply of a closed window.
- A session belongs to the host whose **call** started the run (call context), not whose method name was used.
  A run with no host is never gated by one; a host that stays away past two minutes fails closed.
- The daemon's idle exit counts windows, live sessions, pairings and connections. A killed window used to hold
  it open; its connection closing now detaches or disposes it.
- `daemonSource` decides whether a window that cannot have the daemon is told or runs its own: default is
  quiet, `--daemon` / `XINGULAR_DAEMON=1` is loud, except version and folder mismatches.
- On a profile whose credentials an application keeps, a window never starts a daemon.
- The App's sidecar must not create its stdio peer before the daemon is connected; two peers on one pipe both
  answer. `createDaemonSidecar` connects first and marks later failures `afterConnect`.
- Client terminal runs record Pi's session id as `nativeSessionId`; in-process terminal runs record the history file.
- A command run, `sessions.navigate` or `sessions.rename` on a conversation with an idle live session closes that
  session first, and is refused while it is replying.
