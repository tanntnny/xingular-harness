---
id: ADR-0065
title: A conversation switches variant version only by the person's action, at a turn boundary
status: Accepted
created: 2026-10-30
---

# ADR-0065: A conversation switches variant version only by the person's action, at a turn boundary

## Context

`INV-VAR-4` pinned a conversation's variant once: every later turn used the same files even when
the head moved. That kept runs reproducible and the provider cache warm, but an improvement a
person adopted reached only their next conversation (PROP-0052).

## Decision

- A conversation has a **selected version**. It starts as the head (or the version the host names)
  and changes only when the person, in this session, adopts a refinement, restores or reverts a
  version, or picks one. A head moved elsewhere is shown, never followed.
- The change takes effect at the next turn boundary. A running reply finishes on its version;
  every run pins exactly one version (`INV-RUN-1`).
- The terminal applies it by restarting its frontend on the chosen version and resuming the same
  native conversation, through the existing relaunch path (`TerminalRelaunch.variantVersion`). The
  prompt pack is compiled again, so the provider cache misses once.
- When the version records `tunedFor` and the chat runs another model, the person is told.

## Consequences

Run records keep naming the version each run used, so a conversation's history shows where it
switched. A terminal's harness session id changes across the restart; the native session does not.
