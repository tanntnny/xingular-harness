# ADR-0022 — Question tools are available only in attended plan runs

Status: Accepted (owner requested implementation of PROP-0022, 2026-10-24).
Related: [PROP-0022](../architecture/proposals/PROP-0022-plan-only-questions.md),
[02 Sessions and runs](../architecture/02-sessions-and-runs.md),
[11 Terminal](../architecture/11-terminal.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

Ordinary chat exposed the Harness-owned `ask_user` tool, while the terminal also activated its
single-question `ask_user_question` tool in normal mode. Hiding the required `ask-user` plugin would
also remove it from plan mode and contradict its required-plugin contract. The callable tool set
must instead be resolved by run mode.

## Decision

Newly resolved normal runs omit `ask_user` before their capability set is frozen, regardless of a
wider requested tool list. An attended plan run may receive it, subject to the caller's narrower
capabilities. Automatic, probe, improver and reflection runs do not receive it. In the terminal,
normal mode deactivates both question tools; a plan request temporarily enables the registered
question tools and restores the previous active set on success, error or interruption.

The required `ask-user` built-in remains attached and has no user-facing switch. Approval prompts
and ordinary assistant text are unaffected. A continuation preserves the earlier frozen capability
set; if that snapshot includes `ask_user`, an automatic or refinement-triggered continuation is
rejected with `continuation_mismatch` rather than silently narrowing the snapshot or allowing an
unattended question.

## Consequences

Normal and plan requests can have different provider tool schemas, so no cache-preservation claim is
made; measure any provider-cache effect only under `INV-PRM-8`. Existing records and attachments need
no migration. The App relies on the Harness-resolved tool set and adds no separate preference.
