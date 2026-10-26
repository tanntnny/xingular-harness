// The questions `/usage:analysis` asks of the ledger, answered in SQL. One scope, one period, a
// fixed set of breakdowns; every list is capped so a page never waits on an unbounded query.
import type { DatabaseSync } from 'node:sqlite'

import { all, withIndex, type Param } from '../core/index'
import { costAt, type PriceRates } from '../sessions/pricing'
import { lastIndexedAt } from './ledger'
import type { UsageDay, UsageFilter, UsagePeriod, UsageRow, UsageSummary, UsageTotals } from './types'

/** A price lookup, injected so tests never load Pi's catalogue. */
export type RatesLookup = (provider: string, model: string) => Promise<PriceRates | null>

const ROW_LIMIT = 10
const DAY_LIMIT = 400
const UNPRICED_LIMIT = 40

interface Summed {
  requests: number | null
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
  cost: number | null
  unpriced: number | null
  ttft: number | null
  duration: number | null
}

const zero = (value: number | null | undefined): number => value ?? 0
const round = (value: number, places = 6): number => Math.round(value * 10 ** places) / 10 ** places

function totals(row: Summed | undefined, estimated = 0): UsageTotals {
  const input = zero(row?.input)
  const cacheRead = zero(row?.cacheRead)
  const cacheWrite = zero(row?.cacheWrite)
  const cost = row?.cost == null && !estimated ? null : round(zero(row?.cost) + estimated)
  const cached = cacheRead + input + cacheWrite
  return {
    requests: zero(row?.requests),
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: zero(row?.output),
    reasoningTokens: zero(row?.reasoning),
    costUsd: cost,
    estimatedCostUsd: estimated ? round(estimated) : 0,
    unpricedRequests: zero(row?.unpriced),
    avgTtftMs: row?.ttft == null ? null : Math.round(row.ttft),
    avgDurationMs: row?.duration == null ? null : Math.round(row.duration),
    cacheHitPercent: cached ? Math.round((cacheRead / cached) * 1000) / 10 : null
  }
}

/** The local-day boundaries `period` covers, expressed as UTC instants. */
export function periodRange(period: UsagePeriod, offsetMinutes: number, now = new Date()): { from: string | null; to: string } {
  const to = now.toISOString()
  if (period === 'all') return { from: null, to }
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000)
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  const days = period === 'today' ? 0 : period === '7d' ? 6 : 29
  return { from: new Date(midnight - days * 86_400_000 - offsetMinutes * 60_000).toISOString(), to }
}

function where(filter: UsageFilter, from: string | null, to: string): { sql: string; params: Param[] } {
  const clauses: string[] = ['at < ?']
  const params: Param[] = [to]
  if (from) {
    clauses.push('at >= ?')
    params.push(from)
  }
  if (filter.session) {
    clauses.push('session_id = ?')
    params.push(filter.session)
  }
  if (filter.account) {
    clauses.push('account_id = ?')
    params.push(filter.account)
  }
  if (filter.project) {
    clauses.push('project_id = ?')
    params.push(filter.project)
  }
  return { sql: clauses.join(' AND '), params }
}

const SUM = `COUNT(*) AS requests, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cacheRead,
  SUM(cache_write_tokens) AS cacheWrite, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning,
  SUM(cost_usd) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
  AVG(ttft_ms) AS ttft, AVG(duration_ms) AS duration`

function grouped(database: DatabaseSync, column: string, clause: string, params: Param[], limit: number): { key: string; values: Summed }[] {
  return all<{ key: string | null } & Summed>(
    database,
    `SELECT ${column} AS key, ${SUM} FROM usage_requests WHERE ${clause}
     GROUP BY ${column} ORDER BY SUM(COALESCE(input_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(output_tokens,0)) DESC
     LIMIT ${limit}`,
    ...params
  ).map((row) => ({ key: row.key ?? '', values: row }))
}

function modelKey(provider: string | null, model: string | null): string {
  return `${provider ?? 'unknown'}/${model ?? 'unknown'}`
}

/** Estimates the cost of the requests a provider did not price, grouped by model. */
async function estimate(
  database: DatabaseSync,
  clause: string,
  params: Param[],
  rates: RatesLookup
): Promise<Map<string, { cost: number; requests: number }>> {
  const rows = all<{ provider: string | null; model: string | null } & Summed>(
    database,
    `SELECT provider, model, ${SUM} FROM usage_requests
     WHERE ${clause} AND cost_usd IS NULL GROUP BY provider, model LIMIT ${UNPRICED_LIMIT}`,
    ...params
  )
  const estimates = new Map<string, { cost: number; requests: number }>()
  for (const row of rows) {
    if (!row.model) continue
    const table = await rates(row.provider ?? '', row.model).catch(() => null)
    if (!table) continue
    const cost = costAt(table, {
      inputTokens: zero(row.input),
      outputTokens: zero(row.output),
      cacheReadTokens: zero(row.cacheRead),
      cacheWriteTokens: zero(row.cacheWrite)
    })
    const key = modelKey(row.provider, row.model)
    const previous = estimates.get(key) ?? { cost: 0, requests: 0 }
    estimates.set(key, { cost: previous.cost + cost, requests: previous.requests + zero(row.requests) })
  }
  return estimates
}

export interface SummaryInput {
  root: string
  filter: UsageFilter
  period: UsagePeriod
  timezoneOffsetMinutes: number
  /** Model labels are `provider/model`; only accounts need a lookup. */
  accountLabel?: (accountId: string) => string
  rates?: RatesLookup
  now?: Date
}

export async function summarize(input: SummaryInput): Promise<UsageSummary> {
  const offset = Number.isFinite(input.timezoneOffsetMinutes) ? Math.max(-840, Math.min(840, Math.trunc(input.timezoneOffsetMinutes))) : 0
  const { from, to } = periodRange(input.period, offset, input.now ?? new Date())
  const { sql: clause, params } = where(input.filter, from, to)
  const shift = `${offset >= 0 ? '+' : ''}${offset} minutes`
  const label = input.accountLabel ?? ((id: string) => id.slice(0, 8))
  const summary = withIndex(input.root, (database) => {
    const total = all<Summed>(database, `SELECT ${SUM} FROM usage_requests WHERE ${clause}`, ...params)[0]
    const days = all<{ day: string } & Summed>(
      database,
      `SELECT date(at, ?) AS day, ${SUM} FROM usage_requests WHERE ${clause}
       GROUP BY day ORDER BY day DESC LIMIT ${DAY_LIMIT}`,
      shift,
      ...params
    )
    return {
      total,
      days: days.reverse(),
      byModel: grouped(database, "COALESCE(provider,'unknown') || '/' || COALESCE(model,'unknown')", clause, params, ROW_LIMIT + 1),
      byProvider: grouped(database, "COALESCE(provider,'unknown')", clause, params, ROW_LIMIT + 1),
      byAccount: grouped(database, "COALESCE(account_id,'')", clause, params, ROW_LIMIT + 1),
      bySession: grouped(database, 'session_id', clause, params, ROW_LIMIT + 1)
    }
  })
  const estimates = input.rates && zero(summary.total?.unpriced)
    ? await withIndex(input.root, (database) => estimate(database, clause, params, input.rates!))
    : new Map<string, { cost: number; requests: number }>()
  const estimated = [...estimates.values()].reduce((sum, entry) => sum + entry.cost, 0)
  const row = (key: string, values: Summed, labelText: string, detail: string | null): UsageRow => {
    const estimateEntry = estimates.get(key)
    return { key, label: labelText, detail, ...totals(values, estimateEntry?.cost ?? 0) }
  }
  const modelRows = summary.byModel.map((entry) => row(entry.key, entry.values, entry.key, null))
  const truncate = (entries: { key: string; values: Summed }[]): boolean => entries.length > ROW_LIMIT
  const accountRows = summary.byAccount.slice(0, ROW_LIMIT).map((entry) =>
    row(entry.key, entry.values, entry.key ? label(entry.key) : 'No account', null))
  const sessionRows = summary.bySession.slice(0, ROW_LIMIT).map((entry) => row(entry.key, entry.values, entry.key.slice(0, 12), null))
  const days: UsageDay[] = summary.days.map((entry) => ({
    day: entry.day,
    requests: zero(entry.requests),
    inputTokens: zero(entry.input),
    cacheReadTokens: zero(entry.cacheRead),
    outputTokens: zero(entry.output),
    costUsd: entry.cost == null ? null : round(entry.cost)
  }))
  return {
    scope: input.filter.session ? 'session' : input.filter.project ? 'project' : input.filter.account ? 'account' : 'all',
    period: input.period,
    from,
    to,
    timezoneOffsetMinutes: offset,
    generatedAt: new Date().toISOString(),
    totals: totals(summary.total, estimated),
    byDay: days,
    byModel: modelRows.slice(0, ROW_LIMIT),
    byProvider: summary.byProvider.slice(0, ROW_LIMIT).map((entry) => row(entry.key, entry.values, entry.key, null)),
    byAccount: accountRows,
    bySession: sessionRows,
    truncated: truncate(summary.byModel) || truncate(summary.byProvider) || truncate(summary.byAccount) || truncate(summary.bySession),
    lastIndexedAt: lastIndexedAt(input.root)
  }
}
