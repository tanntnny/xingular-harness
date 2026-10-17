import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { answerTerminalQuestion } from './questions'

function fixture() {
  const ui = { select: vi.fn(), input: vi.fn() }
  return { ui, context: ui as unknown as ExtensionUIContext, signal: new AbortController().signal }
}

describe('terminal question answers', () => {
  it('keeps action-like option labels distinct from dialog actions', async () => {
    const { ui, context, signal } = fixture()
    ui.select.mockResolvedValue('1. Write an answer — Actual choice')
    expect(await answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [{ label: 'Write an answer', description: 'Actual choice' }] }, signal)).toEqual({ selected: ['Write an answer'] })
    expect(ui.input).not.toHaveBeenCalled()
  })

  it('returns to choices when text entry is cancelled and retains multiple selections', async () => {
    const { ui, context, signal } = fixture()
    ui.select.mockResolvedValueOnce('1. A').mockResolvedValueOnce('Write an answer').mockResolvedValueOnce('Submit choices')
    ui.input.mockResolvedValue(undefined)
    expect(await answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [{ label: 'A' }], multiSelect: true }, signal)).toEqual({ selected: ['A'] })
    expect(ui.select).toHaveBeenCalledTimes(3)
    expect(ui.select.mock.calls[2][1]).toContain('1. ✓ A')
  })

  it('shows real batch progress and returns cancellation without inventing an answer', async () => {
    const { ui, context, signal } = fixture()
    ui.input.mockResolvedValue(undefined)
    expect(await answerTerminalQuestion(context, { requestId: 'q', question: 'Why?', summary: 'Reason', batchId: 'batch', batchIndex: 2, batchCount: 3 }, signal)).toBeUndefined()
    expect(ui.input).toHaveBeenCalledWith('2 of 3 · Reason: Why?', undefined, { signal })
  })

  it('honors text restrictions and ignores answers after expiry', async () => {
    const { ui, context } = fixture()
    const controller = new AbortController()
    ui.select.mockImplementation(async () => { controller.abort(); return '1. A' })
    expect(await answerTerminalQuestion(context, { requestId: 'q', options: [{ label: 'A' }], allowText: false }, controller.signal)).toBeUndefined()
    expect(ui.select.mock.calls[0][1]).toEqual(['1. A'])
  })
})
