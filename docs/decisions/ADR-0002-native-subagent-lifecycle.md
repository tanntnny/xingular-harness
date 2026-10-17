---
id: ADR-0002
title: Native subagent lifecycle in Harness sessions
status: superseded
superseded_by: ADR-0003
created: 2026-10-18
updated: 2026-10-18
---
# ADR-0002 — Native subagent lifecycle in Harness sessions

Superseded by [ADR-0003](ADR-0003-shared-asynchronous-subagents.md), which expands the native
service to asynchronous execution, reliable delivery, and terminal parity. The earlier decision
and its rationale are retained below.

## Context

Subagents already used Harness sessions, capability snapshots and run lineage, but their tool
owned launching and polled run files for completion. A host inferred ownership from session
names, coupling it to an internal identifier format.

## Decision

`Sessions.spawnSubagent` owns child creation. A live parent's captured launch supplies caller,
account, model selection, folder, policy context, prompt and capability ceiling. The host or
model supplies only a complete brief and an optional tool subset. Current capability availability
and the captured nesting limit further restrict each child. Empty tool subsets stay empty;
spawning permission is never added back after narrowing. Children start with fresh history,
without inherited image attachments or request preamble. Existing tool gating applies.

The model tool is an adapter to the same native API exposed over RPC. `RunRegistry.wait` resolves
on settlement, including failed startup and interruption, without polling or per-call listeners.
The Harness Subagents plugin attributes the model-visible tool. Opt-in remains a session option;
`{}` selects the Harness default depth of one. Application organization delegation remains a host
concern. Consumers resolve ownership from run lineage rather than parsing session IDs.

## Alternatives and consequences

Keeping orchestration in the tool would leave hosts without the same lifecycle contract.
Moving application organizations into Harness would violate the embedding boundary. A new
background job manager would duplicate existing run tracking, approvals and interruption.
The selected change reuses these layers and preserves the synchronous model tool behavior.
The native API starts children only for live parents in the same Harness instance; it does not
resume a stopped parent's launch or implement cross-process child management.

## Evidence

Regression coverage is in `src/sessions/sessions.test.ts` and `src/server/server.test.ts`.
Application host and run-family tests cover nested lineage with opaque session IDs. Verification
results belong to the implementation handoff; no release or live-provider behavior is claimed.
