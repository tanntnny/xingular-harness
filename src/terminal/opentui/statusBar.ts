import { displayProjectName, formatTokenCount, singleLine } from '../tui/status'

export interface StatusBarState {
  cwd: string
  branch: string | null
  account?: string
  model?: { name: string }
  thinking: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** Share of the model's window the latest request used; null until something measured it. */
  contextPercent?: number | null
  /** The model's window, when it has one. */
  contextWindow?: number
  /** `/remote-control`: on and waiting for a phone, or a phone connected. */
  remoteControl?: 'waiting' | 'connected' | null
}

/** `18.3%/1M`, or `45.3%/?` when no model reported a window. */
export function contextReading(percent: number | null | undefined, window: number | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '?'
  const bounded = Math.max(0, Math.min(999, percent))
  return `${bounded.toFixed(1)}%/${window && window > 0 ? formatTokenCount(window) : '?'}`
}

function cacheHitRate(cacheReadTokens: number, inputTokens: number): string {
  const total = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0
  const reads = Number.isFinite(cacheReadTokens) ? Math.max(0, cacheReadTokens) : 0
  const percent = total ? Math.round(Math.min(reads, total) / total * 100) : 0
  return `R${percent}%`
}

/**
 * The status line under the composer groups the working folder and branch as `project:branch`,
 * followed by account/model/effort and input/cache-rate/output tokens. Groups are joined with `|`
 * and may wrap; account, model, and effort are separated by spaces. `rc` follows while remote
 * control is on, `rc ●` once a phone is connected.
 */
export function statusBarGroups(state: StatusBarState): string[] {
  const model = (singleLine(state.model?.name ?? '') || 'no model').replace(/^Claude /, '')
  const project = displayProjectName(state.cwd) || '—'
  const branch = singleLine(state.branch ?? '') || '—'
  return [
    `${project}:${branch}`,
    `${singleLine(state.account ?? '') || 'account unknown'} ${model} ${singleLine(state.thinking) || 'off'}`,
    [
      `↑${formatTokenCount(state.inputTokens)} ${cacheHitRate(state.cacheReadTokens, state.inputTokens)} ↓${formatTokenCount(state.outputTokens)}`,
      state.contextPercent === undefined ? '' : contextReading(state.contextPercent, state.contextWindow)
    ].filter(Boolean).join(' '),
    state.remoteControl === 'connected' ? 'rc ●' : state.remoteControl === 'waiting' ? 'rc' : ''
  ].filter(Boolean)
}

export function statusBarText(state: StatusBarState): string {
  return statusBarGroups(state).join(' | ')
}
