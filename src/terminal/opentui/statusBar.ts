import { displayProjectName, formatTokenCount, singleLine } from '../tui/status'

export interface StatusBarState {
  cwd: string
  branch: string | null
  account?: string
  model?: { name: string }
  thinking: string
  /** Session totals; input includes cache reads. */
  inputTokens: number
  outputTokens: number
  /** The cache over the most recent model requests, which the hit rate is judged on. */
  cache: CacheUsage
  /** `/remote-control`: on and waiting for a phone, or a phone connected. */
  remoteControl?: 'waiting' | 'connected' | null
}

/** Cache figures over a run of model requests; input includes cache reads. */
export interface CacheUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
}

/**
 * The hit rate covers this many recent requests. A session-wide rate hides a collapse: a long healthy
 * start keeps it high while every new request misses.
 */
export const CACHE_HIT_WINDOW = 10

interface UsageLike { input?: number; cacheRead?: number; cacheWrite?: number }

/**
 * Sums the cache usage of the last `limit` model responses in `messages`. Responses without prompt
 * tokens (aborted or failed before the provider answered) are not requests the cache could serve.
 */
export function recentCacheUsage(messages: readonly unknown[], limit = CACHE_HIT_WINDOW): CacheUsage {
  const totals: CacheUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  for (let index = messages.length - 1; index >= 0 && totals.requests < limit; index--) {
    const message = messages[index] as { role?: unknown; usage?: UsageLike } | null
    if (message?.role !== 'assistant' || !message.usage) continue
    const input = count(message.usage.input)
    const cacheRead = count(message.usage.cacheRead)
    if (input + cacheRead <= 0) continue
    totals.inputTokens += input + cacheRead
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += count(message.usage.cacheWrite)
    totals.requests++
  }
  return totals
}

/** A cache hit rate under these percentages is flagged in the status bar and reported by a notice. */
export const CACHE_HIT_WARNING_PERCENT = 70
export const CACHE_HIT_CRITICAL_PERCENT = 40
const CACHE_HIT_GLYPH = '⚠'

export type CacheHitLevel = 'ok' | 'warning' | 'critical'

export function cacheHitPercent(cacheReadTokens: number, inputTokens: number): number {
  const total = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0
  const reads = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0
  return total ? Math.round(Math.min(reads, total) / total * 100) : 0
}

/**
 * The level of a cache hit rate, judged on the rounded percentage the bar shows. A first response only
 * writes the cache, so a single request is not judged. Usage with neither reads nor writes is not
 * judged either: its provider may not report the cache at all.
 */
export function cacheHitLevel(cache: CacheUsage): CacheHitLevel {
  if (cache.requests < 2 || cache.inputTokens <= 0 || cache.cacheReadTokens + cache.cacheWriteTokens <= 0) return 'ok'
  const percent = cacheHitPercent(cache.cacheReadTokens, cache.inputTokens)
  if (percent < CACHE_HIT_CRITICAL_PERCENT) return 'critical'
  return percent < CACHE_HIT_WARNING_PERCENT ? 'warning' : 'ok'
}

export interface StatusBarPiece {
  text: string
  /** Set on a flagged cache hit rate; the bar draws that piece in the colour of its level. */
  cacheHit?: Exclude<CacheHitLevel, 'ok'>
}

/**
 * The composer status bar groups the working folder and branch as `project:branch`, followed by
 * account/model/effort and input/cache-rate/output tokens. Groups are joined with `|` and may wrap;
 * account, model, and effort are separated by spaces. `rc` follows while remote control is on, `rc ●`
 * once a phone is connected. Context use is not a band group; `/context` reads the share of the window.
 * The cache hit rate covers the last `CACHE_HIT_WINDOW` requests; below a threshold it gets a glyph after
 * its percentage and is marked for colour.
 */
export function statusBarPieces(state: StatusBarState): StatusBarPiece[] {
  const model = (singleLine(state.model?.name ?? '') || 'no model').replace(/^Claude /, '')
  const project = displayProjectName(state.cwd) || '—'
  const branch = singleLine(state.branch ?? '') || '—'
  const level = cacheHitLevel(state.cache)
  const rate = `R${cacheHitPercent(state.cache.cacheReadTokens, state.cache.inputTokens)}%`
  const cacheRate: StatusBarPiece = level === 'ok' ? { text: rate } : { text: `${rate} ${CACHE_HIT_GLYPH}`, cacheHit: level }
  const groups: StatusBarPiece[][] = [
    [{ text: `${project}:${branch}` }],
    [{ text: `${singleLine(state.account ?? '') || 'account unknown'} ${model} ${singleLine(state.thinking) || 'off'}` }],
    [{ text: `↑${formatTokenCount(state.inputTokens)} ` }, cacheRate, { text: ` ↓${formatTokenCount(state.outputTokens)}` }],
    state.remoteControl === 'connected' ? [{ text: 'rc ●' }] : state.remoteControl === 'waiting' ? [{ text: 'rc' }] : []
  ]
  return groups
    .filter(group => group.length)
    .flatMap((group, index) => index ? [{ text: ' | ' }, ...group] : group)
}

export function statusBarText(state: StatusBarState): string {
  return statusBarPieces(state).map(piece => piece.text).join('')
}
