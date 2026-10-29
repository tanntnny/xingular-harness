---
id: ADR-0060
title: Approvals are controls, not messages
status: Accepted
created: 2026-10-29
---

# ADR-0060: Approvals are controls, not messages

## Context

The gate already pauses a call that needs a person, reports `waiting_for_approval`, and resumes the
same call when it is allowed. But the compiled guidance said an outside file target "requires
one-call approval", and a denial said "Ask how they would like to proceed". A model read the first as
a prerequisite and ended its turn: the person then had to type an approval in a message before the
work could continue. Typed permission is neither recorded as a decision nor bound to the call it
authorizes, and it leaves the run idle while a control could have resolved it.

## Decision

An approval is a control a person operates, never a permission asked for or granted in a message.
The gate pauses the exact call, the run reports `waiting_for_approval`, Allow resumes that same call
in the same turn, and Deny returns a tool result on the still-running turn. The compiled prompt
states this rule and tells the model to call the tool rather than ask for permission, end its turn to
wait, or report a task as blocked before trying it. Denial text tells the model to continue instead
of asking again. Surfaces present a control: the terminal's decision dock and keypress, the App's
dock above the composer with an approval notification, and a paired phone's choices. A surface that
cannot ask a person refuses the call; it never waits for a message.

The boundary still applies before the effect. This decision changes who speaks, not when a call runs:
nothing outside the workspace changes before the click, and Full Permission remains the explicit
standing bypass for eligible runs.

## Consequences

The run survives the wait and resumes in place, and no approval depends on prose a person typed.
Clients must present a control for every request they surface (`INV-GATE-9`). A host that cannot
present one must refuse the call, and the model must treat that refusal as the tool result rather
than asking again. Recorded decisions, standing approvals and the refusal codes stay unchanged; only
the wording the model reads after a denial changed.
