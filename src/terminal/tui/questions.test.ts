import type { ExtensionUIContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { answerTerminalQuestion } from './questions'

function fixture() {
  const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI
  const theme = {
    fg: (color: string, text: string) => color === 'warning' ? `\x1b[33m${text}\x1b[39m` : text,
    bg: (_color: string, text: string) => text,
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
    const answer = answerTerminalQuestion(context, { requestId: 'q', question: 'Choose?', options: [{ label: 'Write an answer', description: 'Actual choice' }] }, signal)
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
      requestId: 'q', question: 'Choose?', options: [{ label: 'A' }], multiSelect: true
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
    controller.abort()
    await expect(answer).resolves.toBeUndefined()
    expect(ui.custom).toHaveBeenCalledOnce()
  })

  it('shows batch progress and the full question in text entry', async () => {
    const { ui, context, signal } = fixture()
    ui.input.mockResolvedValue(undefined)
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', question: 'Why?', summary: 'Reason', batchId: 'batch', batchIndex: 2, batchCount: 3
    }, signal)
    await expect(answer).resolves.toBeUndefined()
    expect(ui.input).toHaveBeenCalledWith('2 of 3 · Reason: Why?', undefined, { signal })
  })

  it('honors text restrictions and cancels the picker when the question expires', async () => {
    const controller = new AbortController()
    const { ui, context, getActive } = fixture()
    const answer = answerTerminalQuestion(context, {
      requestId: 'q', options: [{ label: 'A' }], allowText: false
    }, controller.signal)
    expect(stripTerminalSequences(getActive()!.render(80).join('\n'))).not.toContain('Write an answer')
    controller.abort()
    await expect(answer).resolves.toBeUndefined()
    expect(ui.custom).toHaveBeenCalledOnce()
  })
})
