---
id: PROP-0044
title: Raise the work-slice defaults to 320 tool calls and 60 minutes, with no token cap
status: Accepted
created: 2026-10-26
updated: 2026-10-26
affects: [INV-RUN-13, 02-sessions-and-runs.md, 10-server-protocol.md, 11-terminal.md, PROP-0041]
---

# PROP-0044: Raise the work-slice defaults to 320 tool calls and 60 minutes, with no token cap

## Problem

`DEFAULT_SLICE_POLICY` (`src/sessions/workSlice.ts`) and `INV-RUN-13` set 160 tool calls, 40 minutes
and 320 000 new tokens, whichever comes first. Two of those defaults are wrong for ordinary work.

- **The token cap is the earliest limit, and it is not the bound it claims to be.** Its own comment
  called 320 000 "a safety net, not the bound", yet it counts new input, cache writes and output, so a
  few large reads in a big context cross it before the work is done. The "Confirm plan model support"
  thread counted 76 807 new tokens after four requests, and `workSlice.test.ts` still carried a case
  asserting a 320k stop. A cap that fires on reading is a false stop, and the stall rules — not the
  token count — are what detect an unbounded reply.
- **40 minutes is tighter than the field and tighter than the evidence.** The measured failure in
  STUDY-0003 was a reply that ran 114 minutes with no text and 448 calls, not one that ran 40 minutes.
  OpenHands allows 500 agent steps per run by default; Claude's Agent SDK has no default `maxTurns`;
  Cursor documents no tool-call limit; SWE-agent's caps are benchmark stops ($3, 1800 s) that
  auto-submit and exit. A checkpoint every 40 minutes turns one healthy task into a series of runs
  without a measured benefit.

The rule stays: a reply is bounded and hands off. What changes is where the boundary sits.

## Affected rules

- **INV-RUN-13** says: "The foundation defaults are 160 tool calls, 40 minutes and 320 000 new tokens,
  whichever comes first." The invariant's requirement — a bounded reply, a handoff at the limit and a
  continuation — is unchanged; its stated numbers and the default token cap change.
- **PROP-0041** §1 states the same numbers and §Consequences says "a checkpoint every ≤ 40 minutes";
  both are corrected to point here.

## Proposal

`DEFAULT_SLICE_POLICY` becomes:

| Setting | Was | Now |
|---|---|---|
| `maxToolCalls` | 160 | **320** |
| `maxMinutes` | 40 | **60** |
| `maxNewTokens` | 320 000 | **0** (no cap) |
| `maxSlices` | 8 | 8 (unchanged) |
| `continue` | true | true (unchanged) |

- Calls and the clock are the bound, whichever comes first: about 80 minutes of ordinary work at 15 s a
  call, with 60 minutes as the ceiling.
- A token cap stays available to whoever wants a cost ceiling: `workSlice.maxNewTokens` per run, still
  counted on new input, cache writes and output and never on the cached prefix.
- Nothing else changes: the refusal and `checkpoint_write`, the exemption for a handoff call, the
  stall rules and their per-reply reset, the terminal's behaviour, and automatic continuation.

## Alternatives

- **Do nothing.** Rejected: the token cap was the first limit a large read crossed, and its stop is
  visible to the person as an arbitrary end of a useful reply.
- **Keep a 320 000 safety net and raise only the calls and the clock.** Rejected: the same false stop
  stays, and two limits that are never reached in ordinary work are enough.
- **Turn the guard off by default.** Rejected for now: the stall rules are the evidence-backed part
  (repeated identical calls, repeated failures, edit churn, compaction thrash), and the budget itself
  is what bounds a reply. Only its size changes.
- **Bound cost in dollars instead of tokens.** Not adopted here: the harness records cost per request,
  but a dollar ceiling belongs with the account's usage limits (`usage/limits`, PROP-0042), not with a
  reply's work slice.

## Consequences

- A healthy task reaches its first checkpoint after roughly 80 minutes of ordinary work instead of 40,
  and no token count ends a reply on its own. The longest a task runs unattended is still eight slices,
  so the slice cap now allows up to about eight hours instead of about five.
- With no token cap, only calls and time bound an expensive reply; a person who wants a token ceiling
  sets one, and the heartbeat still reports `steps` against `maxToolCalls`.
- No stored-data, protocol or event change: an absent `workSlice` simply resolves to the new defaults,
  and a run already recorded keeps the policy it ran under.

## Migration

None. Undo by restoring the three values in `DEFAULT_SLICE_POLICY`, or by passing `workSlice` on
`sessions.run`. A continuation inherits the policy as it always did.

## Checks

- `npx vitest run src/sessions/workSlice.test.ts src/sessions/sessions.test.ts` (the defaults
  assertion and the limit-selection test change with the values; the token-cap test keeps an explicit
  override)
- `npm run typecheck`, `npm test`, `npm run prove`
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, `cd src-tauri && cargo test`
