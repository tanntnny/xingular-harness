---
id: ADR-0038
title: Plan-mode Bash is read-only by OS sandbox, not by command parsing
status: Accepted
created: 2026-10-26
proposal: PROP-0043
---

# ADR-0038: Plan-mode Bash is read-only by OS sandbox, not by command parsing

## Decision

Plan runs may use Bash, and each call runs in the workspace sandbox's `read-only` scope: no writes
except a discarded per-call temp folder, no network, no signals outside the sandbox, and (macOS) no
mach services. Nothing widens that scope in plan mode. A small denylist of system-acting commands is
checked by the gate as defence in depth only.

## Rationale

Whether a shell command writes cannot be decided reliably from its text; many read-looking commands
can run others or write through flags. The Harness already depends on `sandbox-exec` and `bwrap` for
the workspace boundary (ADR-0036), so the same mechanism with no write roots gives a kernel-enforced
read-only guarantee at little cost.

## Consequences

Plans can inspect with real commands. Commands that need to write, such as most builds and tests,
fail in plan mode. Platforms without a sandbox refuse plan Bash. See
[PROP-0043](../architecture/proposals/PROP-0043-read-only-plan-bash.md).
