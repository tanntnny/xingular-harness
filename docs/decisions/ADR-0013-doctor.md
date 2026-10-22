---
id: ADR-0013
title: Evidence-based diagnostics with opt-in live probes
status: accepted
created: 2026-10-22
updated: 2026-10-22
---

# ADR-0013 — Evidence-based diagnostics with opt-in live probes

## Context and decision

[PROP-0011](../architecture/proposals/PROP-0011-doctor.md) records the user-approved plan.
A configured tool or locally available model is not evidence of a successful request.
`/doctor` therefore checks readiness offline and labels live verification separately.

The foundation owns bounded, cancellable diagnostic jobs and validated findings. Tool-provider
callbacks supply backend-specific evidence using the existing extension point. Live tool calls
use the production gate and current capabilities. One synthetic model request uses the selected
account's Pi runtime and records usage in a separate diagnostic run.

## Consequences

Existing providers remain compatible. Unsupported checks are unverified, disabled capabilities
are disabled, and permission or isolation constraints are blocked. No diagnostic changes an
account, configuration or permission. Browser tests have a disposable profile and offline page;
computer input tests require a host-supplied disposable surface. No live tests run automatically.
