# Arm 07 — Governance

Status: **core three audited** (opencode, omp, dsh) + swe-agent blocklists,
smolagents executor posture; claude-code/openhands pending.

## Design space

Who may call what, expressed how (per-call gate, tier×policy, event pipeline,
modes), approval UX (`ask` as outcome), fallback behavior (fail-closed or not),
trust for loaded code, secret/account isolation.

## Comparison

**this harness (contracts).** Per-call gate as the final extension; standing
approvals; single-use operation approvals in the app scope; account pinning
and redaction; tree plugins load only when their exact code is trusted
(`src/tree/trust.ts`).

**opencode — effect assertions with a wildcard ladder.** Rules: `allow|deny|ask`
literals, `findLast` wildcard resource match, default ask; agent rules and
session-level rules merge; a missing agent rule means deny-all
(`.../core/src/permission.ts:87-97,158-172`); user-saved "always allow"
(`:148-155`); catalog filtering only for wildcard-deny leaves
(`.../tool.ts:233,293-296`). Plugins may reject calls via `execute.before`
(`.../packages/plugin/src/effect/tool.ts:20-52`) — handy, but note the gate
stays the execution boundary's last authority only if core retains its own
assert.

**omp — declared tiers and modes.** `ToolTier = read|write|exec` per tool
(exec default when unclaimed), per-tool policy `allow|deny|prompt`, modes
`always-ask | write | yolo`; **missing context fails closed to always-ask**
(`.../tools/approval.ts:17-18,53-84,100,1226-1230`). Extension hooks wrap every
call (`extensibility/hooks/tool-wrapper.ts`).

**dsh — pipeline events, not a package.** Gate inside dsh-tools:
`tools/pre-execute` (allow/deny/ask) → monotonic guard() reasons → execute →
post-execute → result (observe-only)
(`.../packages/core/tools/README.md:89,109`; ask at `.../index.ts:608-612`).
Bundle base ships a default policy confining file writes and asking before
risky actions (`.../bundle/base/README.md:50`). OS sandbox separately:
file-effect policy classes with Landlock/Seatbelt/Windows backends and one-time
approved escalation (`.../packages/sandbox/README.md:12,30`).

**swe-agent.** Governance = curation: blocklist files in bundles
(`external/swe-agent/tools` listing); the environment's own command filter
(pending detail).

**smolagents.** Almost none in-source; the free executor (interception-based
local or paid remote) carries the risk — the anti-reference for our no-code-actions stance.

**claude-code (pending).** Permission modes + allow/deny rules + hooks.

## Trade-offs

- **Declarative vs hook-composed.** A user wanting "always allow reads, ask on
  writes" gets legibility from omp's tables; a plugin author gets power from
  opencode's before-hooks. Our per-call gate can host both: tiers inform, hooks
  advise, gate decides.
- **Fail-closed culture.** omp fails closed on missing policy; opencode defaults
  ask; dsh asks by bundle default. Convergent good posture — record as a
  shared norm, and keep our own default equally closed.
- **Escalations are one-time, auditable.** dsh's one-time approved sandbox
  escalation and our single-use approvals express the same idea; forcing a
  person to re-re-approve persistent bypasses is the safer curve.

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| G1 | Tier-per-tool declarations inform standing-approval wording (reads bulk-allowed, writes asked) | omp | ToolPolicy documents + default policy | T1 |
| G2 | Codify "policy missing ⇒ ask" as an invariant test | omp fail-closed | src tests around the gate | T1 |
