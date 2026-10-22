import type { ExtensionUIContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { answerTerminalQuestion } from './questions'

function fixture() {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI
  const theme = {
    fg: (color: string, text: string) => color === 'warning' ? `\x1b[33m${text}\x1b[39m` : color === 'accent' ? `\x1b[36m${text}\x1b[39m` : text,
    bg: (color: string, text: string) => color === 'selectedBg' ? `\x1b[44m${text}\x1b[49m` : text,
    style: (text: string) => text,
    bold: (text: string) => text
  } as unknown as Theme
  let active: Component | undefined
  const custom = vi.fn((factory: Parameters<ExtensionUIContext['custom']>[0]) => new Promise<unknown>((resolve) => {
    active = factory(tui, theme, {} as KeybindingsManager, resolve) as Component
  }))
  const ui = { custom, input: vi.fn() }
  return { ui, context: ui as unknown as ExtensionUIContext, signal: new AbortController().signal, getActive: () => active }
}

describe('terminal question answers', () => {
  it('keeps action-like option labels distinct from dialog actions', async () => {
    const { ui, context, signal, getActive } = fixture()
    const answer = answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [{ label: 'Write an answer', description: 'Actual choice', recommended: true }] }, signal)
    expect(stripTerminalSequences(getActive()!.render(80).join('\n'))).toContain('1. Write an answer')
    getActive()!.handleInput?.('\r')
    await expect(answer).resolves.toEqual({ selected: ['Write an answer'] })
    expect(ui.input).not.toHaveBeenCalled()
  })

  it('returns the original label when a recommended choice is selected', async () => {
    const { context, signal, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Choose?', options: [{ label: 'Plan A' }, { label: 'Plan B', recommended: true }], allowText: false
    }, signal)
    getActive()!.handleInput?.('\r')
    await expect(answer).resolves.toEqual({ selected: ['Plan B'] })
  })

  it('keeps numeric choice shortcuts aligned with the displayed recommendation-first order', async () => {
    const { context, signal, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Choose?', options: [{ label: 'Plan A' }, { label: 'Plan B', recommended: true }], allowText: false
    }, signal)
    getActive()!.handleInput?.('2')
    await expect(answer).resolves.toEqual({ selected: ['Plan A'] })
  })

  it('returns to choices after text entry is cancelled and retains multiple selections', async () => {
    const { ui, context, signal, getActive } = fixture()
    ui.input.mockResolvedValue(undefined)
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Choose?', options: [{ label: 'A', recommended: true }], multiSelect: true
    }, signal)
    getActive()!.handleInput?.('\r')
    getActive()!.handleInput?.('\x1b[B')
    getActive()!.handleInput?.('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ui.custom).toHaveBeenCalledTimes(2)
    getActive()!.handleInput?.('\x1b[B')
    getActive()!.handleInput?.('\x1b[B')
    getActive()!.handleInput?.('\r')
    await expect(answer).resolves.toEqual({ selected: ['A'] })
  })

  it('shows recommended options first with a yellow marker, without modifying the labels', async () => {
    const controller = new AbortController()
    const { ui, context, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Choose?', options: [
        { label: 'Plan A' },
        { label: 'Plan B', recommended: true },
        { label: 'Plan C', recommended: true }
      ], multiSelect: true
    }, controller.signal)
    const rendered = getActive()!.render(100).join('\n')
    const plain = stripTerminalSequences(rendered)
    expect(plain.indexOf('Plan B')).toBeLessThan(plain.indexOf('Plan A'))
    expect(plain.indexOf('Plan C')).toBeLessThan(plain.indexOf('Plan A'))
    expect(rendered).toContain('\x1b[33m(Recommended)\x1b[39m')
    const highlighted = rendered.split('\n').find(line => stripTerminalSequences(line).includes('❯ 1. Plan B')) ?? ''
    expect(highlighted).toContain('\x1b[44m')
    expect(highlighted).not.toContain('\x1b[36m')
    controller.abort()
    await expect(answer).resolves.toBeUndefined()
    expect(ui.custom).toHaveBeenCalledOnce()
  })

  it('keeps checked answers distinct from the keyboard-highlighted choice', async () => {
    const controller = new AbortController()
    const { context, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Choose?', options: [{ label: 'Plan A' }, { label: 'Plan B', recommended: true }], multiSelect: true, allowText: false
    }, controller.signal)
    const active = getActive()!
    active.handleInput?.('\r')
    active.handleInput?.('\x1b[B')
    const rows = active.render(100)
    const checked = rows.find(line => stripTerminalSequences(line).includes('✓ Plan B')) ?? ''
    const highlighted = rows.find(line => stripTerminalSequences(line).includes('❯ 2. Plan A')) ?? ''
    expect(checked).not.toContain('\x1b[44m')
    expect(highlighted).toContain('\x1b[44m')
    expect(highlighted).not.toContain('\x1b[36m')
    controller.abort()
    await expect(answer).resolves.toBeUndefined()
  })

  it('shows batch progress in Something else text entry alongside choices', async () => {
    const { ui, context, signal, getActive } = fixture()
    ui.input.mockResolvedValue('A different reason')
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Why?', summary: 'Reason', batchId: 'batch', batchIndex: 2, batchCount: 3,
      options: [{ label: 'Known reason', recommended: true }]
    }, signal)
    getActive()!.handleInput?.('\x1b[B')
    getActive()!.handleInput?.('\r')
    await expect(answer).resolves.toEqual({ selected: [], text: 'A different reason' })
    expect(ui.input).toHaveBeenCalledWith('2 of 3 · Reason: Why?', undefined, { signal })
  })

  it('rejects questions without a choice or a recommended choice', async () => {
    const { context, signal } = fixture()
    await expect(answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [] }, signal))
      .rejects.toThrow('Every question needs at least one choice.')
    await expect(answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [{ label: 'A' }] }, signal))
      .rejects.toThrow('Every question needs at least one recommended choice.')
  })

  it('honors text restrictions and cancels the picker when the question expires', async () => {
    const controller = new AbortController()
    const { ui, context, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', options: [{ label: 'A', recommended: true }], allowText: false
    }, controller.signal)
    expect(stripTerminalSequences(getActive()!.render(80).join('\n'))).not.toContain('Write an answer')
    controller.abort()
    await expect(answer).resolves.toBeUndefined()
    expect(ui.custom).toHaveBeenCalledOnce()
  })
})
