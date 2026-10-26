# ADR-0037: Usage analytics read a derived ledger; provider limits are read, never guessed

**Status:** Accepted (2026-10-26)

## Context

Token and cost figures already reach the harness per model request, but only inside run events,
and the index stores no usage. Provider limits have a schema and health rules but no producer.
A person needs both answers without reading run folders, and a subscription's plan window must
not be presented as a made-up percentage.

## Decision

- **The usage ledger is derived.** `usage_requests` and `usage_indexed` live in `index.sqlite`,
  are written from `usage.updated` events, and are rebuilt from `runs/` like recall. No run file,
  folder or schema changes.
- **Analytics are bounded and scope-first.** One scope, one period, top-ten breakdowns, an
  unpriced-request count, and cost estimates marked separately from provider figures.
- **Limits have a stated source.** Response headers first (free and fresh), then a small registry
  of documented provider endpoints read with the credential `Models.getAuth` resolves, then an
  explicit unavailable reason. Undocumented endpoints are off unless `experimentalProbes` is on.
- **Freshness is a person's choice.** Readings are cached for a configurable interval and
  refreshed on page open or `r`, never by a background timer.
- **One built-in plugin owns the capability.** `usage` contributes the methods and the two
  namespaced terminal commands; the public method table still comes from `server/methods.ts`.

## Consequences

The index carries one more derived table set, with an append-only migration. `AccountState`
gains an optional readout list and `Limit` optional absolute fields, both additive. A page open
may make a read-only provider request with the account's existing credential; nothing is written
to a credential file and no model request is made. Hosts can present the same methods later; the
terminal is the reference surface.

## Alternatives rejected

Reading raw run logs per page (unbounded), a new data folder (duplicates derived data), scraping
dashboards (no stable API), inventing percentages (misleading), background polling (surprise
egress).

## References

[PROP-0042](../architecture/proposals/PROP-0042-usage-and-provider-limits.md), architecture pages
02, 06, 08, 09, 10, 11, 12 and 14.
