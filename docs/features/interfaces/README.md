# Interfaces

The same Harness runtime can be embedded by a Node application, hosted as a child process by another
language, or used through its standalone terminal.

## Node embedding

A Node host constructs the package with `createHarness(...)`, supplies application-owned capabilities
through the extension points, and uses its sessions, runs, accounts, variants, and other services
directly. The [embedding guide](../../README.md#using-it-from-node) has a code example and API details.

## Server protocol

A non-Node host can run the Harness server and exchange newline-delimited JSON messages over stdin
and stdout. The protocol exposes the Harness API, saved run events, state-change notices, and calls
for host-provided extension points.

## Standalone terminal

`xagent` provides the Harness-owned OpenTUI terminal over a persistent Pi session. An embedding
application may host the terminal in its own PTY; the Harness owns the terminal UI and session
behavior, while the host owns PTY and process supervision.

## Further reading

- [01 Extension points](../../architecture/01-extension-points.md) — how an embedding application extends the Harness.
- [10 Server protocol](../../architecture/10-server-protocol.md) — wire format and method contract.
- [11 Terminal](../../architecture/11-terminal.md) — terminal ownership and runtime.
- [Terminal guide](../../terminal-tui.md) — implementation details and verification evidence.
