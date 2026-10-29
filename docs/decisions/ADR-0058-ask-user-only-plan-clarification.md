---
id: ADR-0058
title: Ask-user-only plan clarification
status: Accepted
---

# ADR-0058: Ask-user-only plan clarification

## Context

ADR-0057 allowed a final `<plan_clarification>` containing a question or explanation. That creates
another clarification channel alongside the blocking `ask_user` tool and can end a run instead of
continuing planning after the person's answer.

## Decision

For new attended top-level plan final replies, the shared server and terminal classification is
`plan_ready`, `blocked`, or `invalid`. A complete `<proposed_plan>` is `plan_ready` and alone offers
a plan card and Implement. If a required user decision cannot be obtained because `ask_user` is
unavailable, the reply is `blocked`: explain the blocker without inventing the decision, asking a
free-text question, or offering Implement. Malformed, missing or conflicting outcomes are `invalid`.
New final replies do not use `<plan_clarification>` or free-text questions for clarification.

When `ask_user` is available and clarification is needed, call it: it blocks the active run for the
answer, after which the same run continues. The existing one bounded hidden repair for an eligible
`invalid` outcome remains in the same run and under the same plan gate; it may call `ask_user` and
wait for the answer. If repair remains invalid, retain the original reply, warn and offer no
Implement. The existing repair exclusions remain in force.

## Compatibility and consequences

This supersedes ADR-0057's `needs_input` and `<plan_clarification>` final-outcome decision, not its
shared classification, bounded repair or other safeguards. Old transcripts remain intact and
visible, including historical clarification blocks; they are not rewritten or promoted into plans.
Existing plan cards, run events, permissions and the cached prompt boundary remain compatible. This
is an approved contract; implementation and surface acceptance must be verified separately.
