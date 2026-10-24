import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'

import { ACTIVE_SUBAGENT_STATUSES, terminalSubagentDuration, terminalSubagentTone, type TerminalSubagentActivity } from '../subagentMonitor'
import { parseAnsi, type AnsiLine } from './ansi'

const MAX_VISIBLE_ROWS = 3

function safe(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function icon(status: TerminalSubagentActivity['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'failed') return '✕'
  if (status === 'interrupted') return '!'
  if (status === 'queued') return '○'
  return '●'
}

function statusLabel(status: TerminalSubagentActivity['status']): string {
  switch (status) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'waiting_for_approval': return 'approval'
    case 'waiting_for_input': return 'input'
    case 'completed': return 'done'
    case 'failed': return 'failed'
    case 'interrupted': return 'stopped'
  }
}

/** Compact live roster placed above the composer. */
export function subagentsWidget(items: readonly TerminalSubagentActivity[], width: number, theme: Theme, now = Date.now()): AnsiLine[] {
  if (!items.length || width < 1) return []
  const ordered = [...items].sort((left, right) => {
    const active = Number(ACTIVE_SUBAGENT_STATUSES.has(right.status)) - Number(ACTIVE_SUBAGENT_STATUSES.has(left.status))
    return active || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  })
  const activeCount = items.filter(item => ACTIVE_SUBAGENT_STATUSES.has(item.status)).length
  const finishedCount = items.length - activeCount
  const heading = truncateToWidth(`Subagents · ${activeCount} active · ${finishedCount} finished · /plugin:subagents`, width, '…')
  const lines = [theme.fg('dim', heading)]
  const visible = ordered.slice(0, MAX_VISIBLE_ROWS)
  for (const item of visible) {
    const body = truncateToWidth(
      `${safe(item.goal || 'Subagent')} · ${statusLabel(item.status)} · ${safe(item.activity)} · ${terminalSubagentDuration(item, now)}`,
      Math.max(1, width - 2), '…'
    )
    lines.push(`${theme.fg(terminalSubagentTone(item.status), icon(item.status))} ${theme.fg('text', body)}`)
  }
  const overflow = ordered.length - visible.length
  if (overflow > 0) lines.push(theme.fg('muted', truncateToWidth(`+${overflow} more · /plugin:subagents`, width, '…')))
  return parseAnsi(lines.join('\n'))
}
