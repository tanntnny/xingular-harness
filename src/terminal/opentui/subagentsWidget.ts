import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { ACTIVE_SUBAGENT_STATUSES, type TerminalSubagentActivity } from '../subagentMonitor'
import { getWorkingSpinnerFrames } from '../tui/workingStatus'

const MAX_VISIBLE_ROWS = 3
const GAP = '  '

export type SubagentTone = 'success' | 'warning' | 'error' | 'muted' | 'accent'

/** One roster row: status mark, profile, session name, checklist progress, in that order. */
export interface SubagentRowView {
  id: string
  mark: string
  tone: SubagentTone
  /** The profile name, or `subagent` for a copy of the parent. */
  profile: string
  /** The profile's colour name (PROP-0029); null for a copy of the parent. */
  color: string | null
  title: string
  /** `n of m tasks`, or null when the child wrote no checklist. */
  tasks: string | null
}

export interface SubagentRosterView {
  rows: SubagentRowView[]
  /** `+N more · /subagents` when rows were left out. */
  overflow: string | null
}

/** Cuts plain text to a width; the cut adds no styling codes. */
function cut(text: string, width: number): string {
  return stripTerminalSequences(truncateToWidth(text, width, '…'))
}

function safe(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function mark(status: TerminalSubagentActivity['status'], frame: string): { mark: string; tone: SubagentTone } {
  switch (status) {
    case 'completed': return { mark: '✓', tone: 'success' }
    case 'failed': return { mark: '✕', tone: 'error' }
    case 'interrupted': return { mark: '!', tone: 'muted' }
    case 'queued': return { mark: '○', tone: 'muted' }
    case 'waiting_for_approval':
    case 'waiting_for_input': return { mark: '●', tone: 'accent' }
    case 'running': return { mark: frame, tone: 'warning' }
  }
}

export function subagentTasks(checklist: TerminalSubagentActivity['checklist']): string | null {
  return checklist && checklist.total > 0 ? `${checklist.done} of ${checklist.total} tasks` : null
}

/**
 * The compact live roster shown under the status line: active children first, at most three
 * rows. The session name is cut first when the terminal is narrow.
 */
export function subagentRoster(items: readonly TerminalSubagentActivity[], width: number, frame: string = getWorkingSpinnerFrames()[0] ?? ''): SubagentRosterView | null {
  if (!items.length || width < 1) return null
  const ordered = [...items].sort((left, right) => {
    const active = Number(ACTIVE_SUBAGENT_STATUSES.has(right.status)) - Number(ACTIVE_SUBAGENT_STATUSES.has(left.status))
    return active || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
  })
  const rows = ordered.slice(0, MAX_VISIBLE_ROWS).map((item): SubagentRowView => {
    const status = mark(item.status, frame)
    const profile = cut(safe(item.profile?.name ?? '') || 'subagent', Math.max(1, Math.min(24, width - 2)))
    const tasks = subagentTasks(item.checklist)
    const used = 2 + visibleWidth(profile) + GAP.length + (tasks ? GAP.length + tasks.length : 0)
    const title = cut(safe(item.title) || 'Subagent', Math.max(1, width - used))
    return { id: item.id, mark: status.mark, tone: status.tone, profile, color: item.profile?.color ?? null, title, tasks }
  })
  const overflow = ordered.length - rows.length
  return { rows, overflow: overflow > 0 ? cut(`+${overflow} more · /subagents`, width) : null }
}

/** A row as plain text, the way it reads on screen. */
export function subagentRowText(row: SubagentRowView): string {
  return [`${row.mark} ${row.profile}`, row.title, row.tasks].filter(Boolean).join(GAP)
}
