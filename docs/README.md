# Harness documentation

Current implementation: [Harness terminal frontend](terminal-tui.md). The package-level
[README](../README.md) describes the embedding API, accounts, plugins, memory and storage.

| ID | Record | Type | Status | Related |
|---|---|---|---|---|
| ADR-0003 | [Shared asynchronous subagents with native-history delivery receipts](decisions/ADR-0003-shared-asynchronous-subagents.md) | Decision | Accepted; working tree implementation | ADR-0002, [Embedding API](../README.md) |
| ADR-0002 | [Native subagent lifecycle in Harness sessions](decisions/ADR-0002-native-subagent-lifecycle.md) | Decision | Superseded by ADR-0003 | [Embedding API](../README.md) |
| ADR-0001 | [Own the terminal frontend and keep Pi as the session runtime](decisions/ADR-0001-owned-terminal.md) | Decision | Accepted; working tree implementation | [Terminal architecture and evidence](terminal-tui.md) |

Living reference pages describe checked source behavior. Accepted decisions record the choice;
they do not establish publication or release. Evidence references on the terminal page identify
the inspected upstream artifacts and bound the verification claims.
