---
id: PROP-0035
title: Retain terminal subagent status until the next run
status: Implemented
created: 2026-10-25
updated: 2026-11-19
affects: [11-terminal.md, terminal-tui.md]
---

# PROP-0035: Retain terminal subagent status until the next run

## Problem

The terminal shows subagent descendants under the working status line and in `/subagents:subagents`, but removes them when the parent run settles. The terminal specification says finished rows remain only until the parent settles. This makes the final child statuses unavailable during the idle interval before the next run, even though the terminal itself remains open.

Evidence: `src/terminal/controller.ts` clears the volatile `SubagentMonitor` in `finish()` and `subagentSnapshot()` returns an empty list without an active run. `src/terminal/opentui/app.ts` polls only during an active run and clears its local rows on `agent_settled`. The current retention boundary is documented in `docs/architecture/11-terminal.md` and `docs/terminal-tui.md`.

## Affected rules

- `docs/architecture/11-terminal.md` currently says: “Finished rows remain until the parent run settles. The projection is volatile and scoped to that parent run; it is not a persisted event or public server method.”
- `docs/terminal-tui.md` currently says the projection “keeps finished child rows until that parent settles.”

## Proposal

Retain the latest parent run's subagent projection in the terminal after that parent settles. Keep showing the compact rows and the `/subagents:subagents` roster, with each child's final known status, until the next parent run starts. At the next run's start, clear the old projection before displaying that run's children. A final settlement read should capture child states that the periodic monitor poll has not yet reflected; overlapping or late reads must not replace data from a newer run.

The projection remains volatile, read-only, and limited to the existing redacted fields. It is scoped to the latest parent run for the current terminal session, and is cleared when the session is replaced or the terminal is disposed. It remains neither a persisted event nor a public server method. No run-event schema, storage, or host API changes.

## Alternatives

- **Do nothing.** The last statuses remain unavailable once the parent settles.
- **Retain only the frontend's last poll.** This can leave a child marked active after it has completed because monitor updates may fall between one-second polls.
- **Persist a separate status snapshot.** Rejected: the requested lifetime is only until the next run, and retaining the existing volatile projection is sufficient.

## Consequences

The terminal monitor and presentation retain one run's already-redacted subagent rows while idle. The next run replaces them. Other Harness capabilities and the App surface are unchanged. There is no new persistent data, migration, public method, or event contract.

## Migration

None. Existing terminals clear their in-memory monitor on restart; the new behavior applies to runs observed by the updated terminal process.

## Checks

- Harness `npm run typecheck`, `npm test` (150 files; 1,141 passed, 3 skipped), focused terminal tests (61 passed), `npm run build`, and `npm run prove` passed.
- App `npm run typecheck`, `npm test` (567 App and 67 sidecar tests passed), `npm run check:layers`, and `cd src-tauri && cargo test` (167 passed, 1 ignored) passed.
- The initial full PTY run failed waiting for `1 of 1` in its plan-question flow, and `--questions-only` failed waiting for `UI layout`. After the question-dock/layout fixes, `python3 scripts/verify-terminal.py --cli dist/cli.js --sizes 40x20,80x24,100x30` passed 19 interaction groups at each size with the tty restored (2026-11-19). Focused unit and real-socket tests cover subagent retention. No real-model request was made.
