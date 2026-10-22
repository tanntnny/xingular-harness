---
id: PROP-0010
title: Agent-managed native session names
status: Implemented
created: 2026-10-22
updated: 2026-10-22
affects: [02-sessions-and-runs.md, 04-prompt.md, 07-tools-and-gate.md, 11-terminal.md]
---

# PROP-0010: Agent-managed native session names

## Problem
Agents cannot currently name their sessions. Pi already stores a native session name,
and the terminal exposes manual `/name`, but the working line does not show the name.

## Affected rules
INV-PRM-2: "Changing state never enters" the stable system prompt.
INV-GATE-1: "Every tool call of every run passes the gate."
INV-TUI-2: "Pi owns the execution runtime, native history and rich content components."
The tool inventory and plan-safe metadata operations gain `session_name`.

## Proposal
Provide `session_name({ name: string })` in terminal and embedded Harness sessions,
subject to capabilities and the normal gate. Name meaningful work early; revise when its
overall objective changes, including a manually assigned name. Greetings need no name.
Agent names are short imperative sentences, at most six whitespace-separated words.
Normalize whitespace; reject blank names, non-whitespace control characters and terminal
escapes, or more than six words. Identical names do not append another history entry.
Plan mode permits naming as session metadata maintenance. Disabled Harness tools and host
restrictions continue to apply. Each session, including a child, names only itself.
Pi's native session-info entries are the sole persistence mechanism. No separate model
request, new run-event schema, or new host RPC is introduced. The terminal renders
` – <name>` after metrics on the active and retained completion line, outside the verb's
shimmer, and truncates at the terminal edge. Current names never enter the stable prompt.

## Alternatives
Do nothing leaves sessions unnamed. A separate title-generation model request adds latency
and token cost. A Harness side file duplicates Pi's existing authoritative metadata.

## Consequences
The foundation gains a tool and stable naming guidance. Manual names remain unrestricted;
agent-submitted names follow the six-word limit. Model compliance determines whether and
when the tool is called. An embedding host need not change its UI or protocol.

## Migration
None. Existing native histories and manual names remain valid; names survive reopen and
continuation through Pi. Removing the tool leaves stored names readable.

## Checks
Unit and integration tests cover validation, both execution paths, policy, capability and
plan handling, persistence, isolation and working-line rendering. Run Harness typecheck,
tests and standalone proof, plus the App compatibility checks.

## Review
The user selected all Harness sessions, agent revisions of manual names, and early naming
with objective-change revisions, then approved implementation of the presented plan.

## Implementation and verification
Implemented in the working tree; see
[ADR-0012](../../decisions/ADR-0012-native-session-names.md).

- Harness full suite: 825 passed, 3 skipped; subsequent affected suites passed after the
  final prompt-availability and narrow-line corrections (151 passed, 2 skipped; then 36
  display/application tests passed). Harness typecheck and the final bundle build passed.
- Standalone startup proof passed. A real Pi SDK / OpenTUI PTY against a loopback provider
  completed two naming calls at both 80 and 40 columns. Screen parsing verified the full
  name at 80 columns and right-side name truncation with intact metrics at 40 columns.
  Fixtures used disposable account/history folders and no external model or user credentials.
- App typecheck, UI check, and Rust tests passed (240 passed, 1 ignored). App frontend tests
  reported unrelated guide-link/heading failures and a streaming performance threshold.
  The sidecar suite reported existing tree-to-variant API/import mismatches; layer checks
  reported browser/doctor tool-name violations. These checks are not an all-clear for the
  App workspace, and no App source was changed for this feature.
