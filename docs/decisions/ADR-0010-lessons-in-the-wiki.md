---
id: ADR-0010
title: Lessons from ordinary runs live in the Wiki, not in trees or the refinement library
status: accepted
created: 2026-10-22
updated: 2026-10-22
---
# ADR-0010 — Lessons from ordinary runs live in the Wiki

## Context and decision

[PROP-0008](../architecture/proposals/PROP-0008-lessons-from-runs.md) adds an opt-in reflection
after a finished run. The harness already has three places that hold what agents learn: the
harness tree (c3 memory, instructions), the refinement experience library (whole trees plus a
lesson, per scope and area), and the Wiki (reference notes).

Lessons from ordinary runs go to the Wiki, under `library/lessons/`, with refinement's lesson
shape (cue, lesson, evidence, confidence, or nothing).

- The tree changes only through refinement and a person's `adopt`. A lesson from one run is not
  enough evidence to change instructions every later run receives.
- The refinement library stores whole trees keyed by task area; an ordinary run has neither.
- The Wiki is reference material by contract (INV-MEM-1): an agent reads a lesson when it searches,
  and a person can read, edit or delete it like any note. A lesson that keeps proving itself is
  evidence for a later refinement, which is where behaviour changes.

## Consequences

- Lessons are visible and editable through every Wiki surface, versioned, and announced to hooks.
- They do not reach the stable prefix; only a count reaches the dynamic `wiki` pointer.
- The lesson shape is shared with refinement (`parseExperience`), so the two stay comparable.
