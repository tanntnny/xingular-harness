import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { formatWorkingDuration } from '../tui/workingStatus'
import { singleLine } from '../tui/status'

const SHIMMER_INTERVAL_MS = 120
const SHIMMER_RADIUS = 2

export interface WorkingLineState {
  sessionName?: string
  active: boolean
  frame: string
  label: string
  elapsedMs: number | null
  tokensPerSecond: number | null
}

export interface WorkingLineParts {
  prefix: string
  label: string
  suffix: string
}

export function workingLineParts(state: WorkingLineState, width?: number): WorkingLineParts {
  const displayLabel = state.active
    ? `${state.frame} ${state.label}`.trim() || 'Working…'
    : state.label
  if (!displayLabel) return { prefix: '', label: '', suffix: '' }

  let prefix = ''
  let label = displayLabel
  if (state.active && state.frame) {
    const framePrefix = `${state.frame} `
    if (displayLabel.startsWith(framePrefix)) {
      prefix = framePrefix
      label = displayLabel.slice(framePrefix.length)
    } else if (displayLabel === state.frame) {
      prefix = state.frame
      label = ''
    }
  }

  let suffix = ''
  if (state.elapsedMs !== null) {
    const rate = state.tokensPerSecond === null || !Number.isFinite(state.tokensPerSecond)
      ? '—'
      : String(Math.max(0, Math.round(state.tokensPerSecond)))
    suffix = ` (${formatWorkingDuration(state.elapsedMs)}, ${rate} tok/s)`
  }
  const name = singleLine(state.sessionName ?? '')
  if (name) suffix += ` – ${name}`
  if (width === undefined) return { prefix, label, suffix }
  let remaining = Math.max(0, Math.floor(width))
  const fit = (text: string): string => {
    const fitted = stripTerminalSequences(truncateToWidth(text, remaining, '…', false))
    remaining = Math.max(0, remaining - visibleWidth(fitted))
    return fitted
  }
  return { prefix: fit(prefix), label: fit(label), suffix: fit(suffix) }
}

export function workingVerbShimmerProfile(state: WorkingLineState): number[] {
  if (!state.active) return []

  const length = Array.from(workingLineParts(state).label).length
  if (length === 0) return []

  const elapsedMs = state.elapsedMs !== null && Number.isFinite(state.elapsedMs)
    ? Math.max(0, state.elapsedMs)
    : 0
  const edgePadding = SHIMMER_RADIUS + 1
  const cycleLength = length + edgePadding * 2
  const center = elapsedMs / SHIMMER_INTERVAL_MS % cycleLength - edgePadding

  return Array.from({ length }, (_, index) => {
    const distance = Math.abs(index - center) / edgePadding
    if (distance >= 1) return 0
    const easedDistance = distance * distance * (3 - 2 * distance)
    return 1 - easedDistance
  })
}

export function workingLineText(state: WorkingLineState, width?: number): string {
  const { prefix, label, suffix } = workingLineParts(state, width)
  return `${prefix}${label}${suffix}`
}
