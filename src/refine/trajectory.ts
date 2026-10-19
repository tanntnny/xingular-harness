// A run's recorded events in the shared trajectory grammar an improver reads:
// [USER] / [ASSISTANT] / [ACTION] / [OBSERVATION] / [ERROR]. Every event is kept; only a single
// observation longer than `obsTrunc` is clipped, with an explicit marker.
import type { RunEvent } from '../sessions/contracts'

const TRUNC = (n: number) => `…(+${n} chars — render truncation)`

function clip(text: string, limit: number): string {
  const clean = text.replace(/\0/g, '')
  return limit > 0 && clean.length > limit ? `${clean.slice(0, limit)}${TRUNC(clean.length - limit)}` : clean
}

export function renderEvents(events: readonly RunEvent[], options: { obsTrunc: number; argsTrunc?: number }): string {
  const out: string[] = []
  const argsTrunc = options.argsTrunc ?? 2000
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'message.completed':
        if (typeof payload.text === 'string' && payload.text.trim()) out.push(`[${payload.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${clip(payload.text, options.obsTrunc)}`)
        break
      case 'tool.started':
        out.push(`[ACTION] ${String(payload.name ?? 'tool')}${typeof payload.input === 'string' && payload.input ? ` ${clip(payload.input, argsTrunc)}` : ''}`)
        break
      case 'tool.completed': {
        const text = typeof payload.output === 'string' ? payload.output : ''
        out.push(`${payload.ok === false ? '[ERROR]' : '[OBSERVATION]'} ${String(payload.name ?? 'tool')}${typeof payload.durationMs === 'number' ? ` (${Math.round(payload.durationMs)} ms)` : ''}\n${clip(text, options.obsTrunc)}${payload.outputTruncated ? '\n(the tool output was already bounded when it was recorded)' : ''}`)
        break
      }
      case 'retry.started':
        out.push(`[ERROR] model request failed, retrying (${String(payload.attempt)}/${String(payload.maxAttempts)}): ${String(payload.error ?? '')}`)
        break
      case 'compaction.ended':
        out.push(`[ACTION] context compacted (${String(payload.reason ?? '')})${typeof payload.tokensBefore === 'number' ? `: ${payload.tokensBefore} → ${String(payload.tokensAfter ?? '?')} tokens` : ''}`)
        break
      case 'approval.resolved':
        if (payload.decision === 'denied') out.push('[ERROR] a tool call was refused')
        break
      case 'extension.notice':
        if (typeof payload.text === 'string') out.push(`[OBSERVATION] notice: ${clip(payload.text, 2000)}`)
        break
      case 'failed':
        out.push(`[ERROR] run failed: ${String(payload.message ?? payload.code ?? '')}`)
        break
      case 'status.changed':
        if (payload.status === 'interrupted') out.push('[ERROR] run interrupted')
        break
      default:
        break
    }
  }
  return out.length ? out.join('\n\n') : '(no trajectory: the run recorded no messages or tool use)'
}

/** The last assistant message of a run. */
export function finalText(events: readonly RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload as Record<string, unknown> | undefined
    if (events[i]!.type === 'message.completed' && payload?.role === 'assistant' && typeof payload.text === 'string' && payload.text.trim()) return payload.text
  }
  return ''
}

/** The run's cost so far, from its last usage report. */
export function costOf(events: readonly RunEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload as Record<string, unknown> | undefined
    if (events[i]!.type === 'usage.updated' && typeof payload?.costUsd === 'number') return payload.costUsd
  }
  return 0
}
