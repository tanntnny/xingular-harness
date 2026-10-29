import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { singleLine } from '../tui/status'

export interface PendingMessage {
  kind: 'steering' | 'followUp' | 'plan' | 'bash' | 'prompt'
  text: string
}

/** One projected line: its label, the message body, and whether the label carries the accent. */
export interface PendingMessageRow {
  label: string
  text: string
  accent: boolean
}

const labels: Record<PendingMessage['kind'], { label: string; accent: boolean }> = {
  steering: { label: 'Steer:', accent: true },
  followUp: { label: 'Follow-up:', accent: true },
  plan: { label: 'Plan:', accent: false },
  bash: { label: 'Bash:', accent: false },
  prompt: { label: 'Prompt:', accent: false }
}

/** A bounded, single-line projection; queue contents remain untouched. */
export function pendingMessageRows(messages: readonly PendingMessage[], width: number, maxRows = 4): PendingMessageRow[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const rows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0
  if (!columns || !rows || !messages.length) return []
  const shown = messages.length > rows ? rows - 1 : rows
  const fit = (text: string, limit: number) => stripTerminalSequences(truncateToWidth(text, Math.max(0, limit), '…', false))
  const body = (message: PendingMessage) =>
    singleLine(message.text.replace(/[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')) || '(empty)'
  const result = messages.slice(0, shown).map(message => {
    const { label, accent } = labels[message.kind]
    const room = columns - visibleWidth(label) - 1
    // A terminal narrower than the label shows the message rather than a clipped word.
    if (room < 1) return { label: '', text: fit(body(message), columns), accent: false }
    return { label, text: fit(body(message), room), accent }
  })
  if (messages.length > shown) {
    result.push({ label: '', text: fit(`+${messages.length - shown} more pending`, columns), accent: false })
  }
  return result
}
