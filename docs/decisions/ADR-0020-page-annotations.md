# ADR-0020 — Page annotations and delivery are Harness-owned

Status: Accepted (owner approved the parity plan and capture workflow, 2026-10-23).
Related: [PROP-0017](../architecture/proposals/PROP-0017-page-annotations.md),
[PROP-0018](../architecture/proposals/PROP-0018-annotation-queue-and-app-targets.md),
[07 Tools and the gate](../architecture/07-tools-and-the-gate.md),
[13 World tools](../architecture/13-world-tools.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

Page annotations and the agent's ability to read or act on them must work in both the standalone
terminal and embedding hosts. Keeping the note store and tools inside one host would split state and
behavior; trusting arbitrary page-script output could let a page initiate unintended work.

## Decision

The Harness owns the canonical note store, sharing grants, page-note tools, queue and delivery
lifecycle, and generic capture contract. The terminal captures in its visible isolated browser; a
host supplies its own web-view or application-window adapter through the same contract. Capture
results are trusted only when they come from an isolated script world or the host's own UI; otherwise
sending requires person confirmation. Page-derived content remains untrusted in the delivered
instruction. A person controls sharing, queueing, confirmation, and resolution; the agent may mark a
shared note fixed but cannot resolve it or change grants.

## Alternatives

A terminal-only capture path would not support host web views. Host-owned stores and tools would
create different behavior and duplicated data. Trusting page content or automatically sending
unisolated results would grant a page authority it must not have.

## Consequences

Notes and grants have one Harness-owned representation and work through the terminal or a host.
Hosts retain ownership of native windows and browser UI while using Harness methods for notes,
sharing, and delivery. The server contract can represent capture targets without naming an
application.
