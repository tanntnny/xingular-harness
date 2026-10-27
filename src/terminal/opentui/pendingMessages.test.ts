import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { pendingMessageLines, type PendingMessage } from './pendingMessages'

describe('pending message display', () => {
  it('labels native and deferred inputs in the supplied order', () => {
    const messages: PendingMessage[] = [
      { kind: 'steering', text: 'first' }, { kind: 'followUp', text: 'second' },
      { kind: 'plan', text: 'third' }, { kind: 'bash', text: 'fourth' }, { kind: 'prompt', text: 'fifth' }
    ]
    expect(pendingMessageLines(messages, 80, 5)).toEqual([
      'Steering · first', 'Follow-up · second', 'Plan · third', 'Bash · fourth', 'Prompt · fifth'
    ])
    expect(pendingMessageLines(messages, 80, 3)).toEqual(['Steering · first', 'Follow-up · second', '+3 more pending'])
    expect(pendingMessageLines(messages, 80, 1)).toEqual(['+5 more pending'])
  })

  it('hides empty queues and handles unusable dimensions', () => {
    expect(pendingMessageLines([], 80)).toEqual([])
    expect(pendingMessageLines([{ kind: 'plan', text: '' }], 0)).toEqual([])
    expect(pendingMessageLines([{ kind: 'plan', text: '' }], 80, 0)).toEqual([])
    expect(pendingMessageLines([{ kind: 'plan', text: '' }], 80)).toEqual(['Plan · (empty)'])
  })

  it('removes control sequences and fits wide text to terminal cells', () => {
    const messages: PendingMessage[] = [{ kind: 'prompt', text: '\u001b[31mhello\u001b[0m\n世界\u202eabc\u0007' }]
    const line = pendingMessageLines(messages, 80)[0]!
    expect(line).toBe('Prompt · hello 世界 abc')
    for (let width = 1; width <= 20; width++) {
      const fitted = pendingMessageLines(messages, width)[0]!
      expect(visibleWidth(fitted)).toBeLessThanOrEqual(width)
      expect(fitted).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/u)
    }
  })
})
