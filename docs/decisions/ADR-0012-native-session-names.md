---
id: ADR-0012
title: Agents name their own native Pi sessions
status: accepted
created: 2026-10-22
updated: 2026-10-22
related: [PROP-0010]
---

# ADR-0012: Agents name their own native Pi sessions

## Context
The terminal already supports manual native Pi session names. The user requested agent
creation and revision, with a six-word limit and a name after the working metrics, in all
Harness execution paths. The user approved this implementation plan.

## Decision
A shared foundation tool binds to the current native session and uses Pi session-info
history as the only writer and source of truth. The normal gate and capability selection
apply. Plan mode permits naming as session metadata maintenance. Fixed tool guidance asks
the agent to name work early and rename on objective changes; no changing name enters the
system prompt. The terminal refreshes through the existing native metadata event.

## Alternatives
A separate model call adds latency and cost. Separate title storage duplicates native
metadata and requires synchronization. Manual-only names do not meet the requested behavior.

## Consequences and evidence
No migration or new host RPC is needed. The agent chooses when to invoke the tool, so
actual naming frequency depends on model compliance. Manual names can be revised by the
agent. Tests in `src/tools/sessionName.test.ts`, `src/sessions/sessions.test.ts`, and the
terminal lifecycle, runtime, working-line and application tests cover the contract.
Implementation and verification status are tracked in
[PROP-0010](../architecture/proposals/PROP-0010-session-names.md).
