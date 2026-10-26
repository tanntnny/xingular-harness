// The usage ledger: one derived row per model request, read from a run's recorded `usage.updated`
// events. Runs and their events stay canonical; the ledger can always be deleted and rebuilt.
import type { DatabaseSync } from 'node:sqlite'

import { all, run as execute, transaction, withIndex } from '../core/index'
import { now } from '../core/fs'
import { readAllRuns } from '../sessions/runIndex'
import { findRun, readEvents } from '../sessions/runStore'
import { usagePayloadSchema, type RunEvent, type RunRecord, type UsagePayload } from '../sessions/contracts'

export interface UsageRow {
  runId: string
  sequence: number
  requestIndex: number
  at: string
  day: string
  accountId: string | null
  projectId: string | null
  sessionId: string
  agentId: string | null
  mode: string
  trigger: string | null
  provider: string | null
  model: string | null
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number | null
  costSource: string | null
  contextTokens: number | null
  contextWindow: number | null
  durationMs: number | null
  ttftMs: number | null
  requests: number
}

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const optionalNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** One row per request: the event's own `request`, or the run's totals when a provider reported only those. */
export function usageRowsFor(run: RunRecord, events: readonly RunEvent[]): UsageRow[] {
  const rows: UsageRow[] = []
  let lastTotals: UsagePayload | null = null
  let lastTotalsAt: string | null = null
  for (const event of events) {
    if (event.type !== 'usage.updated') continue
    const parsed = usagePayloadSchema.safeParse(event.payload)
    if (!parsed.success) continue
    const payload = parsed.data
    lastTotals = payload
    lastTotalsAt = event.timestamp
    const request = payload.request
    // Without a per-request update the event's fields are cumulative; only the last one may count.
    if (!request) continue
    rows.push({
      runId: run.id,
      sequence: event.sequence,
      requestIndex: request?.index ?? payload.requests ?? rows.length + 1,
      at: event.timestamp,
      day: event.timestamp.slice(0, 10),
      accountId: run.accountId ?? null,
      projectId: run.projectId ?? null,
      sessionId: run.sessionId,
      agentId: run.agentId ?? null,
      mode: run.mode ?? 'chat',
      trigger: run.trigger ?? null,
      provider: request?.provider ?? payload.provider ?? null,
      model: request?.model ?? payload.model ?? null,
      inputTokens: number(request?.inputTokens ?? payload.inputTokens),
      cacheReadTokens: number(request?.cacheReadTokens ?? payload.cacheReadTokens),
      cacheWriteTokens: number(request?.cacheWriteTokens ?? payload.cacheWriteTokens),
      outputTokens: number(request?.outputTokens ?? payload.outputTokens),
      reasoningTokens: number(request?.reasoningTokens ?? payload.reasoningTokens),
      costUsd: optionalNumber(request?.costUsd ?? payload.costUsd),
      costSource: text(request?.costSource ?? payload.costSource),
      contextTokens: optionalNumber(payload.contextTokens),
      contextWindow: optionalNumber(payload.contextWindow),
      durationMs: optionalNumber(request?.durationMs),
      ttftMs: optionalNumber(request?.ttftMs),
      requests: number(payload.requests)
    })
  }
  // A run whose provider reported totals but no per-request update (an older record) still counts once.
  if (!rows.length && lastTotals) {
    rows.push({
      runId: run.id, sequence: 0, requestIndex: lastTotals.requests ?? 1,
      at: lastTotalsAt ?? run.endedAt ?? run.startedAt, day: (lastTotalsAt ?? run.endedAt ?? run.startedAt).slice(0, 10),
      accountId: run.accountId ?? null, projectId: run.projectId ?? null, sessionId: run.sessionId,
      agentId: run.agentId ?? null, mode: run.mode ?? 'chat', trigger: run.trigger ?? null,
      provider: lastTotals.provider ?? null, model: lastTotals.model ?? null,
      inputTokens: number(lastTotals.inputTokens), cacheReadTokens: number(lastTotals.cacheReadTokens),
      cacheWriteTokens: number(lastTotals.cacheWriteTokens), outputTokens: number(lastTotals.outputTokens),
      reasoningTokens: number(lastTotals.reasoningTokens), costUsd: optionalNumber(lastTotals.costUsd),
      costSource: text(lastTotals.costSource), contextTokens: optionalNumber(lastTotals.contextTokens),
      contextWindow: optionalNumber(lastTotals.contextWindow), durationMs: null, ttftMs: null,
      requests: number(lastTotals.requests)
    })
  }
  return rows
}

function write(database: DatabaseSync, run: RunRecord, rows: readonly UsageRow[]): void {
  execute(database, 'DELETE FROM usage_requests WHERE run_id = ?', run.id)
  for (const row of rows) {
    execute(
      database,
      `INSERT INTO usage_requests (run_id, sequence, request_index, at, day, account_id, project_id, session_id, agent_id, mode, trigger,
         provider, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
         cost_usd, cost_source, context_tokens, context_window, duration_ms, ttft_ms, requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.runId, row.sequence, row.requestIndex, row.at, row.day, row.accountId, row.projectId, row.sessionId,
      row.agentId, row.mode, row.trigger, row.provider, row.model, row.inputTokens, row.cacheReadTokens,
      row.cacheWriteTokens, row.outputTokens, row.reasoningTokens, row.costUsd, row.costSource,
      row.contextTokens, row.contextWindow, row.durationMs, row.ttftMs, row.requests
    )
  }
  execute(database, 'INSERT OR REPLACE INTO usage_indexed (run_id, indexed_at, rows) VALUES (?, ?, ?)', run.id, now(), rows.length)
}

/** Indexes one run's usage. Idempotent, and safe to call when the index is unavailable. */
export function indexRunUsage(root: string, runId: string): boolean {
  const run = findRun(root, runId)
  if (!run) return false
  let events: RunEvent[]
  try {
    events = readEvents(root, runId)
  } catch {
    return false
  }
  const rows = usageRowsFor(run, events)
  try {
    withIndex(root, (database) => transaction(database, () => write(database, run, rows)))
    return true
  } catch {
    return false
  }
}

/** Indexes every run the ledger has not seen yet. Returns how many runs it added. */
export function syncUsage(root: string): number {
  const indexed = new Set<string>()
  try {
    withIndex(root, (database) => {
      for (const row of all<{ run_id: string }>(database, 'SELECT run_id FROM usage_indexed')) indexed.add(row.run_id)
    })
  } catch {
    return 0
  }
  let added = 0
  for (const record of readAllRuns(root)) {
    if (indexed.has(record.id)) continue
    if (indexRunUsage(root, record.id)) added += 1
  }
  return added
}

/** The ledger's last write, or null when it holds nothing. */
export function lastIndexedAt(root: string): string | null {
  try {
    return withIndex(root, (database) =>
      all<{ at: string | null }>(database, 'SELECT MAX(indexed_at) AS at FROM usage_indexed')[0]?.at ?? null)
  } catch {
    return null
  }
}

/** Run ids the ledger knows, for diagnostics and tests. */
export function indexedRuns(root: string): string[] {
  try {
    return withIndex(root, (database) => all<{ run_id: string }>(database, 'SELECT run_id FROM usage_indexed').map((row) => row.run_id))
  } catch {
    return []
  }
}
