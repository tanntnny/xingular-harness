# Arm 09 — Observability

Status: **core three audited** (opencode, omp, dsh) + swe-agent trajectories;
hands pending.

## Design space

What is recorded (events, trajectories, usage), validation of records, who may
write run records, live relay to interfaces, retention/redaction, and cost
accounting granularity.

## Comparison

**this harness (contracts).** Validated run events saved per run by the only
writer (`sessions/runStore.ts`); `usage.updated` cumulative per run with the
uncached-input / cache-read / cache-write split; app relays to UI.

**opencode.** "event-logger.ts listens on the event bus and logs only
allow-listed config-type events (agent/provider/model/command/config updated),
as a global node" (`.../core/src/event-logger.ts:10-19`). Usage published as
`SessionEvent.UsageRecorded` from the compaction anchor
(`.../session/compaction.ts:632-639`); trajectory surface lives in session-ui
and the TUI (packages listing).

**omp.** `omp stats` — local web dashboard with live ingest (port 3847)
covering AI usage, with per-session ledgers available
(`packages/stats/README.md:3,9,31-35`); `wire` package supplies transport;
judgment roles record usage too (`.../judgment/index.ts:6-10`).

**dsh.** Telemetry is an OTel transport only — "business consumers own events,
identities, redaction"; feedback-authorized upload, default `FEEDBACK_ONLY`
(`.../packages/telemetry/README.md:12,25`; `.../bundle/base/README.md:50`).
Business events flow through the session event stream.

**swe-agent.** trajectory JSON per run + a separate inspector to browse them
(`external/swe-agent/trajectories`, `sweagent/inspector/`).

**smolagents.** `monitoring.py` metrics + `AgentLogger` markdown logs; gradio UI.

## Trade-offs

- **Where transport ends.** The dsh rule — a transport package knows nothing
  about business events — is the cleanest boundary. Our runStore already
  *is* the business schema; be careful that nothing in run records assumes an
  application consumer (they don't: read-only records).
- **Local dashboards vs relay.** omp's stats serves a self-hosted view; ours
  hands validated events to a UI. Same functionality, different home; nothing
  to adopt; the one check if we ever add an export path: no
  duplicate charges on relaunch (event ids dedupe).
- **Cost accounting alignment.** Everyone anchors usage at the latest provider
  response and estimates lagging items (opencode anchor pattern at
  `compaction.ts:812-842`). Ours does the same via usage.updated — align
  definitions (reasoning inside output) with any upstream comparisons to
  prevent double-cost surface.

## Adoption candidates

| # | Idea | From | Land as | Tier |
|---|---|---|---|---|
| O1 | A "transport owns nothing about identities" doc commitment when any telemetry-like export exists (apps may add; harness stays identity-blind) | dsh telemetry | a para note in repo README | T1 doc |
