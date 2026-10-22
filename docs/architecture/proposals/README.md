# Architecture proposals

A proposal is required before any change that alters a contract, an invariant, a layer
boundary, an extension point, or the storage layout described in [the specification](../README.md).
The author writes it and stops; the user reviews it. Code and spec pages change only after the
proposal is `Accepted`.

## Status

| Status | Meaning |
|---|---|
| `Proposed` | Written, waiting for the user. Nothing has changed. |
| `Accepted` | The user approved it. Implement it and update the spec pages in the same change. |
| `Implemented` | Code and spec pages match the proposal. Link the commit or ADR. |
| `Rejected` | The user declined it. The file stays as a record. |
| `Withdrawn` | The author dropped it before review. |

## Index

| ID | Title | Status | Affects | Date |
|---|---|---|---|---|
| [PROP-0001](PROP-0001-reporting-section.md) | A built-in Reporting section that shapes the final reply | Implemented | INV-PRM-2, 04-prompt.md | 2026-10-21 |
| [PROP-0002](PROP-0002-retain-rollout-workspaces.md) | Opt-in retention of each refinement execution's workspace | Implemented | INV-REF-1, 05-refinement.md, 10-server-protocol.md, 12-storage.md | 2026-10-21 |
| [PROP-0003](PROP-0003-executor-settings.md) | Name the model and account of refinement's executions on refine.start | Implemented | 05-refinement.md, 10-server-protocol.md | 2026-10-21 |
| [PROP-0004](PROP-0004-flexible-reporting-guidance.md) | Flexible final-reply guidance with an optional human-inspection heading | Implemented | INV-PRM-2, 04-prompt.md, ADR-0007, ADR-0008 | 2026-10-21 |
| [PROP-0005](PROP-0005-xharness-cli-name.md) | Rename the published CLI command to xharness | Implemented | 11-terminal.md, package.json#bin, CLI documentation, ADR-0009 | 2026-10-22 |
| [PROP-0006](PROP-0006-run-checklist.md) | A run checklist the model writes, recorded as a run event | Implemented | 02-sessions-and-runs.md, 06, 07, 10-server-protocol.md | 2026-10-22 |
| [PROP-0007](PROP-0007-run-continuation.md) | Continue a stopped run as a new run with the same pins | Implemented | INV-RUN-4, INV-RUN-10, 00-overview.md, 02-sessions-and-runs.md, 10-server-protocol.md | 2026-10-22 |
| [PROP-0008](PROP-0008-lessons-from-runs.md) | Opt-in lessons from finished runs, kept in the Wiki | Implemented | INV-MEM-2, 02, 06, 08-memory-and-history.md, 12-storage.md, ADR-0010 | 2026-10-22 |
| [PROP-0009](PROP-0009-foundation-and-variants.md) | Name the fixed half the foundation and the mutating half the variant | Accepted | INV-TREE→INV-VAR, new INV-FND-1/2, 00, 03, 05, 10, 12, ADR-0011 | 2026-10-22 |

| [PROP-0010](PROP-0010-session-names.md) | Agent-managed native session names | Implemented | 02, 04, 07, 11 | 2026-10-22 |

| [PROP-0011](PROP-0011-doctor.md) | Readiness diagnostics and explicit live probes | Accepted; implementation in working tree | INV-EXT-1/4, INV-GATE-1, INV-TUI-4, 01, 07, 09, 10, 11 | 2026-10-22 |

| [PROP-0012](PROP-0012-release-baseline.md) | Public 1.0.0 distribution and generic browser ownership | Accepted; candidate implementation | INV-BND-2, 00, 07, 11, 13 | 2026-10-22 |

Numbers are four digits, start at `0001`, and are never reused.

## Template

Save as `PROP-NNNN-<short-slug>.md`.

```markdown
---
id: PROP-NNNN
title: <one line>
status: Proposed
created: YYYY-MM-DD
updated: YYYY-MM-DD
affects: [INV-..., 02-sessions-and-runs.md, ...]
---

# PROP-NNNN: <title>

## Problem
What is wrong or missing today, with evidence (code paths, failures, requests).

## Affected rules
Each invariant, contract or boundary this changes, by ID, quoted as it stands.

## Proposal
The new rule and design, stated as the spec page would state it after the change.

## Alternatives
Other options considered, and why they were not chosen. Include "do nothing".

## Consequences
What changes for applications built on the harness, for stored data, and for the server protocol.

## Migration
How existing data, runs and hosts move over. Whether it can be undone.

## Checks
How the change will be verified: tests, `npm run prove`, the App's checks.
```
