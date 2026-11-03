# Handoff — 2026-11-04

One session runtime (ADR-0083). The harness keeps a conversation's Pi session open across turns, the
terminal is a client of the harness by default, a long-lived harness lets a reply outlive its window,
and every harness run now ends when it stops making progress. The work is on `release/1.0.0` (base
`aa83355`), with one small change in `../agent-app` on `app-as-frontend`. See "Commit state" for what
is committed.

The decision, design and all measured evidence are in
[`docs/decisions/ADR-0083-one-live-session-runtime.md`](docs/decisions/ADR-0083-one-live-session-runtime.md).
The previous handoff (2026-10-11, the harness split) is in git history at `21721b0`.

## Commit state

ADR-0083 is committed on `release/1.0.0` as separate commits from the other person's uncommitted
work, which is still in the working tree and is not part of it (see `git log` and `git status`):

- `src/terminal/opentui/markdown.ts`, `markdown.test.ts`, `root.tsx`: fenced-code panels.
- `src/prompt/reporting.ts`, `src/prompt/compile.test.ts`, `docs/architecture/04-prompt.md`,
  `docs/terminal-tui.md`.
- In `CHANGELOG.md` their entry ("Make fenced code easier to read…"), and in
  `scripts/verify-terminal.py` the markdown fixture and `--markdown-only` assertions. Those hunks
  were left out of the ADR-0083 commit.

The App change is a separate commit in `../agent-app`, which also holds a lot of the owner's own
uncommitted work. Only the `live: true` hunk of `sidecar/src/agentRuns.ts` (the last one) is ours;
the rest of that file's diff (a removed tool-free starter, `createSessionCommand`, `sessionTools`)
is the owner's.

## What changed

| Area | Files |
|---|---|
| Live sessions (phase 1) | `src/sessions/live.ts` (new), `runner.ts` (rebind, run slots, `release`, retry fix), `sessions.ts` (`live`, follow-ups, `newHistory`, `hiddenNotes`, `planTools`), `subagentService.ts`, `server/methods.ts` |
| Plugin dialogs as questions | `sessions/registry.ts`, `contracts.ts` (`question.requested.dialog`), `extensionUi.ts` |
| Terminal as a client (phase 2) | `src/terminal/liveTerminal.ts` (parent, new), `src/terminal/tui/harnessRuntime.ts` (client, new), `terminals.ts` (routing, detach and attach), `opentui/app.ts` (runtime choice, `ownDialogs`), `tui/commands.ts` (`/session` by id) |
| Long-lived harness (phase 3) | `src/server/socket.ts` (new), `src/terminal/daemon.ts` (new), `serve.ts`, `standalone.ts` (shared setup, fatal and hang-up handling), `cli.ts` |
| Stall guard and heartbeat (2026-11-04) | `src/sessions/stallWatch.ts` (moved from `terminal/`), `runner.ts` (`runTurn`: unconditional heartbeat, stall guard, `handBack`), `live.ts` (`release(…, close)`), `registry.ts` (`ActiveRun.waiting`), `sessions/stall.test.ts` (new) |
| App | `../agent-app/sidecar/src/agentRuns.ts`: a person's chat turns pass `live: true` (4 lines) |
| Spec | pages 02, 10, 11, 12, 14, 15; `README.md` Known drift D-28 to D-31; `docs/parity.md` PAR-004, PAR-008, PAR-018, PAR-019; ADR-0001 (runtime half superseded); ADR-0083 (new) |

How to use it:

- `xagent`: the client terminal (default). `XINGULAR_TERMINAL_RUNTIME=inprocess xagent`: the
  previous in-process runtime, for plugins that draw their own terminal components.
- `xagent --daemon`: the window runs in the long-lived harness for its folders. Closing it during a
  reply keeps the reply running. `xagent attach [session]` reconnects. Also
  `xagent daemon start|stop|status`.
- `XINGULAR_CLIENT_TRACE=<file>`: timestamped client events (runs, event batches, interrupts), for
  diagnosing a slow window.

## Verified (2026-11-04)

- Harness: `npm run typecheck` clean, `npm test` 1,837 passed (8 new, `sessions/stall.test.ts`),
  `npm run prove` passed.
- `python3 scripts/verify-terminal.py` in the default (client) terminal: the full run passed at
  40x20, 80x24, 100x30 and 120x40; 20 focused suites passed (welcome, click-focus, composer,
  file-completion, history, resume, todo, questions, jump-latest, help, browser, accounts,
  trajectory, palette, command-completion, attachments, dialog-paste, thinking, queue,
  compaction). The four that failed before (browser, palette, accounts, trajectory) were stale
  assertions and are fixed (D-30). The in-process runtime's full run passed at 80x24.
- App: sidecar typecheck and 89 tests passed against this tree. `check:layers` exits non-zero on
  nine `computer_*` names in the sibling `../Harness/src/computer/` (an older tree it scans); none
  are in this repository. `cargo test` was not rerun (no Rust change since it passed).
- Not rerun: the markdown suite (D-31).

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
- **D-31**: the `markdown` verifier suite fails only with the other person's uncommitted markdown
  work: its fixture sends 100 numbered items and `locate()` sees only the 40 visible rows. Theirs to
  fix (shorten the list, or find the markers in the captured stream).
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
