# Handoff — 2026-11-05

One session runtime (ADR-0083), and now hosts on it (ADR-0084). The harness keeps a conversation's Pi
session open across turns, the terminal is a client of the harness by default, a long-lived harness
(the "app-server", `xagent --daemon`) lets a reply outlive its window, and a host (the App's sidecar)
can connect to that same harness instead of embedding its own. **Nothing from 2026-11-05 is
committed.** The last release is `2.1.0-unstable` (`30b5c49`). The daemon and the host's daemon mode
are both **opt-in**; "What is left" says what finishes them.

Decision and evidence: [`docs/decisions/ADR-0083-one-live-session-runtime.md`](docs/decisions/ADR-0083-one-live-session-runtime.md)
and [`ADR-0084`](docs/decisions/ADR-0084-hosts-on-the-long-lived-harness.md). Known drift D-33 records
the gap between what is built and what is the default.

## What changed on 2026-11-05

Uncommitted in two repositories; commit them separately.

**`agent-harness`**

| Area | Files |
|---|---|
| Version handshake, idle exit, off switch | `src/server/daemonClient.ts` (new: lock, `connectDaemon`, version/launch check, socket-path guard), `src/terminal/daemon.ts`, `standalone.ts` (`--no-daemon`, `XINGULAR_DAEMON`, `DAEMON_BY_DEFAULT = false`), `src/core/version.ts` (new), `cli.ts`, `scripts/dev.mjs` |
| Remote control of live sessions (PAR-018) | `src/sessions/liveDecisions.ts` (new, shared with `LiveTerminal`), `src/remote/liveSessionPort.ts`, `sessionRemotes.ts` (new: `Harness.remotes`, `SwitchablePort`), `sessions/live.ts` (`onEnd`), `terminals.ts` (detach keeps the pairing), `server/methods.ts` (`sessions.remoteControl.*`) |
| Hosts on the daemon (ADR-0084) | `src/server/hostHub.ts` (new), `socket.ts` (`host.register`, `HarnessClient.handle`), `serve.ts` (`attach` options), `daemon.ts` (`DaemonLaunch`, `--host-config`), `remote.ts` (`mode` in policy calls), `methods.ts` (`harness.open` is idempotent) |
| Spec | pages 02, 10 (hosts section, INV-SRV-7), 11, 12, 15 (INV-RC-3/5/7/9), `README.md` D-33, `docs/parity.md` PAR-018/019, ADR-0084, `docs/README.md`, `CHANGELOG.md` |

**`agent-app`** (a repository with a lot of the owner's own uncommitted work: take only these hunks)

- `sidecar/src/daemonMode.ts`, `daemonMode.test.ts`, `schemaType.ts` (new); `main.ts` (mode switch);
  `app.ts` (`resolveSidecarRoots` extracted, nothing else changed); `agentRuns.ts` (`RunHarness` type);
  `host.ts` (`directorySnapshot`).
- `src-tauri/src/sidecar.rs`, `runs.rs` (`catch_up`), `harness.rs` (`remote_control` command), `lib.rs`.
- `src/bridge/commands.ts` (`remoteControl`), `src/modes/solo/soloCommands.ts` (`/rc` page, tests),
  `SoloConversation.tsx` (one line).

How to use it:

- `xagent --daemon`, `xagent attach`, `xagent daemon start|stop|status` as before; `--no-daemon` or
  `XINGULAR_DAEMON=0` keeps a window's own harness. `status` now shows the version and hosts.
- The App as a host: start it with `XAGENT_HARNESS_MODE=daemon`. The sidecar writes
  `<state>/host-launch.json`, starts `dist/cli.js daemon run --host-config` if no matching daemon
  runs, registers as `xingular-agent`, and forwards every harness method Rust calls. Quitting the App
  only disconnects; the next start catches up from the run logs (`RunTracker::catch_up`).
- `/rc` in an App Solo conversation starts remote control for that conversation (`/rc off`,
  `/rc tailscale|lan`) and shows the link, devices and a pair request to allow or deny.

## Verified (2026-11-05)

- Harness: `npm run typecheck` clean; `npm test` 1,877 passed, 4 skipped (up from 1,852 at the start of
  the day); `npm run prove` passed, with `dist/cli.js` rebuilt. **One full run failed one test and I
  did not capture which**: the output was cut to its tail. Five full runs after it passed with no
  failure. The load-sensitive `runtime.socket.test.ts` (an `ECONNREFUSED`, first noted on
  2026-11-04) is the likely candidate, but that is a guess. Watch for it.
- Sidecar: 93 tests, 4 of them new and run against a real daemon in the same process with a fake Pi
  session and a fake Rust host. App root tests: 613 pass; the one failure is the old `/goal` test
  (PAR-017). `check:layers` still reports the same nine `computer_*` names in the harness tree,
  none of them from this change. `cargo test`: 193 pass.
- **Not verified:** the desktop App has not been launched in daemon mode, or in its default mode,
  after these changes. No real model request was made. `npm run build` of the sidecar was not run
  (it bundles `dist/cli.js` for the daemon). The remote-control page was not looked at on a phone.

## What is left

1. **Launch the App** in both modes on a throwaway profile (`run` skill): a chat turn, a follow-up, a
   steer, `/rc` pairing from a phone, then quit mid-reply and reopen with
   `XAGENT_HARNESS_MODE=daemon`. Run `npm run build:sidecar` first.
2. **Soak.** Run a daemon for a day or more with terminal windows and the App on one state folder
   (`xagent daemon status`). Then one live stall-guard check on the permitted models only
   (`opencode-go/deepseek-v4.1-flash`, `openai-codex/gpt-6-luna`), with the owner's permission.
3. **Flip the default**, only after 1 and 2 and a few days of use: set `DAEMON_BY_DEFAULT = true` in
   `terminal/standalone.ts`, drop the forcing in `scripts/dev.mjs`, make the App's daemon mode the
   default in `sidecar/src/main.ts`, update pages 10, 11, 12, ADR-0083 ("opt-in"), the help text and
   the release notes, and close D-33.
4. A **hung plugin** in the daemon is untested. The failure tests that exist cover: a killed
   daemon's running reply recorded as interrupted by the next one, a state folder too deep for the
   socket (`socket_path_too_long`, the window falls back to its own harness), a window refused for a
   session another window holds, and a stale or differently launched daemon.
5. Things that behave differently in a host's daemon: a terminal window in that daemon has no generic
   browser (the host's launch sets `browser: false`); the host's data root is the daemon's, so
   `app.open` of another root moves it for every window; the sidecar still reads and seeds the variant
   store on disk (`ensureHarness`), as it did before.
6. Carried over: **D-32** (list wrapping), plugin presentation in the client terminal (INV-TUI-8), the
   provider request timeout, and the App's unrelated `/goal` test and UI typecheck errors.

## Things that are easy to get wrong

- A live session serves a run only when every pin matches (account, variant version, capability
  set, folders, tools, system prompt, model, effort, run-scoped extension names). Anything else
  closes it at the turn boundary and opens a new one on the same history. That is not an end:
  `LiveSessions.onEnd` fires only for a close on request, idle, or at harness close, and only that
  ends a host's remote-control pairing.
- A terminal's pairing ends with its window, or with the reply of a closed window; a host's ends with
  its live session. `Terminals.dispose(id, keepRemote)` is how `detach` keeps it.
- A session belongs to the host whose connection started its run. A run with no host is never gated by
  a host's policy; a host that is gone fails its sessions' calls and approves nothing.
- Client terminal runs record Pi's session id as `nativeSessionId`; in-process terminal runs record the
  history file. Terminal features look runs up through `Terminals.nativeOf`/`historyFileOf`.
- A command run, `sessions.navigate` or `sessions.rename` on a conversation with an idle live session
  closes that session first, and is refused while it is replying.
- The client never interrupts a reply when it closes; the parent decides (dispose interrupts, detach
  keeps it).
- The stall guard is in `runTurn`; the in-process terminal still has its own watch. Both use
  `sessions/stallWatch.ts`.
- Verifier layouts: names in the palette and `/help` carry their owner (`terminal-verifier:…`) and wrap.
