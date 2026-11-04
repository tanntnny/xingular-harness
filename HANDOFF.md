# Handoff — 2026-11-04

One session runtime (ADR-0083). The harness keeps a conversation's Pi session open across turns, the
terminal is a client of the harness by default, a long-lived harness (the "app-server", `xagent
--daemon`) lets a reply outlive its window, and every harness run ends when it stops making progress.
**Released as `2.0.1-unstable`** (tag `v2.0.1-unstable`, commit `49b1991`, branch `release/1.0.0`);
the workflow waits at the `npm-publish` approval until the owner approves it. The app-server is
**opt-in**; "Making the app-server the default" below says what finishes it.

The decision, design and all measured evidence are in
[`docs/decisions/ADR-0083-one-live-session-runtime.md`](docs/decisions/ADR-0083-one-live-session-runtime.md).
The previous handoff (2026-10-11, the harness split) is in git history at `21721b0`.

## Commit state

Everything is committed and pushed on `release/1.0.0` (the working tree is clean as of
`49b1991`): ADR-0083 (`97178bb`), the account-switch and per-mode model fixes, the effort-level fix,
the other person's fenced-code panels and prompt change (`fc8fa74`, now with a code-block-only
renderer, D-32) and the release commits. `2.0.0-unstable` was tagged but never published (its run
was cancelled); `2.0.1-unstable` is its first release. The App change is a separate commit in
`../agent-app` (`46924e3`); that repo holds a lot of the owner's own uncommitted work, and only the
`live: true` hunk of `sidecar/src/agentRuns.ts` is ours.

## What changed

| Area | Files |
|---|---|
| Live sessions (phase 1) | `src/sessions/live.ts` (new), `runner.ts` (rebind, run slots, `release`, retry fix), `sessions.ts` (`live`, follow-ups, `newHistory`, `hiddenNotes`, `planTools`), `subagentService.ts`, `server/methods.ts` |
| Plugin dialogs as questions | `sessions/registry.ts`, `contracts.ts` (`question.requested.dialog`), `extensionUi.ts` |
| Terminal as a client (phase 2) | `src/terminal/liveTerminal.ts` (parent, new), `src/terminal/tui/harnessRuntime.ts` (client, new), `terminals.ts` (routing, detach and attach), `opentui/app.ts` (runtime choice, `ownDialogs`), `tui/commands.ts` (`/session` by id) |
| Long-lived harness (phase 3) | `src/server/socket.ts` (new), `src/terminal/daemon.ts` (new), `serve.ts`, `standalone.ts` (shared setup, fatal and hang-up handling), `cli.ts` |
| Stall guard and heartbeat (2026-11-04) | `src/sessions/stallWatch.ts` (moved from `terminal/`), `runner.ts` (`runTurn`: unconditional heartbeat, stall guard, `handBack`), `live.ts` (`release(…, close)`), `registry.ts` (`ActiveRun.waiting`), `sessions/stall.test.ts` (new) |
| Account switch, modes and effort (2026-11-04) | `tui/harnessRuntime.ts` (fallback to the account's own model, per-mode effort, deferred mode switch, one-shot `/plan`), `tui/thinkingLevels.ts` (new: Pi's supported-level and clamp rule) |
| Fenced-code panels | `opentui/markdown.ts` (`createTranscriptMarkdownRenderer`, code-block-only), `root.tsx`, `prompt/reporting.ts` |
| App | `../agent-app/sidecar/src/agentRuns.ts`: a person's chat turns pass `live: true` (4 lines) |
| Spec | pages 02, 10, 11, 12, 14, 15; `README.md` Known drift D-28 to D-32; `docs/parity.md` PAR-004, PAR-008, PAR-018, PAR-019; ADR-0001 (runtime half superseded); ADR-0083 (new) |

How to use it:

- `xagent`: the client terminal (default). `XINGULAR_TERMINAL_RUNTIME=inprocess xagent`: the
  previous in-process runtime, for plugins that draw their own terminal components.
- `xagent --daemon`: the window runs in the long-lived harness for its folders. Closing it during a
  reply keeps the reply running. `xagent attach [session]` reconnects. Also
  `xagent daemon start|stop|status`.
- `XINGULAR_CLIENT_TRACE=<file>`: timestamped client events (runs, event batches, interrupts), for
  diagnosing a slow window.

## Verified (2026-11-04)

- Harness, on a clean checkout of `49b1991`: `npm run ci` (typecheck, 1,848 tests, `prove`) passed;
  `release:pack`, `release:smoke --terminal` (fresh install, packaged terminal in a PTY) and
  `release:preflight` passed. One test (`runtime.socket.test.ts`, a session-socket
  `ECONNREFUSED`) failed once in the first clean CI run while the machine's load was above 14; it
  passed 4 of 4 alone and in a full rerun, so it is treated as a load flake. Watch it in the GitHub
  run.
- `python3 scripts/verify-terminal.py`: the full run passed at 40x20, 80x24, 100x30 and 120x40, and
  all 21 focused suites passed, `markdown` included (now at 120x72; D-31 resolved).
- App: sidecar typecheck and 89 tests passed. `check:layers` exits non-zero on nine `computer_*`
  names in the sibling `../Harness/src/computer/` (an older tree it scans); none are in this
  repository. `cargo test` was not rerun (no Rust change).

Real model requests were made on 2026-11-03 only, with the owner's permission, OpenCode account,
`opencode-go/deepseek-v4.1-flash` (turns, steering, follow-ups, `/stop` and Esc, plan questions, a
`--daemon` reply that survived its window). Real requests are allowed only on that model or on a
Codex account's `openai-codex/gpt-6-luna`, and never against `~/.codex`, `~/.claude` or `~/.pi`. The
stall guard was tested with a fake Pi session and fake timers; no live request exercised it.

The live PTY scripts used for those checks lived in a session scratch folder and are gone. To redo
them: run `dist/cli.js` in a PTY with `--data`/`--state` pointing at a throwaway folder and
`--account-state ~/.xingular-harness/state`, answer `ESC[6n` and `ESC[c` queries, and read run
records from `<data>/runs/*/run.json`. ADR-0083 lists what each check did.

## Open

- **PAR-018: remote control from the App.** Not built. Remote control still belongs to a terminal
  session (`Terminals.remotes`, disposed with the terminal, INV-RC-5), so a phone cannot reach an
  App chat, and a reply that outlives its window (`--daemon`) loses its phone. Minimum scope:
  - Extract the pending-decision, approve, answer and interrupt logic of `LiveTerminal`
    (`liveTerminal.ts`) so an App session and a terminal share it.
  - A `RemoteSessionPort` (`src/remote/service.ts`) for a live session: `send` through
    `sessions.followUp`/`runs.steer`, `history` from the session's runs, `listen`, `state` from
    `sessions.live`, `control` through `runs.interrupt`/`answerQuestion(s)`/approvals.
  - Dispose the pairing when the live session closes or on `stop`, not on `detach` while a reply runs.
  - `sessions.remoteControl.{start,stop,rotate,confirm,status,status.wait}` in `server/methods.ts`
    (keep `terminal.remoteControl.*` as aliases); revise INV-RC-3, INV-RC-5 and INV-RC-7 and add
    "one pairing per live session"; update pages 10, 11, 15 and PAR-018.
  - Tests: reuse the fake port of `remote/service.test.ts`; add one for lifetime (close the live
    session, the phone gets `ended`).
- **D-32: list wrapping.** The fenced-code renderer was written to keep a list item's wrapped lines
  beneath its text, but a general OpenTUI `renderNode` drops the blank rows between paragraphs and
  headings in every reply, so the renderer is code-block-only (`codeBlockOnly`) and lists wrap as in
  the previous release. Finishing it needs structured lists with the block spacing restored (OpenTUI
  tracks each block's margin itself and resets it on update), or OpenTUI support for both.
- **Plugin presentation in the client**: custom components, key handlers, renderers, shortcuts
  and themes are unavailable by design (INV-TUI-8). Dialogs, notices, status lines and text
  widgets work.
- **Provider request timeout**: Pi's is about ten minutes, retried by the harness's transient-retry
  policy (`pi/retryPolicy.ts`, up to 8 retries). The stall guard now caps a reply that makes no
  progress at fifteen minutes. A shorter request timeout was deliberately not set (see ADR-0083,
  "Closing the migration"); revisit it only with measured first-token gaps.
- **`/stop` under load**: the verifier now polls up to 8 seconds, so a load-average failure there
  should be gone. If it fails anyway, check the run record in the evidence folder first.
- **App, unrelated to this change**: `soloCommands.test.ts` expects Solo to handle `/goal`
  (PAR-017), and the root `npm run typecheck` reports button-prop errors in the App UI.

## Making the app-server the default

Why it is opt-in in `2.0.1-unstable`: it is new, tested with fake sessions and a few live runs on
one cheap model, never run for days, and a fault in it reaches every window on a state folder
instead of one. Do these in order; each is small. Then use it yourself for a few days before
flipping the default.

1. **A version handshake (the likely real-world failure).** After `npm i -g`, an old daemon keeps
   running and new windows connect to it. `daemon.ts` has no version check: `LockRecord`
   (`{ pid, startedAt, socket }`, `acquireDaemonLock`) and `daemon.status` carry none. Add the
   package version to both. In `connectDaemon` and `runDaemonTerminal`, compare it with the client's:
   on a mismatch with no live reply, stop the old daemon (`daemon.stop`) and start the new one; with
   a reply still running, keep the old daemon, say so in a notice, and let the window run in its own
   harness (or ask). Tests in `terminal/daemon.test.ts`: a stale lock from an older version is
   replaced; a busy older daemon is not killed.
2. **Daemon idle exit.** Idle live sessions close after 30 minutes (`LIVE_IDLE_MS`,
   `sessions/live.ts`), but the process stays until `xagent daemon stop`. Exit after a long period
   (for example 30 minutes) with no windows, no live session and no reply without a window; keep the
   lock/socket cleanup in `runDaemon`. Test with an injectable clock.
3. **An off switch, then the flip.** `--daemon` is parsed in `terminal/standalone.ts`
   (`let daemon = false`), and `cli.ts` documents it. Add `--no-daemon` and an environment variable
   (for example `XINGULAR_DAEMON=0`), then make the default on: resolve `paths.daemon` as flag, else
   environment, else true. `scripts/dev.mjs` already defaults `npm run dev` to `--daemon` (opt out
   with `XINGULAR_DEV_DAEMON=0`); remove that once the default moves. Keep subcommands
   (`serve`, `wiki`, `daemon …`) out of it.
4. **Remote control (PAR-018)**, below. With the daemon as the default, a reply that outlives its
   window should keep its phone; today the pairing ends with the window.
5. **One writer per data root.** The daemon's lock covers only other daemons. The App's sidecar is a
   separate writer on the same data root. Decide: the App connects to the daemon, or the daemon refuses
   to start (and the sidecar refuses) while the other holds the root. Update page 12 (storage) and
   INV-SRV-4 accordingly.
6. **Soak and failure tests.** Run a daemon for a day or more with several windows (`xagent daemon
   status` shows live sessions and replies without a window). Add tests for: the daemon killed
   during a reply (windows close cleanly and the run records `owner_gone`/`stalled`, not `running`);
   a hung plugin; a window that attaches to a session another window holds; the socket path length
   limit on a deep state folder. Run one live check with the stall guard on the permitted models.
7. **Docs.** Pages 10, 11 and 12 and ADR-0083 say the daemon is opt-in; change them with the flip,
   add an ADR for the default, and update the `xagent --help` text and the release notes.

Ready to flip when: 1–3 are done, 4 and 5 are decided (done, or written down as accepted gaps), 6
has passed once on a quiet machine, and a few days of real use found no stuck daemon.

## Things that are easy to get wrong

- A live session serves a run only when every pin matches (account, variant version, capability
  set, folders, tools, system prompt, model, effort, run-scoped extension names). Anything else
  closes it at the turn boundary and opens a new one on the same history. That is intended, not a
  bug. A stalled turn closes its session the same way.
- Client terminal runs record Pi's session id as `nativeSessionId`, as host runs do; in-process
  terminal runs record the history file. Terminal features look runs up through
  `Terminals.nativeOf`/`historyFileOf`, never `controller.nativeSessionId` directly.
- A command run, `sessions.navigate` or `sessions.rename` on a conversation with an idle live
  session closes that session first (one writer of the history file), and is refused while it is
  replying.
- The client never interrupts a reply when it closes; the parent decides (dispose interrupts,
  detach keeps it).
- The stall guard is in `runTurn`; the in-process terminal still has its own watch in
  `TerminalController`. Both use `sessions/stallWatch.ts`, so a change to the windows changes both.
- Verifier layouts: names in the palette and `/help` carry their owner (`terminal-verifier:…`) and
  wrap; read a name down its column rather than looking for it on one row.
