export const MAX_REASONING_SUMMARY_CHARS = 4_000

export const REASONING_SUMMARY_APIS = new Set([
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses'
])

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cleanSummary(value: string): string | undefined {
  let text = ''
  for (const character of value.trim()) {
    if (text.length + character.length > MAX_REASONING_SUMMARY_CHARS) break
    text += character
  }
  return text.trim() || undefined
}

/** Add the Responses API summary request while preserving the provider-selected effort. */
export function requestConciseReasoningSummary(payload: unknown): { payload: unknown; requested: boolean } {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return { payload, requested: false }
  const effort = payload.reasoning.effort
  if (typeof effort !== 'string' || ['none', 'off'].includes(effort.toLowerCase())) return { payload, requested: false }
  return {
    payload: { ...payload, reasoning: { ...payload.reasoning, summary: 'concise' } },
    requested: true
  }
}

/** Pi preserves the provider reasoning item for both WebSocket and SSE replay.
 * Read only its explicit summary: Pi's generic thinking field can also contain raw reasoning.
 */
export function completedReasoningSummary(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || typeof message.api !== 'string' || !REASONING_SUMMARY_APIS.has(message.api) || !Array.isArray(message.content)) return undefined
  const parts: string[] = []
  const seen = new Set<string>()
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'thinking' || typeof block.thinkingSignature !== 'string') continue
    try {
      const item: unknown = JSON.parse(block.thinkingSignature)
      if (!isRecord(item) || item.type !== 'reasoning' || !Array.isArray(item.summary)) continue
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) continue
        seen.add(item.id)
      }
      for (const part of item.summary) {
        if (isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string') parts.push(part.text)
      }
    } catch {
      // Signatures of other formats, or incomplete items, are not summary evidence.
    }
  }
  return cleanSummary(parts.join('\n\n'))
}
