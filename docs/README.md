# Harness documentation

**Binding specification:** [Architecture](architecture/README.md). Code must follow it; a change
to it starts as a [proposal](architecture/proposals/README.md) the user reviews.

**Feature guide:** [Harness features](features/README.md) organizes current capabilities by area;
its pages are descriptive, while the architecture specification remains binding.

Current implementation: [Harness terminal frontend](terminal-tui.md). The package-level
[README](../README.md) describes the embedding API, accounts, plugins, memory and storage.

**Parity:** [Capability parity register](parity.md) lists every capability, its terminal surface
and its host surface ([14 Surfaces and parity](architecture/14-surfaces-and-parity.md) is binding).

**Future work:** [Feature backlog](future-work.md) records planned concepts. Backlog entries do not
change the binding architecture or describe implemented capabilities.

| ID | Record | Type | Status | Related |
|---|---|---|---|---|
| ADR-0048 | [A skill named anywhere in a message is required for that request](decisions/ADR-0048-required-skills-from-a-message.md) | Decision | Harness compiler, terminal and App composer implemented; acceptance not certified | [04 Prompt](architecture/04-prompt.md), [11 Terminal](architecture/11-terminal.md), [parity register](parity.md) |
| ADR-0047 | [A link a person clicks opens with the system's handler](decisions/ADR-0047-links-open-with-the-os-handler.md) | Decision | Implemented in the Harness, the terminal and the App; acceptance not certified | [10 Server protocol](architecture/10-server-protocol.md), [parity register](parity.md) |
| ADR-0046 | [Hash-bound plugin proposal review](decisions/ADR-0046-hash-bound-plugin-proposals.md) | Decision | Harness API and model proposal tool implemented; review surfaces pending | [06 Plugins](architecture/06-plugins-and-capabilities.md), [parity register](parity.md) |
| ADR-0045 | [Release-owned plugin-authoring skill](decisions/ADR-0045-default-plugin-authoring-skill.md) | Decision | Implemented as an on-demand resource | [06 Plugins](architecture/06-plugins-and-capabilities.md) |
| PROP-0026 | [Connect structural sketch lines in the terminal display](architecture/proposals/PROP-0026-connected-sketch-display.md) | Proposal | Implemented; working tree and isolated fixtures verified | [ADR-0027](decisions/ADR-0027-connected-sketch-display.md), [11 Terminal](architecture/11-terminal.md), [parity register](parity.md) |
| ADR-0027 | [Project structural ASCII sketch lines into connected terminal borders](decisions/ADR-0027-connected-sketch-display.md) | Decision | Accepted; working tree and isolated fixtures verified | [PROP-0026](architecture/proposals/PROP-0026-connected-sketch-display.md), [14 Surfaces and parity](architecture/14-surfaces-and-parity.md) |
| FW-0001 | [Agent Modes, starting with Router Agent Mode](future-work.md#fw-0001-agent-modes-starting-with-router-agent-mode) | Future work | Candidate; requires architecture proposal before implementation | [Architecture glossary](architecture/README.md#glossary), [Feature guide](features/README.md#planned-agent-modes) |
| PROP-0025 | [Strict question columns and contextual ASCII wireframes](architecture/proposals/PROP-0025-contextual-question-wireframes.md) | Proposal | Implemented; working tree and isolated fixtures verified | [ADR-0026](decisions/ADR-0026-contextual-question-wireframes.md), [11 Terminal](architecture/11-terminal.md), [parity register](parity.md) |
| ADR-0026 | [Align question columns and preserve contextual ASCII wireframes](decisions/ADR-0026-contextual-question-wireframes.md) | Decision | Accepted; working tree and isolated fixtures verified | [PROP-0025](architecture/proposals/PROP-0025-contextual-question-wireframes.md), [02 Sessions and runs](architecture/02-sessions-and-runs.md), [11 Terminal](architecture/11-terminal.md) |
| ADR-0025 | [Store bounded ASCII sketches with question requests](decisions/ADR-0025-question-choice-sketches.md) | Decision | Accepted; working tree implementation verified | [PROP-0024](architecture/proposals/PROP-0024-question-sketch-previews.md) |
| ADR-0024 | [Publish the Harness CLI as xagent](decisions/ADR-0024-xagent-command.md) | Decision | Accepted; implemented in the 4.0.0 candidate | [PROP-0023](architecture/proposals/PROP-0023-xagent-cli-name.md) |
| ADR-0020 | [Page annotations and delivery are Harness-owned](decisions/ADR-0020-page-annotations.md) | Decision | Accepted; 4.0.0 candidate | [PROP-0017](architecture/proposals/PROP-0017-page-annotations.md), [PROP-0018](architecture/proposals/PROP-0018-annotation-queue-and-app-targets.md), [parity register](parity.md) |
| ADR-0019 | [Managed Git worktrees are a Harness capability](decisions/ADR-0019-managed-git-worktrees.md) | Decision | Accepted; 4.0.0 candidate | [PROP-0016](architecture/proposals/PROP-0016-managed-worktrees.md), [parity register](parity.md) |
| ADR-0018 | [Built-in feature modules and namespaced commands](decisions/ADR-0018-builtin-feature-plugins.md) | Decision | Accepted; 4.0.0 candidate | [PROP-0020](architecture/proposals/PROP-0020-builtin-feature-plugins.md) |
| ADR-0017 | [One capability surface for the terminal and every host](decisions/ADR-0017-one-capability-surface.md) | Decision | Accepted; implementation in 4.0.0 candidate, App parity gaps tracked | [PROP-0015](architecture/proposals/PROP-0015-one-capability-surface.md), [PROP-0016](architecture/proposals/PROP-0016-managed-worktrees.md), [PROP-0017](architecture/proposals/PROP-0017-page-annotations.md), [parity register](parity.md) |
| ADR-0016 | [Full-screen browser tabs](decisions/ADR-0016-fullscreen-browser-tabs.md) | Decision | Accepted; working tree verified | [PROP-0014](architecture/proposals/PROP-0014-fullscreen-browser-tabs.md) |
| ADR-0015 | [Unified resource browser](decisions/ADR-0015-resource-browser.md) | Decision | Accepted; working tree verified | [PROP-0013](architecture/proposals/PROP-0013-resource-browser.md), [source study](study/tui-resource-browser.md) |
| ADR-0014 | [Public release baseline](decisions/ADR-0014-public-release-baseline.md) | Decision | Accepted; 1.0.0 published; 4.0.0 candidate in preparation | [Release procedure](releases/README.md), [PROP-0012](architecture/proposals/PROP-0012-release-baseline.md) |
| ADR-0013 | [Evidence-based diagnostics with opt-in live probes](decisions/ADR-0013-doctor.md) | Decision | Accepted; working tree implementation | [PROP-0011](architecture/proposals/PROP-0011-doctor.md), [Doctor guide](doctor.md) |
| SPEC | [Harness architecture specification](architecture/README.md) | Specification | Binding; as of 2026-10-21 | [Proposals](architecture/proposals/README.md), [Known drift](architecture/README.md#known-drift) |
| STUDY-0002 | [Proactive autonomy: a harness with its own readable agenda](study/proactive-autonomy.md) | Study | Research and three feature hypotheses; not implemented | [Proactive-system sources](study/autonomy-sources.md), [engineering sources](study/autonomous-engineering-sources.md), [known drift D-11](architecture/README.md#known-drift) |
| STUDY-0001 | [Agent-harness arm study](study/00-index.md) | Study | Arms 01–10 audited (core sources); matrix + roadmap done; remaining-source fills pending | [insights.md](study/insights.md), [roadmap.md](study/roadmap.md), [`/btw` comparison](study/btw-comparison.md) |
| DESIGN-0001 | [System-prompt design: fixed foundation + adapting harness](system-prompt-design.md) | Design | Draft — not yet accepted; refs current `compile.ts`/tree contracts | STUDY-0001 (arms 01, 10), [roadmap.md](study/roadmap.md) T1-1/9 |
| EXP-0001 | [Terminal input latency profile](experiments/EXP-0001-terminal-input-latency/plan.md) | Experiment | Completed on one local machine; slow-machine validation pending | ADR-0001, [Profile instructions](terminal-tui.md#input-performance-profile) |
| ADR-0012 | [Agents name their own native Pi sessions](decisions/ADR-0012-native-session-names.md) | Decision | Accepted; working tree implementation verified | [PROP-0010](architecture/proposals/PROP-0010-session-names.md) |
| ADR-0011 | [The harness is a fixed foundation running a mutating variant](decisions/ADR-0011-foundation-and-variants.md) | Decision | Accepted; implemented in 5.0.0 | [PROP-0009](architecture/proposals/PROP-0009-foundation-and-variants.md), [Foundation and variants](architecture/00-overview.md#foundation-and-variants) |
| ADR-0010 | [Lessons from ordinary runs live in the Wiki](decisions/ADR-0010-lessons-in-the-wiki.md) | Decision | Accepted; working tree implementation | [PROP-0008](architecture/proposals/PROP-0008-lessons-from-runs.md), [08 Memory and history](architecture/08-memory-and-history.md), [feature-gap review](study/feature-gap-review.md) |
| ADR-0009 | [Publish the Harness CLI as xharness](decisions/ADR-0009-xharness-command.md) | Decision | Superseded by ADR-0024 | [PROP-0005](architecture/proposals/PROP-0005-xharness-cli-name.md), [11 Terminal](architecture/11-terminal.md) |
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
