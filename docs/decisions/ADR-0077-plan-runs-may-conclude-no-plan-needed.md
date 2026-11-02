---
id: ADR-0077
title: A plan run may conclude that no plan is needed
status: accepted
created: 2026-11-02
updated: 2026-11-02
supersedes: ADR-0055 (its "every attended plan reply must carry a block" criterion), ADR-0057 and ADR-0058 (their repair criterion), not their mechanisms
related:
  - ADR-0055
  - ADR-0057
  - ADR-0058
  - ADR-0074
  - ADR-0075
---
# ADR-0077 — A plan run may conclude that no plan is needed

> **Supersedes the repair criterion of [ADR-0055](ADR-0055-plan-output-repair.md),
> [ADR-0057](ADR-0057-structured-plan-outcomes.md) and
> [ADR-0058](ADR-0058-ask-user-only-plan-clarification.md), not their mechanisms.** The same-run,
> one-attempt repair, the shared classification, the tool gate and the `<plan_blocked>` channel stay.

## Context

Plan mode had no legitimate empty outcome. Its classification recognized `plan_ready` (one complete
`<proposed_plan>` block), `blocked` (required input that `ask_user` could not obtain) and `invalid`
for everything else, so a reply that concluded there was nothing to do was a formatting failure.
Two instructions then demanded an artifact: the plan section ended "end the reply with exactly one
block", and the hidden repair turn told the model to re-send its plan inside one block and offered
only a blocked block as the alternative.

The result is a fabricated plan. A person who asked the agent to plan work that already exists, or
who said not to plan at all, received a plan anyway: the harness's own instruction outranked the
person's, and the repair repeated it. Two live cases in one harness test session did exactly that —
a no-op plan whose only content restated the request, and then, after the person rejected it, a
second plan produced by the repair turn. The appetite for a required artifact had already been
rejected elsewhere: ADR-0074 removed the required report blocks, and ADR-0075 removed the stop gate.

A second defect sits beside the first. Tag accounting was a raw substring count over the whole
reply, so a reply that quoted plan syntax inside a fenced or inline code block declared extra
outcomes and became `invalid`. That is how a plan *about* the plan tags failed its own parser.

## Decision

Add `no_plan` to the plan outcome contract:

| Reply ending | Outcome |
|---|---|
| One complete, nonempty `<proposed_plan>` block, outside code | `plan_ready` |
| One complete, nonempty `<plan_blocked>` block, outside code | `blocked` |
| No outcome tag at all, nonempty text | `no_plan` |
| Unbalanced, empty, duplicated or conflicting tags; legacy `<plan_clarification>`; empty reply | `invalid` |

- `no_plan` is a conclusion, not a failure. It offers no plan card, no Implement, no notice and no
  warning in any surface, and it never costs a second model request.
- The plan section says that a reply with no block is a valid ending, that the model must check
  whether the requested work already exists before designing it, and that a person's instruction
  not to plan outranks the mode's output shape.
- The repair keeps its one bounded attempt, the same run and the same tool gate, but exists only
  for `invalid`: a block the model started and left incomplete, empty or in conflict. It may finish
  that block, may state that there is nothing to plan, or may return the blocked block. It may not
  re-plan, research again, invent a decision or invent work to fill a block.
- Tags outside fenced and inline code alone declare an outcome; a quoted example is text. The rule
  matches the one the App already used to split a plan out of a reply.

The outcome stays derived from reply text. No run event, run-record field, storage layout, server
method or host schema changes, so clients that understand only the plan tag keep working.

## Rationale

The contract conflated *format* with *outcome*. Once the artifact is the only way to answer, every
honest "nothing to do" becomes a lie about the work, and the repair turn is the machinery that asks
for the lie. Making the empty conclusion explicit fixes the cause instead of the symptom, and it
keeps the plan card exactly where it is useful: on a reply that actually contains a plan.

Text-derived classification is cheaper than the alternatives. A `no_plan` tag would still demand an
artifact for every request. A plan tool would change the tool list at the moment the mode switches,
changing the cached prompt prefix in headless runs, and would need a new renderer path in the
terminal and the App. A declared free-text line (`No plan needed: …`) adds a phrase the model must
remember and makes its absence ambiguous again.

## Consequences

- A plan request that needs no plan answers in ordinary prose. The person sees no card and no
  warning, and the turn costs one request instead of two.
- A model that forgets the block for a real plan now loses the card and the Implement choice
  silently. The reply text remains, and asking again produces the plan; the alternative was to keep
  demanding an artifact that is sometimes fiction. The plan section still makes the block the
  default when there is work to design.
- Plan mode read as "research-only mode" rather than "always produce a plan", which is what a bare
  `/plan` toggle already meant in practice.
- Quoted or fenced plan syntax no longer invalidates a reply, so a reply may discuss the format
  without being repaired.
- `blocked` is unchanged: it still reports a required decision that `ask_user` could not obtain, and
  the terminal still warns about it.
- New final replies still must not use `<plan_clarification>` or free-text questions; `ask_user`
  remains the clarification channel.

## Alternatives

- **Keep requiring a block and allow a "nothing to do" sentence inside it.** Rejected: that is the
  ceremony the defect is about, and it makes a no-op plan look like a plan.
- **Add a `<no_plan>` tag.** Rejected: symmetric and simple to parse, but it still forces an
  artifact and a repair for every request, so the person's "do nothing" instruction is again
  overridden.
- **Add a plan tool.** Rejected for now: it changes the tool list and the cached prompt prefix, and
  needs new renderer paths in both surfaces, for a problem a classification change solves.
- **Drop the repair entirely.** Rejected: an incomplete block is a real, observable failure, and one
  bounded turn fixes it without costing the card.
- **Keep raw substring counting.** Rejected: a reply that quotes the tags was already misclassified,
  and with `no_plan` in place the false `invalid` would trigger the repair for a correct answer.

## Checks

`src/sessions/planMode.test.ts` covers the outcome table, the code-fence rule, repair exclusion for
`no_plan` and the instruction text. `src/sessions/sessions.test.ts` covers a plain no-plan reply
with no repair and no warning, a repaired no-plan reply, and a malformed block repaired once.
`src/terminal/piExtension.lifecycle.test.ts`, `src/terminal/opentui/app.test.ts` and
`src/terminal/tui/runtime.socket.test.ts` cover the same contract at the terminal's settlement
boundary and in the plan choice. The App needs no code change: it renders a card only for a complete
block and shows nothing otherwise.
