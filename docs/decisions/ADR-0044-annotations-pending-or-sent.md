---
id: ADR-0044
title: An annotation is pending or sent; the agent's page-note tools are read-only
status: Accepted
created: 2026-10-27
---

# ADR-0044: An annotation is pending or sent

## Decision

- Every annotation a person makes in the inspector with a session is shared with that session at
  once and is **pending** until sent. There is no queue to add to or take out of, and no "fixed"
  state. Records written before keep working: `queued` reads as `pending`, `fixed` as `sent`.
- The popover has two actions, Annotate and Annotate & send. A send sends every pending note of
  the session as one message, optionally followed by the person's request (`/annotate:submit`).
- `page_notes_mark_fixed` is removed. The agent reads annotations; only the person resolves them.
- A held-back send is retried while the session is still busy after a run ends.
- Built-in plugin commands may be `rootOnly`, so a namespace root is not listed twice.

## Why

People found three actions, a queue and a fix status too much to control, and the extra state is
what made sends fail silently. See [PROP-0048](../architecture/proposals/PROP-0048-simple-annotate.md).
