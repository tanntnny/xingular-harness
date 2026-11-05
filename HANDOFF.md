# Handoff — 2026-11-05 (second session; released as 2.2.0-unstable without a test run, by request)

> **Current continuation (2026-11-05):** the original handoff below records the Harness 2.2 daemon
> release. The browser-migration status and remaining work in this addendum are current; follow
> [ADR-0035](../agent-app/docs/decisions/ADR-0035-dsh-desktop-browser-and-electron.md) and
> [FEAT-0004](../agent-app/docs/features/FEAT-0004-browser-workspace.md) for the accepted target.

## DSH sidebar browser migration — current handoff

**Target.** Replace the App's person-facing Tauri/WebKit sidebar browser with an Electron/Chromium
host matching DSH Desktop's guest, controller, and lease boundaries. Use DSH checkout
`external/deepseek-harness` pinned at `8bd073392eef6f54e921a093b95076248eb08cbb` as the reference.
Keep the browser in the existing sidebar. Its workspace partition is process-lifetime; only a
person-requested tab title and URL may be restored. Agent browsing stays separate: the App uses the
Harness-selected isolated Chromium or explicitly paired Brave backend, never sidebar tabs.

**Completed safe slice.** App sidecar initialization enables Harness's Browser plugin in both direct
and daemon modes ([`app.ts`](../agent-app/sidecar/src/app.ts),
[`daemonMode.ts`](../agent-app/sidecar/src/daemonMode.ts)). App tools and the connected-apps broker
no longer expose browser aliases; `browser_upload` is retired from active settings while its ID
remains readable for older saved settings ([`shared/appTools.ts`](../agent-app/shared/appTools.ts),
[`sidecar/src/appTools.ts`](../agent-app/sidecar/src/appTools.ts),
[`sidecar/src/appPlugins.ts`](../agent-app/sidecar/src/appPlugins.ts),
[`shared/contracts.ts`](../agent-app/shared/contracts.ts),
[`src-tauri/src/agents.rs`](../agent-app/src-tauri/src/agents.rs)). Source tests cover ownership
and fail-closed backend separation ([`app.test.ts`](../agent-app/sidecar/src/app.test.ts),
[`appPlugins.test.ts`](../agent-app/sidecar/src/appPlugins.test.ts),
[`daemonMode.test.ts`](../agent-app/sidecar/src/daemonMode.test.ts)). The decision, current status,
parity entry, and packaged-App acceptance checks are recorded in
[ADR-0035](../agent-app/docs/decisions/ADR-0035-dsh-desktop-browser-and-electron.md),
[FEAT-0004](../agent-app/docs/features/FEAT-0004-browser-workspace.md), the
[App implementation-stage log](../agent-app/docs/architecture/implementation-stage.md), and
[the Harness parity register](docs/parity.md).

**Still not implemented.** [`BrowserWorkspace.tsx`](../agent-app/src/modes/shared/BrowserWorkspace.tsx)
and [`useBrowserWorkspace.ts`](../agent-app/src/modes/shared/useBrowserWorkspace.ts) still call the
Tauri host; [`browser_workspace.rs`](../agent-app/src-tauri/src/browser_workspace.rs) still creates
WebKit child views. There is no Electron main/preload host, Chromium guest lease, Electron packaging
path, or packaged-App acceptance. The existing WebKit profile, browser records, Keychain credentials,
sharing, and upload paths remain in the worktree. Do not delete or silently migrate that data, and do
not run both hosts against the same live browser data. The current visible browser remains
Tauri/WebKit until the host migration is actually integrated.

**Next work, in order.**

1. Re-read [App `AGENTS.md`](../agent-app/AGENTS.md), [ADR-0035](../agent-app/docs/decisions/ADR-0035-dsh-desktop-browser-and-electron.md), [FEAT-0004](../agent-app/docs/features/FEAT-0004-browser-workspace.md), and [STUDY-0011](docs/study/STUDY-0011-dsh-browser-embedding.md). Review DSH's pinned [guest broker](external/deepseek-harness/apps/desktop/src/browser-guests.ts) and [browser package](external/deepseek-harness/packages/client/ui-sidebar-browser/README.md).
   Audit the App [command bridge](../agent-app/src/bridge/commands.ts), Rust OS integrations, sidecar protocol, and packaging before changing startup. The App and Harness worktrees contain extensive uncommitted work; inspect focused diffs and do not reset or overwrite it.
2. Define the Electron host/preload boundary for the existing App API and keep the Harness sidecar and run protocol working. A remote website must never receive Node, preload, or App-command access.
3. Port the sidebar browser controller and page carrier to Chromium guests. Put guest creation, attachment, navigation, workspace-partition assignment, and lease revocation under main-process control; validate the workspace owner and navigation on every operation.
   Follow current Electron security guidance rather than treating DSH's `<webview>` as a drop-in Tauri component; see [STUDY-0011](docs/study/STUDY-0011-dsh-browser-embedding.md).
4. Preserve the old WebKit profiles, browser records, and Keychain entries for recovery. Do not copy them into the ephemeral Chromium partition. Retire WebKit-specific sharing, credential, and upload behavior only as part of the integrated migration, with an isolated rollback/probe profile and no concurrent use of the same browser data.
5. Run the acceptance list in [FEAT-0004](../agent-app/docs/features/FEAT-0004-browser-workspace.md) against a packaged Electron App: lease and guest isolation, navigation, partition lifetime, denied popup/permission/download paths, manual URL restoration, agent-browser separation, and the App's non-browser OS integrations.
   Update the [implementation-stage record](../agent-app/docs/architecture/implementation-stage.md) only for behavior actually built and verified.

**Verification at this continuation.** App sidecar tests passed (95); App Rust tests passed (197,
1 ignored); `check:ui` passed against its 38-finding baseline; and scoped `git diff --check` passed.
No Electron host or packaged-App walkthrough was run. Current-worktree failures to recheck while
working include the App renderer's [`/goal` handler test](../agent-app/src/modes/solo/soloCommands.test.ts)
(615 other tests passed), App typecheck UI prop errors, nine `computer_*` findings in
`check:layers`, and Harness/sidecar type errors around `SelectionPatch` in
[`harnessRuntime.ts`](src/terminal/tui/harnessRuntime.ts) and [`runtime.ts`](src/terminal/tui/runtime.ts).
These are not evidence about the Electron migration; rerun the checks after integration and keep
unrelated failures separate.

The long-lived harness (the "app-server", `xagent daemon`) is now the **default** for the terminal and for
the App's sidecar (ADR-0085). It was opt-in at `2.1.0-unstable`. Decisions and evidence:
[`ADR-0083`](docs/decisions/ADR-0083-one-live-session-runtime.md) (one live-session runtime),
[`ADR-0084`](docs/decisions/ADR-0084-hosts-on-the-long-lived-harness.md) (hosts connect to it),
[`ADR-0085`](docs/decisions/ADR-0085-the-long-lived-harness-is-the-default.md) (it is the default).

## Commit state

- `agent-harness`: `cfd697a` holds the first session's work (version handshake, idle exit, remote control of
  live sessions, hosts); `5d41915` the second's (daemon robustness, terminal parity, host layer fixes, the flip,
  docs); the release commit `release: prepare @xingular/harness 2.2.0-unstable` (tag `v2.2.0-unstable`, local,
  not pushed, not published) follows. The release commit was made **without rerunning the tests, by request**.
  `docs/study/00-index.md` and `docs/study/STUDY-0010-plugin-reach.md` are not ours; they stay out of commits.
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
7. Complete the DSH sidebar browser migration described in the current continuation above. Agent-browser
   separation is done; the visible sidebar is still Tauri/WebKit, and the Electron host, Chromium guests,
   data-preservation path, and packaged-App acceptance remain open.

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
