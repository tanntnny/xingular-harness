---
id: PROP-0011
title: Readiness diagnostics and explicit live probes
status: Accepted
created: 2026-10-22
updated: 2026-10-22
affects: [INV-EXT-1, INV-EXT-4, INV-GATE-1, INV-TUI-4, 01-extension-points.md, 07-tools-and-gate.md, 09-accounts-and-connectors.md, 10-server-protocol.md, 11-terminal.md]
---

# PROP-0011: Readiness diagnostics and explicit live probes

## Problem
Account status and tool registration do not establish that the selected model or backend works.
The user approved the `/doctor` implementation plan on 2026-10-22: full readiness coverage,
terminal plus reusable API, offline inspection by default, selected live probes, pinned account,
and isolated browser/computer interaction only.

## Affected rules
- INV-EXT-1: “There are seven extension points.” Optional diagnostic callbacks extend tool providers, not a new surface.
- INV-EXT-4: “Each Node extension point has a protocol equivalent”. Remote tool registration gains diagnostic metadata and a host readiness callback.
- INV-GATE-1: “Every tool call of every run passes the gate.” Live probes use that gate and capability resolution.
- INV-TUI-4: changes through the session socket require the terminal control key. All terminal diagnostics require it, including reads and cancellation.

## Proposal
A foundation `Doctor` owns in-memory jobs. `doctor.start`, `doctor.read`, and `doctor.cancel` expose
structured, validated reports. `/doctor` uses these through its protected terminal controller.
Readiness and live verification are distinguished on every finding. No automatic repair occurs.

Offline account inspection uses a non-refreshing Pi runtime and read-only credential store. It
never verifies credentials remotely. Live model probes make one bounded synthetic request using
the selected account/model and write normal usage events on a separate diagnostic run.

Tool providers may attach `diagnostics(context)` to their existing callable function. Each check
supplies readiness inspection and optionally a declared live probe. `WorldPart` forwards the same
metadata through the existing provider. Remote registrations declare checks and optional single-tool
probe recipes; `tools.diagnose` returns readiness data, and probe recipes invoke registered tools
through the normal gate. Providers without diagnostics remain unverified.

Live tool probes intersect requested and current capabilities, pass the existing scope/authorization
gate, and never satisfy a required separate per-call approval through batch confirmation. Such calls
report blocked. MCP diagnostics connect/list only. Browser diagnostics use a disposable launch and
offline synthetic page; configured CDP attachment is blocked. Computer interaction remains blocked
when a host cannot provide a disposable test surface.

## Alternatives
Keep separate status screens (no unified evidence); make every check live (costs and side effects by
default); add an eighth host surface (unnecessary alongside tool providers); infer health from
registration (insufficient evidence).

## Consequences
Public API and protocol gain job methods and report schemas; provider callbacks remain optional.
Jobs retain partial findings, support cancellation, and are cleared at shutdown. Existing runs and
stored settings need no migration. Live diagnostics retain real run records and usage; reports
contain redacted summaries and no raw tool payloads.

## Migration
None. Existing provider functions remain valid. This change does not relocate tool backends.
The in-progress World/browser implementation's documentation mismatch is recorded as known drift.

## Checks
Focused service, browser, terminal-page, scope/gate, protocol and host-adapter tests; Harness
`typecheck`, `test`, `prove`; App `typecheck`, `test`, `check:layers`, `check:ui`, and Rust tests.
Real provider or interaction probes require explicit consent and are not part of automated tests.
