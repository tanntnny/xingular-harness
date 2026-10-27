---
id: ADR-0040
title: Architecture changes do not require proposal approval first
status: Accepted
created: 2026-10-27
---

# ADR-0040: Architecture changes do not require proposal approval first

## Decision

The architecture specification remains binding, and changes that alter its contracts, invariants,
layer boundaries, extension points, or storage layout must update the affected specification pages
in the same change. Such work does not require a proposal or user approval before implementation.

Proposals remain optional design records. When used, they may be created before or alongside
implementation and should be indexed and status-tracked. Add an ADR for a lasting architectural
choice. Report existing code/spec drift and resolve relevant drift by updating both sides together
within the requested scope.

## Rationale

A binding specification and same-change documentation keep implementation accountable to the
architecture without making a separate proposal review a prerequisite to requested work. Optional
proposals remain available when a design benefits from a written comparison or durable rationale.

## Consequences

Coding agents read the affected specification pages, implement the requested change, update the
specification in the same change, and run relevant checks. Proposal status records design review or
implementation progress but does not gate implementation.
