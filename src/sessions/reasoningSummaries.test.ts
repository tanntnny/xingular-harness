import { describe, expect, it } from 'vitest'

import { completedReasoningSummary, requestDetailedReasoningSummary } from './reasoningSummaries'

describe('reasoning summaries', () => {
  it('requests a detailed summary without changing the selected effort or other payload fields', () => {
    const payload = { model: 'gpt-6-luna', reasoning: { effort: 'high', budget: 12 }, stream: true }
    const result = requestDetailedReasoningSummary(payload)

    expect(result).toEqual({
      requested: true,
      payload: { model: 'gpt-6-luna', reasoning: { effort: 'high', budget: 12, summary: 'detailed' }, stream: true }
    })
    expect(payload.reasoning).toEqual({ effort: 'high', budget: 12 })
  })

  it('does not request a summary when reasoning is absent or disabled', () => {
    const absent = { model: 'gpt-6-luna' }
    const disabled = { reasoning: { effort: 'off' } }

    expect(requestDetailedReasoningSummary(absent)).toEqual({ payload: absent, requested: false })
    expect(requestDetailedReasoningSummary(disabled)).toEqual({ payload: disabled, requested: false })
  })

  it('reads only the provider summary, not raw reasoning content', () => {
    const message = {
      role: 'assistant',
      api: 'openai-codex-responses',
      content: [{
        type: 'thinking',
        thinking: 'raw private reasoning',
        thinkingSignature: JSON.stringify({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Detailed summary.' }],
          content: [{ text: 'raw private reasoning' }]
        })
      }]
    }

    expect(completedReasoningSummary(message)).toBe('Detailed summary.')
  })
})
