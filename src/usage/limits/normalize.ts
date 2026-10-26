// Provider headers, normalised into limit readings. Four families are understood: Anthropic's
// per-resource limits, its unified plan windows, Codex-style plan windows, and the common
// `x-ratelimit-*` headers. Unknown headers are ignored, never guessed at.
import type { Limit } from '../../accounts/store'
import type { ProviderResponseLike } from './types'

const headersOf = (input: Record<string, string>): Map<string, string> => {
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) map.set(key.toLowerCase(), value.trim())
  }
  return map
}

export function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const cleaned = value.replace(/[%,\s]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

/** A reset time as an ISO instant: epoch seconds or milliseconds, a duration, or a date string. */
export function toIso(value: string | undefined, now: Date): string | null {
  if (!value) return null
  const text = value.trim()
  const duration = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i.exec(text)
  if (duration && text.match(/[a-z]/i)) {
    const [, d, h, m, s, ms] = duration
    const total = Number(d ?? 0) * 86_400_000 + Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1_000 + Number(ms ?? 0)
    if (Number.isFinite(total) && total > 0) return new Date(now.getTime() + total).toISOString()
  }
  const numeric = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN
  if (Number.isFinite(numeric)) {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1_000
    const date = new Date(millis)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

const leftPercent = (usedPercent: number | null): number | null =>
  usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent))

const statusFor = (percent: number | null, fallback = 'allowed'): string =>
  percent === null ? fallback : percent >= 100 ? 'rejected' : percent >= 80 ? 'warning' : 'allowed'

function entry(limit: Omit<Limit, 'provider' | 'observedAt'> & { provider: string }, observedAt: string): Limit {
  return { ...limit, provider: limit.provider, observedAt }
}

/** The four well-known families, with their labels and units. */
const ANTHROPIC_FAMILIES = [
  { key: 'requests', label: 'Requests', unit: 'requests' as const },
  { key: 'input-tokens', label: 'Input tokens', unit: 'tokens' as const },
  { key: 'output-tokens', label: 'Output tokens', unit: 'tokens' as const }
]

const RATE_FAMILIES = ['requests', 'tokens', 'input-tokens', 'output-tokens', 'tokens-per-minute'] as const

const title = (value: string): string => value.split(/[-_]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

export interface NormalizedHeaders {
  limits: Limit[]
}

/**
 * Reads every limit family present in one provider response. `provider` is the Pi provider id;
 * the returned ids are namespaced with it so two providers never overwrite each other.
 */
export function normalizeHeaders(provider: string, response: ProviderResponseLike, now = new Date()): NormalizedHeaders {
  const headers = headersOf(response.headers)
  const observedAt = now.toISOString()
  const limits = new Map<string, Limit>()
  const put = (limit: Limit): void => { limits.set(limit.id, limit) }

  // Anthropic's per-resource rate limits.
  for (const family of ANTHROPIC_FAMILIES) {
    const prefix = `anthropic-ratelimit-${family.key}-`
    const limit = toNumber(headers.get(`${prefix}limit`))
    const remaining = toNumber(headers.get(`${prefix}remaining`))
    const resetsAt = toIso(headers.get(`${prefix}reset`), now)
    if (limit === null && remaining === null && !resetsAt) continue
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null
    const usedPercent = limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null
    put(entry({
      id: `${provider}:${family.key}`,
      label: family.label,
      provider,
      kind: 'rate',
      unit: family.unit,
      used,
      limit,
      remaining,
      usedPercent,
      remainingPercent: leftPercent(usedPercent),
      resetsAt,
      status: statusFor(usedPercent),
      source: 'headers'
    }, observedAt))
  }

  // Anthropic's unified window headers for subscription plans.
  const unified = new Map<string, { utilization?: string; reset?: string; status?: string }>()
  for (const [key, value] of headers) {
    const match = /^anthropic-ratelimit-unified-(.+?)-(utilization|reset|status)$/.exec(key)
    if (!match) continue
    const window = match[1]!
    const bucket = unified.get(window) ?? {}
    bucket[match[2] as 'utilization' | 'reset' | 'status'] = value
    unified.set(window, bucket)
  }
  const unifiedStatus = headers.get('anthropic-ratelimit-unified-status')
  for (const [window, bucket] of unified) {
    const raw = toNumber(bucket.utilization)
    const usedPercent = raw === null ? null : raw <= 1.5 ? raw * 100 : raw
    const id = `${provider}:window-${window}`
    put(entry({
      id,
      label: window === '5h' ? '5-hour window' : window === '7d' ? 'Weekly window' : window === 'primary' ? 'Primary window' : window === 'secondary' ? 'Secondary window' : `${title(window)} window`,
      provider,
      kind: 'window',
      unit: 'percent',
      usedPercent,
      remainingPercent: leftPercent(usedPercent),
      resetsAt: toIso(bucket.reset, now),
      status: bucket.status ?? (unifiedStatus === 'rejected' ? 'rejected' : statusFor(usedPercent)),
      source: 'headers'
    }, observedAt))
  }

  // Codex-style plan windows.
  for (const window of ['primary', 'secondary'] as const) {
    const percent = toNumber(headers.get(`x-codex-${window}-used-percent`))
    const windowMinutes = toNumber(headers.get(`x-codex-${window}-window-minutes`))
    const resetsAt = toIso(headers.get(`x-codex-${window}-reset-at`) ?? headers.get(`x-codex-${window}-reset`), now)
    if (percent === null && !resetsAt) continue
    put(entry({
      id: `${provider}:codex-${window}`,
      label: `${title(window)} window`,
      provider,
      kind: 'window',
      unit: 'percent',
      usedPercent: percent,
      remainingPercent: leftPercent(percent),
      windowMinutes,
      resetsAt,
      status: statusFor(percent),
      source: 'headers'
    }, observedAt))
  }

  // The common x-ratelimit-* headers.
  const families = new Map<string, { limit?: string; remaining?: string; reset?: string }>()
  for (const [key, value] of headers) {
    const match = /^x-ratelimit-(limit|remaining|reset)-(.+)$/.exec(key)
    if (!match) continue
    const bucket = families.get(match[2]!) ?? {}
    bucket[match[1] as 'limit' | 'remaining' | 'reset'] = value
    families.set(match[2]!, bucket)
  }
  for (const [family, bucket] of families) {
    if (!(RATE_FAMILIES as readonly string[]).includes(family)) continue
    const limit = toNumber(bucket.limit)
    const remaining = toNumber(bucket.remaining)
    const resetsAt = toIso(bucket.reset, now)
    if (limit === null && remaining === null && !resetsAt) continue
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null
    const usedPercent = limit !== null && limit > 0 && used !== null ? (used / limit) * 100 : null
    put(entry({
      id: `${provider}:rate-${family}`,
      label: `${title(family)} (rate)`,
      provider,
      kind: 'rate',
      unit: family.includes('token') ? 'tokens' : 'requests',
      used,
      limit,
      remaining,
      usedPercent,
      remainingPercent: leftPercent(usedPercent),
      resetsAt,
      status: statusFor(usedPercent),
      source: 'headers'
    }, observedAt))
  }

  // A 429's retry hint, when the provider sent nothing richer.
  if (response.status === 429 && !limits.size) {
    const retry = headers.get('retry-after')
    // `Retry-After` is a delay in seconds or an HTTP date, not an epoch instant.
    const resetsAt = retry && /^\d+(?:\.\d+)?$/.test(retry.trim())
      ? new Date(now.getTime() + Number(retry) * 1_000).toISOString()
      : toIso(retry, now)
    if (resetsAt) {
      put(entry({
        id: `${provider}:retry`,
        label: 'Rate limited',
        provider,
        kind: 'error',
        unit: 'percent',
        status: 'rejected',
        resetsAt,
        source: 'headers'
      }, observedAt))
    }
  }

  return { limits: [...limits.values()] }
}

/** Only the limit-bearing headers, bounded, so a child process never relays an entire response. */
export function limitHeaders(input: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase()
    if (!/^(anthropic-ratelimit-|x-codex-|x-ratelimit-|retry-after$)/.test(name)) continue
    if (typeof value !== 'string' || !value.trim()) continue
    kept[name] = value.trim().slice(0, 200)
    if (++count >= 40) break
  }
  return kept
}
