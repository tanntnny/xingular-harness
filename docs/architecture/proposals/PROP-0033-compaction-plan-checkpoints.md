---
id: PROP-0033
title: Rehydrate bounded run checkpoints after compaction
status: Accepted
created: 2026-10-25
updated: 2026-10-25
affects: [INV-PRM-1, INV-PRM-4, INV-RUN-8, 02-sessions-and-runs.md, 04-prompt.md, 11-terminal.md, 14-surfaces-and-parity.md, ADR-0032]
---

# PROP-0033: Rehydrate bounded run checkpoints after compaction

## Problem

Pi keeps the native transcript when it compacts context, but the model receives a summary and
recent messages. A run's latest checklist is already persisted as `checklist.updated`, and
continuations restore it, but the active run does not put that state back into model context after a
successful compaction. Dynamic plan instructions can likewise be summarized away during an SDK
run. This can leave an unfinished task without a reliable current step or planning contract.

## Affected rules

- **INV-PRM-1:** “The prompt is assembled only in `src/prompt/compile.ts`. Nothing else builds
  model instructions.” The checkpoint must use that compiler.
- **INV-PRM-4:** “An update carries only changed dynamic sections, so an unchanged turn appends
  nothing. A compaction on the active branch forces the full snapshot again.” This proposal adds
  rehydration inside an active run, before its next model request.
- **INV-RUN-8:** Plan-mode tools and gate restrictions stay unchanged; checkpointing must not widen
  the callable set or change the stable system prompt.

## Proposal

- Add a foundation-owned Pi extension, used by both `Sessions.run` and the Harness terminal. It
  observes successful checklist tool results and the active request, and detects compaction through
  the model-context projection.
- After compaction, on each model request while that run remains active, append one ephemeral,
  hidden context message compiled by `src/prompt/compile.ts`. It contains the bounded user request,
  the latest validated checklist (including current and pending items), and current plan-mode
  instructions when applicable. Continuations may seed it from their already persisted checklist.
- Do not persist the checkpoint as another session entry or run event. Keep it scoped to the active
  request, clear its in-memory state when that run settles or the branch changes, and never include
  hidden reasoning. The existing native transcript, `checklist.updated` event and continuation
  behavior remain the durable records.
- Keep all authorization in the existing plan-mode gate. The checkpoint only restores context; it
  grants no tools or permissions.

## Alternatives

- **Rely on the compaction summary to retain progress.** Rejected: the summarizer is probabilistic
  and may omit exact checklist state or dynamic plan instructions.
- **Add a checkpoint side file or run-event type.** Rejected: the run already records its checklist,
  and an additional durable format would duplicate state and require protocol migration.
- **Persist a custom context message after every compaction.** Rejected: it would remain in future
  requests after the active run ended. An ephemeral context projection keeps the checkpoint
  request-scoped.
- **Do nothing.** Rejected: a bounded state checkpoint improves recovery without retaining the full
  conversation in model context.

## Consequences

After compaction, each model request in the active run receives the checkpoint again; this adds a
bounded amount of input until the run settles. There is no model call, run-event schema, public
method, storage-layout, or stable-prefix change. Both the terminal and embedding sessions use the
same compiler and checkpoint semantics. Existing application event validators require no update.

## Migration

None. Existing run events and native session histories remain readable. Runs without a checklist or
active plan context receive no checkpoint. Interrupted-run continuation continues to use its
existing dynamic continuation section.

## Checks

Test the compiler's bounds and content, active compaction detection, per-request reinjection,
checklist updates, plan instruction restoration, and state clearing. Run Harness `npm run typecheck`,
`npm test`, and `npm run prove`, then the Xingular Agent App checks required for a Harness change.
