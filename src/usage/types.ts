// What `/usage:analysis` shows: token, cost and latency totals read from the derived usage ledger.
// One record answers one question about one scope and period; no raw run events reach a surface.

/** Whose usage is counted. The terminal resolves the ids, never the client. */
export type UsageScope = 'session' | 'account' | 'project' | 'all'

export type UsagePeriod = 'today' | '7d' | '30d' | 'all'

export interface UsageTotals {
  requests: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Reported and estimated cost; null when nothing could be priced. */
  costUsd: number | null
  /** The part of `costUsd` that came from list rates, not from the provider. */
  estimatedCostUsd: number
  /** Requests no provider priced and no catalogue rate could price. */
  unpricedRequests: number
  avgTtftMs: number | null
  avgDurationMs: number | null
  /** Cache reads as a share of all input tokens; null without input. */
  cacheHitPercent: number | null
}

export interface UsageRow extends UsageTotals {
  key: string
  label: string
  detail: string | null
}

export interface UsageDay {
  day: string
  requests: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number | null
}

export interface UsageSummary {
  scope: UsageScope
  period: UsagePeriod
  /** The first instant counted, or null when everything is. */
  from: string | null
  to: string
  timezoneOffsetMinutes: number
  generatedAt: string
  totals: UsageTotals
  byDay: UsageDay[]
  byModel: UsageRow[]
  byProvider: UsageRow[]
  byAccount: UsageRow[]
  bySession: UsageRow[]
  /** At least one breakdown stopped at its row cap. */
  truncated: boolean
  lastIndexedAt: string | null
}

/** The filter a scope resolves to, after the service looks up the ids it was asked for. */
export interface UsageFilter {
  session: string | null
  account: string | null
  project: string | null
}

export const USAGE_PERIODS: readonly UsagePeriod[] = ['today', '7d', '30d', 'all']
export const USAGE_SCOPES: readonly UsageScope[] = ['session', 'account', 'project', 'all']
