---
id: ADR-0003
title: Shared asynchronous subagents with native-history delivery receipts
status: accepted
created: 2026-10-18
updated: 2026-10-18
supersedes: ADR-0002
---
# ADR-0003 — Shared asynchronous subagents with native-history delivery receipts

## Context and decision

The owner selected reliable delivery, asynchronous spawn/wait, and one SDK/terminal/App API after
studying OMP. They chose attached children joined before the parent finishes, async spawning by
default, availability for every interactive caller within its capability ceiling, and recovery
only when the user explicitly resumes. This supersedes the blocking tool contract in ADR-0002.

`harness.subagents` owns spawning, selective waits and results. SDK and terminal adapters register
live, frozen parent context with it; no model argument supplies caller, account or replacement
launch metadata. The terminal adapter uses its private control key. Children use normal Harness
sessions, isolated accounts, fresh history, existing gates and capability intersection. The old
`sessions.spawnSubagent` entry point forwards to the service for compatibility.

A parent reserves each child in `runs/<parent>/subagents.json` through the run store before startup.
A native branch owner marker is persisted before a real parent accepts spawns. Results are delivered
at turn boundaries or through explicit blocking tools. Native messages and tool results carry typed
receipts; only receipts on the selected branch acknowledge delivery. Constructing a delivery draft
never acknowledges it. Large batches acknowledge only the included children. The final settlement
hook joins children and injects remaining results; an adapter verification guard refuses successful
completion if persisted native history still lacks a result. The stable system prefix is unchanged.

On explicit resume, matching owner markers, caller/account/folder/native identity and run lineage
restore undelivered results. A startup reservation that never opened becomes an interrupted run.
Existing startup recovery interrupts orphaned active runs. Neither recovery path restarts model
work. Cancellation settles approvals and questions before waiting for SDK abort, preventing blocked
child interactions from deadlocking parent shutdown.

Interactive sessions enable the tools by default, `null` disables them, and explicit capability
sets can exclude them. Unattended callers remain off unless the host explicitly enables them.
Default nesting remains one, with a maximum of three. There is no new scheduler, reusable-worker
lifecycle, model routing, workspace isolation system, concurrency cap or family budget here.

## Alternatives and consequences

A tool-owned launcher leaves terminal and SDK behavior divergent. An in-memory delivery flag loses
results across restart; searching prose for run IDs confuses mentions with delivery. Native-history
receipts identify persisted context without adding a second acknowledgement store. Run records
remain the outcome source of truth, while the parent file preserves startup reservations.

The App owns organization delegation and resolves native ancestry for thread routing, tools,
isolation and connections. Its existing work-budget accounting includes native descendants. Harness
learns no organizational role or application concept. Native completion records execution outcome;
it does not certify the child's findings or artifacts.

## Evidence and limits

`subagentService.test.ts` covers selective waits, foreign handles, cancellation, bounded batches and
recovery windows. Real scripted Pi tests in `conversation.test.ts` cover async delivery, inline
receipts and interruption during a child question. `runtime.socket.test.ts` exercises the real
terminal socket, private controls, native execution and child decision routing. RPC and App host
regressions cover protocol shapes and ancestry. Tests use disposable storage without external
model requests. These are working-tree changes, not a publication or live-provider acceptance claim.
