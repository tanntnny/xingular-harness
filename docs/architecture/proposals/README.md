# Architecture proposals

Proposals are optional design records for changes to contracts, invariants, layer boundaries,
extension points, or storage layout in [the specification](../README.md). They may be written before
or alongside implementation, but do not gate code or spec changes. When a proposal is created, add
it to the index and update its status as the work progresses.

## Status

| Status | Meaning |
|---|---|
| `Proposed` | A draft design record; implementation status is tracked separately. |
| `Accepted` | The user approved the design. Approval is not a prerequisite to implementation. |
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

| [PROP-0013](PROP-0013-resource-browser.md) | Unified terminal resource browser | Implemented; working tree verified | 03, 06, 09, 11 | 2026-10-22 |

| [PROP-0014](PROP-0014-fullscreen-browser-tabs.md) | Full-screen browser with persistent section tabs | Implemented; working tree verified | 11, terminal-tui.md | 2026-10-23 |

| [PROP-0015](PROP-0015-one-capability-surface.md) | One capability surface: the terminal and every host offer the same capabilities | Accepted | INV-BND-2, new INV-PAR, 00, 11, 14, AGENTS.md | 2026-10-23 |

| [PROP-0016](PROP-0016-managed-worktrees.md) | Managed git worktrees in the terminal and every host | Harness/terminal in 4.0.0 candidate; App create integration, remaining actions PAR-012 | INV-BND-2, D-5, INV-STO-3, INV-SRV-1, 00, 02, 10, 11, 12, 14 | 2026-10-23 |

| [PROP-0017](PROP-0017-page-annotations.md) | Page annotations captured in the headed browser or a host's web view | Harness/terminal in 4.0.0 candidate; App source pending native-gesture acceptance | INV-STO-3, INV-SRV-1, 07, 10, 11, 12, 13, 14 | 2026-10-23 |

| [PROP-0018](PROP-0018-annotation-queue-and-app-targets.md) | Inspector-style page notes, a fix queue to the agent, and app windows as capture targets | Harness/terminal in 4.0.0 candidate; App source present, native WKWebView acceptance pending | INV-STO-3, INV-SRV-1, 07, 10, 11, 12, 13, 14 | 2026-10-23 |
| [PROP-0019](PROP-0019-contextual-side-questions.md) | Harness-owned contextual side questions across surfaces | Implemented; working tree verified | INV-RUN-1/3/5, INV-GATE-1, INV-PLG-1/5, INV-CAP-1, INV-SRV-1/2, INV-PAR-1/2, 02, 04, 06, 07, 10, 11, 12, 14, ADR-0023 | 2026-10-24 |
| [PROP-0020](PROP-0020-builtin-feature-plugins.md) | Built-in feature modules and namespaced plugin commands | Implemented; included in 4.0.0 candidate | INV-PLG-5/6, INV-TUI-2/7, INV-SRV-1, 06, 11, 13, 14 | 2026-10-24 |
| [PROP-0021](PROP-0021-command-namespaces-and-duplicates.md) | Required built-in commands and duplicate command suppression | Implemented | INV-TUI-7, INV-PAR-1, 11, 14, ADR-0021 | 2026-10-24 |
| [PROP-0022](PROP-0022-plan-only-questions.md) | Keep question tools available only in interactive plan mode | Implemented | INV-RUN-8, 02, 04, 06, 07, 11, 14, parity, ADR-0022 | 2026-10-24 |
| [PROP-0023](PROP-0023-xagent-cli-name.md) | Rename the published CLI command to xagent | Implemented | 11-terminal.md, package.json#bin, CLI documentation, ADR-0024 | 2026-10-24 |
| [PROP-0024](PROP-0024-question-sketch-previews.md) | Add bounded ASCII sketch previews to question choices | Implemented; working tree verified | INV-RUN-3, INV-PAR-1/2, 02, 10, 11, 14, parity, App question contract and plan-mode docs, ADR-0025 | 2026-10-24 |
| [PROP-0025](PROP-0025-contextual-question-wireframes.md) | Strict question columns and contextual ASCII wireframes | Implemented; working tree and isolated fixtures verified | INV-RUN-3, INV-PAR-1/2, 02, 11, 14, terminal-tui.md, parity, ADR-0026 | 2026-10-24 |

| [PROP-0026](PROP-0026-connected-sketch-display.md) | Connect structural sketch lines in the terminal display | Implemented; working tree and isolated fixtures verified | 11, 14, terminal-tui.md, parity, ADR-0027 | 2026-10-24 |
| [PROP-0027](PROP-0027-xingular-agent-product-identity.md) | Use Xingular Agent as the default Harness product identity | Accepted; implemented and verified | INV-BND-2, 00-overview.md, 04-prompt.md, 11-terminal.md, terminal-tui.md, ADR-0028 | 2026-10-24 |
| [PROP-0028](PROP-0028-normalize-question-wireframes.md) | Normalize high-confidence question wireframe borders in the terminal preview | Implemented; production PTY verification passed | INV-PAR-1/2, 11-terminal.md, 14-surfaces-and-parity.md, terminal-tui.md, parity, ADR-0029 | 2026-10-24 |
| [PROP-0029](PROP-0029-agent-profiles.md) | Agent profiles that subagents start from | Accepted; implemented | INV-RUN-2, INV-VAR-4, INV-STO-3, INV-SRV-1, 02, 03, 04, 06, 10, 11, 12, 14, parity, ADR-0030 | 2026-10-24 |
| [PROP-0030](PROP-0030-subagent-title.md) | A parent-set title for each subagent, shown in the roster | Accepted; implemented | 02, 07, 10, 11, terminal-tui.md, 14, parity | 2026-10-24 |
| [PROP-0031](PROP-0031-plugin-command-owner-namespaces.md) | Namespace plugin commands by owner | Implemented; Harness and App checks passed | INV-TUI-7, 06, 11, 14, terminal-tui.md, README.md, ADR-0021, ADR-0031 | 2026-10-25 |
| [PROP-0032](PROP-0032-planning-quality.md) | Evidence-grounded planning with read-only research delegation | Implemented; live model pilot pending authorization | INV-RUN-8, INV-GATE-3, INV-CAP-1, 02, 06, 07, 14, parity, ADR-0033 | 2026-10-25 |
| [PROP-0033](PROP-0033-compaction-plan-checkpoints.md) | Rehydrate bounded run checkpoints after compaction | Accepted; implemented | INV-PRM-1/4/10, INV-RUN-8/12, 02, 04, 11, 14, ADR-0032 | 2026-10-25 |
| [PROP-0034](PROP-0034-conversation-fast-mode.md) | Conversation-scoped provider fast mode | Proposed | INV-RUN-1/3, INV-PAR-1/2, 02, 09, 10, 11, 12, 14, parity, App thread runtime settings | 2026-10-25 |
| [PROP-0035](PROP-0035-retain-subagent-status.md) | Retain terminal subagent status until the next run | Implemented; initial PTY failure resolved; full verifier passed at three sizes (2026-11-19) | 11-terminal.md, terminal-tui.md | 2026-10-25 |
| [PROP-0036](PROP-0036-first-class-harness-commands.md) | First-class Harness terminal commands | Implemented | INV-PLG-10, INV-TUI-7, 06, 11, 14, terminal-tui.md, parity, ADR-0034 | 2026-10-25 |
| [PROP-0037](PROP-0037-workspace-write-boundary.md) | Default filesystem writes to the active project workspace | Implemented | INV-GATE-1/3/8, INV-RUN-1, INV-TUI-8, 02, 04, 07, 10, 11, 12, 14, parity | 2026-11-19 |
| [PROP-0038](PROP-0038-annotate-open-shadow-roots.md) | Annotate inside open shadow roots | Implemented | 13-world-tools.md, note target, PROP-0017, PROP-0018, parity | 2026-10-25 |
| [PROP-0039](PROP-0039-workspace-boundary-hardening.md) | Harden workspace writes against inode escapes and unverified retries | Accepted; implementation validated on macOS, Linux validation pending | INV-GATE-3/8, INV-TUI-8, 02, 07, 11, 14, parity | 2026-10-26 |

| [PROP-0040](PROP-0040-one-launch-path.md) | One launch path and command contract across front ends | Accepted; implementation in progress | 01–04, 06–07, 10–14, parity | 2026-11-19 |
| [PROP-0041](PROP-0041-bounded-work-slices.md) | Bounded work slices, a durable checkpoint, and a stall guard for long replies | Implemented; terminal card, App presentation and /slices open (PAR-004) | INV-RUN-2/3/4/12, INV-PRM-1/2/4/5/10, INV-GATE-2, INV-STO-3, INV-PAR-1/2, 02, 04, 07, 10–12, 14, parity | 2026-10-26 |
| [PROP-0042](PROP-0042-usage-and-provider-limits.md) | Usage analytics and provider limits as a built-in capability | Accepted; implemented | INV-MEM-5/6, INV-STO-2, INV-SRV-1, INV-PLG-10, INV-ACC-3, 02, 06, 08–12, 14, parity, ADR-0037 | 2026-10-26 |
| [PROP-0043](PROP-0043-read-only-plan-bash.md) | Read-only Bash in plan mode, enforced by the OS sandbox | Accepted; implemented | INV-RUN-8, INV-GATE-3/8, 02, 07, 11, terminal-tui, parity, ADR-0038 | 2026-10-26 |
| [PROP-0044](PROP-0044-work-slice-defaults.md) | Raise the work-slice defaults to 320 tool calls and 60 minutes, with no token cap | Accepted; implemented | INV-RUN-13, 02, 10, 11, PROP-0041 | 2026-10-26 |
| [PROP-0045](PROP-0045-rename-checklist-to-todo.md) | Rename the run checklist to todo and add the /todo command | Accepted; implemented | 02, 04, 06, 07, 10, 11, 14, parity, terminal-tui, README, PROP-0006 | 2026-10-26 |
| [PROP-0046](PROP-0046-progress-aware-stall-guards.md) | Progress-aware stall guards and bounded plan research children | Implemented; ADR-0039, targeted protections superseded by ADR-0053 | INV-RUN-13, 02-sessions-and-runs.md, PROP-0041, terminal-tui.md, ADR-0039 | 2026-10-27 |
| [PROP-0047](PROP-0047-plugins-hub-separation.md) | Separate local plugin management from Community Hub discovery | Implemented; ADR-0041 | INV-MCP-4, INV-TUI-2/4, INV-PAR-1/2, 06, 09, 10, 11, 14, terminal-tui.md, parity.md | 2026-10-27 |
| [PROP-0048](PROP-0048-simple-annotate.md) | One annotate page, two actions, and easy app attach | Implemented; ADR-0044 | PROP-0018, 07, 10, 11, 13, terminal-tui.md, parity.md | 2026-10-27 |
| [PROP-0049](PROP-0049-context-attribution.md) | Context attribution: what fills the context window, by foundation, variant and application | Implemented | INV-PRM-6, INV-SRV-1, INV-PAR-1/2, INV-RUN-7, 04, 10, 11, 14, parity.md | 2026-10-28 |

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
