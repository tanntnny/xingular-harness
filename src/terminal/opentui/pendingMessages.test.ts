import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { pendingMessageRows, type PendingMessage, type PendingMessageRow } from './pendingMessages'

const flat = (rows: PendingMessageRow[]): string[] => rows.map(row => (row.label ? `${row.label} ${row.text}` : row.text))

describe('pending message display', () => {
  it('labels native and deferred inputs in the supplied order', () => {
    const messages: PendingMessage[] = [
      { kind: 'steering', text: 'first' }, { kind: 'followUp', text: 'second' },
      { kind: 'plan', text: 'third' }, { kind: 'bash', text: 'fourth' }, { kind: 'prompt', text: 'fifth' }
    ]
    expect(pendingMessageRows(messages, 80, 5)).toEqual([
      { label: 'Steer:', text: 'first', accent: true },
      { label: 'Follow-up:', text: 'second', accent: true },
      { label: 'Plan:', text: 'third', accent: false },
      { label: 'Bash:', text: 'fourth', accent: false },
      { label: 'Prompt:', text: 'fifth', accent: false }
    ])
    expect(flat(pendingMessageRows(messages, 80, 3))).toEqual(['Steer: first', 'Follow-up: second', '+3 more pending'])
    expect(flat(pendingMessageRows(messages, 80, 1))).toEqual(['+5 more pending'])
  })

  it('hides empty queues and handles unusable dimensions', () => {
    expect(pendingMessageRows([], 80)).toEqual([])
    expect(pendingMessageRows([{ kind: 'plan', text: '' }], 0)).toEqual([])
    expect(pendingMessageRows([{ kind: 'plan', text: '' }], 80, 0)).toEqual([])
    expect(flat(pendingMessageRows([{ kind: 'plan', text: '' }], 80))).toEqual(['Plan: (empty)'])
  })

  it('removes control sequences and fits wide text to terminal cells', () => {
    const messages: PendingMessage[] = [{ kind: 'prompt', text: '\u001b[31mhello\u001b[0m\n世界\u202eabc\u0007' }]
    expect(flat(pendingMessageRows(messages, 80))).toEqual(['Prompt: hello 世界 abc'])
    for (let width = 1; width <= 20; width++) {
      const rows = pendingMessageRows(messages, width)
      const line = flat(rows).join('')
      expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/u)
    }
  })

  it('drops the label when the terminal is narrower than it', () => {
    const messages: PendingMessage[] = [{ kind: 'steering', text: 'change direction' }]
    for (let width = 1; width < 'Steer: '.length + 1; width++) {
      const [row] = pendingMessageRows(messages, width)
      expect(row).toEqual({ label: '', text: expect.any(String), accent: false })
      expect(visibleWidth(row!.text)).toBeLessThanOrEqual(width)
    }
    expect(pendingMessageRows(messages, 8)[0]).toMatchObject({ label: 'Steer:', accent: true })
  })
})
