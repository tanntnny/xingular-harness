---
id: ADR-0067
title: The compaction checkpoint arms only for a compaction during its run and stays in place
status: Accepted
created: 2026-10-30
---

# ADR-0067: The compaction checkpoint arms only for a compaction during its run and stays in place

Supersedes the delivery part of [ADR-0032](ADR-0032-compaction-run-checkpoints.md); what the
checkpoint holds and its bounds are unchanged.

## Context

Under ADR-0032 the checkpoint was appended to the end of every model request, rebuilt each time, in
every run whose context held a compaction summary. A summary stays in context for the rest of the
session, so every later turn received it, though that turn's request, todo list and plan were in live
history.

Because the checkpoint was always last, a request was never the previous request plus its reply.
Pi's Codex WebSocket continuation (`previous_response_id` with only the new items) needs that shape,
so every request became a full resend. Provider prefix caches also stopped extending.

In a measured terminal session (6.1 Terra and 6 Luna), caching ran at 94–99% before the first
compaction and 18–24% after it. Replaying that session's saved history through Pi's request builder
showed the history itself was append-only:
- With the old checkpoint, 138 of 151 post-compaction requests were full resends.
- With this decision, 1 was: the request right after a second compaction.

A live probe on `openai-codex/gpt-6-luna` (2026-10-30, three pairs of disposable sessions with the
owner's permission) forced one compaction mid-run, then ran a follow-up turn that wrote a todo list:
- With the old checkpoint, every request after the compaction in that run read 0 cached tokens. In
  the follow-up turn the cached amount stayed fixed while uncached input grew.
- With this decision, those requests were cached at 47–66%, against a ceiling of about 76% for
  contexts that small. The follow-up turn was cached at 61–79%.

## Decision

- **Only a compaction during the run arms it.** The extension records the summary already in context
  at the run's first request. Only a different summary, a compaction that happened while the run was
  working, produces a checkpoint. A run that starts from compacted history gets none.
- **Built once, placed after the summary.** The checkpoint is rendered once per compaction from the
  run's request, todo list and plan instructions at that moment. It is inserted directly after the
  `compactionSummary` message, with the same text and timestamp on every later request. Todo updates
  after the compaction are already in history as `todo_write` calls; the checkpoint says that later
  updates supersede it. A further compaction in the same run rebuilds it.
- It stays ephemeral: not persisted, no event, cleared when the run settles or the branch changes.

## Consequences

Each request after a compaction is again the previous request plus new items, so continuation and
prefix caching work until the next compaction. The checkpoint's todo can be older than the latest
`todo_write`, which follows it in context. A run whose compaction found no todo list or plan gets no
checkpoint, even if it writes a todo list later; that list is in its live history.
