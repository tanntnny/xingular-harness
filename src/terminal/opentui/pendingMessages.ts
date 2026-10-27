import { stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui'

import { singleLine } from '../tui/status'

export interface PendingMessage {
  kind: 'steering' | 'followUp' | 'plan' | 'bash' | 'prompt'
  text: string
}

const labels: Record<PendingMessage['kind'], string> = {
  steering: 'Steering',
  followUp: 'Follow-up',
  plan: 'Plan',
  bash: 'Bash',
  prompt: 'Prompt'
}

/** A bounded, single-line projection; queue contents remain untouched. */
export function pendingMessageLines(messages: readonly PendingMessage[], width: number, maxRows = 4): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  const rows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0
  if (!columns || !rows || !messages.length) return []
  const shown = messages.length > rows ? rows - 1 : rows
  const fit = (text: string) => stripTerminalSequences(truncateToWidth(text, columns, '…', false))
  const result = messages.slice(0, shown).map(message => {
    const text = singleLine(message.text.replace(/[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' '))
    return fit(`${labels[message.kind]} · ${text || '(empty)'}`)
  })
  if (messages.length > shown) result.push(fit(`+${messages.length - shown} more pending`))
  return result
}
