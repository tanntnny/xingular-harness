---
id: ADR-0011
title: The harness is a fixed foundation running a mutating variant
status: accepted
created: 2026-10-22
updated: 2026-10-22
---
# ADR-0011 — The harness is a fixed foundation running a mutating variant

## Context and decision

[PROP-0009](../architecture/proposals/PROP-0009-foundation-and-variants.md). The harness lets a
running host improve the harness itself, so two kinds of part must be told apart at all times: the
ones that never move during that improvement, and the ones that are meant to.

We call the first the **foundation** and the second a **variant**. A variant is one whole c1–c8
tree for one scope. The foundation decides what a variant may contain and how it runs; a variant
decides what the agent is told and may load. Refinement edits a copy of a variant, and only a
person's `adopt` makes it the head.

## Consequences

- Specs, code, storage and the protocol use the two words (`variants/`, `variants.*`,
  `VariantChoice`). `INV-FND-1` and `INV-FND-2` state the one-way rule.
- The same split names the prompt-level design in DESIGN-0001 (foundation text and the adapting
  surface).
- Breaking release (5.0.0). Stored data is migrated on `open`.
- The improver prompts keep the Harness² paper's wording, so the method is unchanged.
