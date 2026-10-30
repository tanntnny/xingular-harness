# ADR-0032 — Rehydrate bounded run checkpoints after compaction

Status: Accepted (PROP-0033, 2026-10-25). Delivery superseded in part by
[ADR-0067](ADR-0067-cache-stable-compaction-checkpoint.md): the checkpoint arms only for a compaction
during its run and sits, unchanged, right after the summary.
Related: [PROP-0033](../architecture/proposals/PROP-0033-compaction-plan-checkpoints.md),
[02 Sessions and runs](../architecture/02-sessions-and-runs.md),
[04 Prompt](../architecture/04-prompt.md),
[11 Terminal](../architecture/11-terminal.md),
[14 Surfaces and parity](../architecture/14-surfaces-and-parity.md).

## Context

Pi preserves the native conversation transcript when compacting, but subsequent model requests use a
summary and recent messages. The Harness already records the latest checklist as a run event and
restores it when a stopped run is continued; an active run lacked equivalent rehydration after
compaction. SDK plan instructions are dynamic context and may also be included in the summarized
span.

## Decision

After compaction, each model request in the still-active run receives one bounded, ephemeral context
message when a checklist or applicable plan instructions exist to restore. It contains the current
request and available state. The prompt compiler assembles this content, and one Harness-owned
extension provides the same behavior to embedded sessions and the terminal. The extension state is run-scoped and clears on
settlement or branch navigation. The context message is not persisted to the native transcript or
run-event stream; existing session history, checklist events and continuation records remain the
sources of durable state. Hidden reasoning is never captured.

## Consequences

Post-compaction requests carry a small additional context block until the active run settles. The
feature adds no storage, event, server method, tool, permission or stable-system-prompt change. Plan
mode's existing gate remains authoritative. Runs without an explicit checklist or active plan state
receive no checkpoint.
