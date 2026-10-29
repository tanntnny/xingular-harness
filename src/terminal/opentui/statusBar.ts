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
  /** `/remote-control`: on and waiting for a phone, or a phone connected. */
  remoteControl?: 'waiting' | 'connected' | null
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
 * control is on, `rc ●` once a phone is connected. Context use is not a band group; `/context`
 * reads the share of the window.
 */
export function statusBarGroups(state: StatusBarState): string[] {
  const model = (singleLine(state.model?.name ?? '') || 'no model').replace(/^Claude /, '')
  const project = displayProjectName(state.cwd) || '—'
  const branch = singleLine(state.branch ?? '') || '—'
  return [
    `${project}:${branch}`,
    `${singleLine(state.account ?? '') || 'account unknown'} ${model} ${singleLine(state.thinking) || 'off'}`,
    `↑${formatTokenCount(state.inputTokens)} ${cacheHitRate(state.cacheReadTokens, state.inputTokens)} ↓${formatTokenCount(state.outputTokens)}`,
    state.remoteControl === 'connected' ? 'rc ●' : state.remoteControl === 'waiting' ? 'rc' : ''
  ].filter(Boolean)
}

export function statusBarText(state: StatusBarState): string {
  return statusBarGroups(state).join(' | ')
}
