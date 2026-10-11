# Handoff — 2026-10-11

This repository was created by splitting the harness out of Xingular Agent. Work stopped on 2026-10-11 with the code complete and passing, and **no commit yet**: every file here is untracked on `main`. Delete this file after the first commit and once the items below are closed.

The full handoff, with the application side, is in Xingular Agent's branch `harness-split`:
`../Xingular Agent/App-harness-split/docs/guides/harness-split-handoff.md`. The decision is ADR-0004 and the plan RFC-0005 in that repository's `docs/`.

## State

- `npm run typecheck`, `npm test` (20 files, 150 tests, 95 golden cases), `npm run build` and `npm run prove` passed on 2026-10-11.
- The only consumer is Xingular Agent's sidecar, which bundles `src/` by path. That work is uncommitted too, in the worktree `../Xingular Agent/App-harness-split`.
- Nothing has run with a signed-in provider. Tests use a fake Pi session; the application's probes used a local scripted model.

## Open here

1. **First commit.** Not made, by instruction.
2. **Provider cache reuse is unmeasured** since the prompt compiler was ported from Rust. The golden fixtures prove the bytes; the application's `scripts/probe-chat-cache-app.py` measures the cache and needs the account owner's go-ahead.
3. **No built-in skill is shipped.** `configureBuiltins` and the `builtins` option exist and are tested.
4. **Credential lookups.** Pi's model runtime asks `credentialStore.read` for every provider, and each ask reaches the `SecretStore` (about 100 per turn in the application). Skipping providers not in the account's `piProviders` would avoid it, at the cost of hiding a credential whose state file was lost. Not decided.
5. **Sleep-time maintenance usage** is not recorded.
6. **`package.json` is `private` at version 0.1.0** and consumed as source. Publishing, or a built entry point for other applications, has not been set up; `dist/cli.js` (`xingular-harness serve`) is the only built interface.

## Keep in mind

- `tests/golden/` was recorded from the Rust code at Xingular Agent commit `f29e974`. It passes `productName: 'Xingular Agent'` on purpose: those are that application's bytes.
- A run's record is saved before listeners and the host see its last events. A host that reads `run.json` to decide whether a run is over can be a few milliseconds ahead of its own event handling.
- Tests start real child processes (a stdio MCP server, the server under `prove`), so the test timeout is 30 s.
