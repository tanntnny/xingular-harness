---
id: PROP-0042
title: Usage analytics and provider limits as a built-in capability
status: Accepted
created: 2026-10-26
updated: 2026-10-26
affects: [INV-MEM-5, INV-MEM-6, INV-STO-2, INV-SRV-1, INV-PLG-10, INV-ACC-3, 02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 08-memory-and-history.md, 09-accounts-and-connectors.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity.md]
---

# PROP-0042: Usage analytics and provider limits as a built-in capability

## Problem

A run already records what each model request used: `usage.updated` carries per-request tokens,
cost, provider, model, TTFT and duration (`src/sessions/contracts.ts`, emitted in
`src/sessions/runner.ts`). Nothing aggregates it, and the SQLite `runs` table stores only ids,
status and timestamps (`src/sessions/runIndex.ts`). A person cannot answer "what did this account
spend this week, on which model?" without reading run folders.

The account store already has the shape of provider limits — `Limit`, `AccountState.limits`, and
health derived from `usedPercent`/`resetsAt` (`src/accounts/store.ts`) — and `account.status`
carries a `limits` array (`src/sessions/contracts.ts`). No producer ever fills it: `Probe.limits`
is never assigned in `Accounts.probe`, and `runner.ts` only classifies provider error text. A
person cannot see how close a subscription plan, credit balance or rate window is.

The capability is something a person uses, so it belongs in the Harness with a terminal surface
before any host screen (`INV-PAR-1`).

## Affected rules

- **INV-MEM-5** Files are the source of truth. `index.sqlite` is derived and can be deleted and
  rebuilt. The usage ledger is derived data inside that index; it adds no run file.
- **INV-MEM-6** Index migrations are append-only. Migration 8 appends the usage tables.
- **INV-STO-2** `index.sqlite` can be deleted and rebuilt; the ledger is rebuilt from run events.
- **INV-SRV-1** A new `usage` method group is additive. Existing method names, params and result
  shapes do not change.
- **INV-PLG-10** The methods and commands are contributed by one built-in feature module, so the
  public method table remains assembled by `server/methods.ts` and the plugin has one owner.
- **INV-ACC-3** The harness never writes a secret to its own files. Provider limit reads use the
  credential Pi already resolved through `Models.getAuth`, send it only to the provider, and store
  no credential. A refreshed OAuth token is written only through the existing credential store.
- **INV-RUN-7** The meaning of every usage field is unchanged. The ledger copies them; aggregates
  are new derived data.

## Proposal

A built-in plugin `usage` owns a **read-only** capability with one full-screen terminal page and
two commands:

- `/usage:` and `/usage:analysis [today|7d|30d|all]` — token, cost and latency analytics from a
  derived ledger.
- `/usage:limit` — what each provider last reported about its plan windows, balances or rate
  limits.

**Ledger.** Migration 8 adds `usage_requests` (one row per model request) and `usage_indexed` to
`index.sqlite`. A run's ledger rows are written from its `usage.updated` events when the run ends,
and repaired by `open`, `rebuildIndex()` and the first analysis call when the ledger is empty. A
per-request row is used when the event carries `request`; a provider that reported only cumulative
totals contributes one row from its latest event. Cost uses the provider's own figure; a request
with no cost may be priced at Pi's catalogue rates for display, and the estimate is marked
separately, never presented as a provider figure. Aggregates are bounded: one scope, one period,
top ten rows per breakdown, at most 400 days, with an unpriced-request count.

**Limits.** Three sources, in this order:

1. **Response headers**, captured by wrapping each account runtime's provider streams with
   `onResponse`; a terminal session's runtime forwards only the limit-bearing headers over its
   control-key-protected socket. Four families are understood: `anthropic-ratelimit-*`, Anthropic unified plan
   windows, `x-codex-*` plan windows, and the common `x-ratelimit-*` headers. `Retry-After` on a
   429 is kept as a reset hint. Raw headers are never stored.
2. **The provider's own usage endpoint**, read with `Models.getAuth` and a bounded HTTPS GET that
   refuses redirects and other hosts: OpenRouter `GET /api/v1/key`, DeepSeek
   `GET /user/balance`, Anthropic's organization `rate_limits` (admin credential only; configured
   limits, not usage), ChatGPT/Codex `GET /backend-api/wham/usage` (account id from the access
   token), and OpenCode Go `GET /zen/go/v1/usage`.
3. **Unavailable**, with a reason. No percentage is ever invented. A provider with no documented
   endpoint, a custom base URL, an expired sign-in or no support shows local usage only.

Undocumented plan endpoints stay behind the plugin setting `experimentalProbes` (off by
default). A reading is cached per account and provider for `refreshMinutes` (default 10); a
page open or `r` refreshes only what is due. Readings live in the account's existing state
(`limits`, plus a new `providerLimits` readout list) and never create a new file.

**Surfaces.** Public methods `usage.summary`, `usage.limits`, `usage.sync`; protected terminal
routes `terminal.usage.summary` and `terminal.usage.limits` for the page, all through the same
service. The App screen is a later host task, tracked as `PAR-016`.

## Alternatives

- **Read every run's `events.jsonl` on demand.** Correct but unbounded: a year of runs is many
  megabytes per page open. A derived table is what the index is for.
- **Store analytics in a new data folder.** Violates `INV-STO-3` and duplicates derived data the
  index can rebuild.
- **Scrape provider dashboards.** Not stable, not authenticated, and not a provider API.
- **Show a percentage for every provider by assuming a cap.** Fabrication; rejected.
- **Make limit reads automatic in the background.** Surprise egress with a person's credential;
  rejected in favour of page-open and explicit refresh.
- **Do nothing.** Leaves usage and limits unanswerable in both surfaces.

## Consequences

- Two additive method routes and two terminal commands; no protocol version change.
- `index.sqlite` gains two tables (migration 8), rebuilt from run files.
- `AccountState` gains an optional `providerLimits` readout list and `Limit` gains optional
  absolute fields and `remainingPercent`; old state files load with defaults, and old readers
  ignore the additions.
- A page open may make one small read-only request per due provider, using the account's existing
  credential. No model request, no token spend, no secret written.
- The harness remains the only writer of the ledger and of limit snapshots.

## Migration

No data rewrite. The index migrates in one transaction with the existing backup/restore path; an
old index simply indexes existing runs on the next `open` or `usage.sync`. Account state files
without `providerLimits` read as an empty list. Reverting removes the plugin module and commands;
the extra index tables are inert.

## Checks

- `npm run typecheck`, `npm test` (`src/usage/*.test.ts`, `src/plugins/usage.test.ts`).
- `npm run prove` with an injected reader: `usage.summary` after a fake recorded run and
  `usage.limits` returning an explicit unavailable reason, with no network.
- Terminal verification of `/usage:`, `/usage:analysis`, `/usage:limit` and the two tabs.
- App checks (`npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`,
  `cargo test`) after the Harness change.
- Real provider header names are confirmed only by a separate owner-authorized request per
  provider; fixtures keep only redacted header values.
