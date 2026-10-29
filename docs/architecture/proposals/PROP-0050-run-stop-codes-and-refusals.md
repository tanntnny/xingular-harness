---
id: PROP-0050
title: Run stop codes and refusal evidence
status: Implemented
created: 2026-10-29
affects: [INV-RUN-3, INV-RUN-4, INV-GATE-1, INV-TUI-3, INV-PAR-1]
---

# PROP-0050: Run stop codes and refusal evidence

## Problem

A run's human-readable stop reason and tool results do not consistently identify the rule or
lifecycle event that stopped it. Diagnostics need recorded causes rather than guesses based on prose.
A settled run is not necessarily a finished task.

## Design

Record gate and work-slice refusals as `tool.refused` events, retaining the original tool response.
Record a fixed `terminalCode` separately from the descriptive `terminalReason`. Interrupted events
can carry the code; failure events retain their existing code and the run store maps it to a stop
code. Legacy records without a code remain unknown. Report known compaction measurements, and expose
refusals and stop evidence through trajectory search and the terminal trajectory page.

Terminal telemetry is best effort when the controller is unreachable. These fields do not infer
whether the requested work was completed and do not change the gate or its approval requirements.
The binding contracts are in [sessions and runs](../02-sessions-and-runs.md),
[tools and the gate](../07-tools-and-gate.md), [memory and history](../08-memory-and-history.md),
and [terminal](../11-terminal.md). The architectural decision is
[ADR-0059](../../decisions/ADR-0059-run-diagnostic-evidence.md).
