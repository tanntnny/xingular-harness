# Harness documentation

**Binding specification:** [Architecture](architecture/README.md). Code must follow it; a change
to it starts as a [proposal](architecture/proposals/README.md) the user reviews.

Current implementation: [Harness terminal frontend](terminal-tui.md). The package-level
[README](../README.md) describes the embedding API, accounts, plugins, memory and storage.

| ID | Record | Type | Status | Related |
|---|---|---|---|---|
| SPEC | [Harness architecture specification](architecture/README.md) | Specification | Binding; as of 2026-10-21 | [Proposals](architecture/proposals/README.md), [Known drift](architecture/README.md#known-drift) |
| STUDY-0001 | [Agent-harness arm study](study/00-index.md) | Study | Arms 01–10 audited (core sources); matrix + roadmap done; remaining-source fills pending | [insights.md](study/insights.md), [roadmap.md](study/roadmap.md), [`/btw` comparison](study/btw-comparison.md) |
| DESIGN-0001 | [System-prompt design: fixed foundation + adapting harness](system-prompt-design.md) | Design | Draft — not yet accepted; refs current `compile.ts`/tree contracts | STUDY-0001 (arms 01, 10), [roadmap.md](study/roadmap.md) T1-1/9 |
| EXP-0001 | [Terminal input latency profile](experiments/EXP-0001-terminal-input-latency/plan.md) | Experiment | Completed on one local machine; slow-machine validation pending | ADR-0001, [Profile instructions](terminal-tui.md#input-performance-profile) |
| ADR-0011 | [The harness is a fixed foundation running a mutating variant](decisions/ADR-0011-foundation-and-variants.md) | Decision | Accepted; implemented in 5.0.0 | [PROP-0009](architecture/proposals/PROP-0009-foundation-and-variants.md), [Foundation and variants](architecture/00-overview.md#foundation-and-variants) |
| ADR-0010 | [Lessons from ordinary runs live in the Wiki](decisions/ADR-0010-lessons-in-the-wiki.md) | Decision | Accepted; working tree implementation | [PROP-0008](architecture/proposals/PROP-0008-lessons-from-runs.md), [08 Memory and history](architecture/08-memory-and-history.md), [feature-gap review](study/feature-gap-review.md) |
| ADR-0009 | [Publish the Harness CLI as xharness](decisions/ADR-0009-xharness-command.md) | Decision | Accepted; implementation verified, npm publication pending authorization | [PROP-0005](architecture/proposals/PROP-0005-xharness-cli-name.md), [11 Terminal](architecture/11-terminal.md) |
| ADR-0007 | [A fixed Reporting section shapes the final reply](decisions/ADR-0007-reporting-section.md) | Decision | Accepted; working tree implementation | [PROP-0001](architecture/proposals/PROP-0001-reporting-section.md), [04 Prompt](architecture/04-prompt.md) |
| EXP-0002 | [OpenTUI typing latency against Pi and opencode](experiments/EXP-0002-opentui-typing-latency/plan.md) | Experiment | Completed on one local machine (Apple M2) | ADR-0006, EXP-0001, [Profile instructions](terminal-tui.md#input-performance-profile) |
| ADR-0006 | [OpenTUI is the only terminal frontend](decisions/ADR-0006-opentui-only-terminal.md) | Decision | Accepted; working tree implementation | ADR-0001, [Terminal architecture and evidence](terminal-tui.md) |
| ADR-0004 | [Fullscreen terminal layout with a fixed dock](decisions/ADR-0004-fullscreen-terminal-layout.md) | Decision | Superseded by ADR-0006 | ADR-0001, [Terminal architecture and evidence](terminal-tui.md) |
| ADR-0003 | [Shared asynchronous subagents with native-history delivery receipts](decisions/ADR-0003-shared-asynchronous-subagents.md) | Decision | Accepted; working tree implementation | ADR-0002, [Embedding API](../README.md) |
| ADR-0002 | [Native subagent lifecycle in Harness sessions](decisions/ADR-0002-native-subagent-lifecycle.md) | Decision | Superseded by ADR-0003 | [Embedding API](../README.md) |
| ADR-0001 | [Own the terminal frontend and keep Pi as the session runtime](decisions/ADR-0001-owned-terminal.md) | Decision | Accepted; working tree implementation | [Terminal architecture and evidence](terminal-tui.md) |

Living reference pages describe checked source behavior. Accepted decisions record the choice;
they do not establish publication or release. Evidence references on the terminal page identify
the inspected upstream artifacts and bound the verification claims.
