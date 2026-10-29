---
id: ADR-0055
title: An attended plan run repairs a missing plan block once, in the same run
status: Accepted
created: 2026-10-28
---

# ADR-0055: An attended plan run repairs a missing plan block once, in the same run

## Context

Plan mode ends with a `<proposed_plan>` block that both the terminal and the App parse into a plan
card and the Implement choice. The block is an instruction to the model, not a schema, and a model
can omit it while still writing a correct plan body. On 2026-10-28 two attended plan runs in one
terminal session did exactly that: the plan instructions and the plan-only tool set were present,
the model's reasoning said it would tag the plan, and the final text had no block. The renderer then
showed ordinary assistant text with no card, no plan choice and no Implement.

The tag contract is deliberately text-only: it keeps the plan tool list and the cached prompt prefix
unchanged when the mode switches. Replacing it with a plan tool or a plan artifact would change that
boundary, the protocol and both renderers for a rare omission.

## Decision

When a top-level attended plan run ends without a complete plan block, the harness makes one hidden
format-repair turn in the same run. The custom message is not displayed, carries no new user
request, and asks the model to re-send its own plan, unchanged, in one complete block; a model that
was asking for input answers `No plan:` instead. The repair is attempted once, uses the same plan
tool set and gate, and is skipped for plan-research children, commands, probes, improvers,
reflections and other unattended runs.

If the repair also fails, the plan run still completes: the original reply stays in the transcript,
the harness records an `extension.notice` warning, and the terminal shows a warning instead of a
plan choice. The App shows the repaired card when the repair succeeds and otherwise keeps the
untagged reply.

## Rationale

The repair is the smallest change at the ownership layer that preserves the existing plan contract and
both surfaces. It does not fabricate a plan or guess where one starts, and it leaves the plan tool
list, the prompt prefix and the run event schema unchanged. Asking the model to re-send its own
answer is cheaper and less disruptive than re-planning, and a single bounded attempt keeps the extra
cost and latency predictable.

## Consequences

An attended plan run may make one additional model request and produce a second assistant message;
the first untagged reply remains visible. The extra request is counted in the run's usage, and the
run record, status and event types are unchanged. If the repair proves insufficient, a structured
plan tool or artifact remains the durable follow-up, but it changes the tool list, the cached prefix
and both renderers and is not part of this decision.
