import { describe, expect, it } from 'vitest'

import { extensionUi, type ExtensionNotice } from './extensionUi'
import type { QuestionAnswer, QuestionInput } from './registry'

function host(answer: QuestionAnswer | Promise<QuestionAnswer>) {
  const asked: QuestionInput[] = []
  const notices: ExtensionNotice[] = []
  const ui = extensionUi({ ask: async (input) => (asked.push(input), answer), notice: (notice) => void notices.push(notice) })
  return { ui, asked, notices }
}

describe('what an extension can ask and show without a terminal', () => {
  it('turns a choice, a yes or no, and typed text into questions', async () => {
    const choice = host({ selected: ['Block'] })
    expect(await choice.ui.select('Allow this command?', ['Allow', 'Block'])).toBe('Block')
    // Each question says which dialog asked it, so a terminal can show the dialog itself (ADR-0083).
    expect(choice.asked[0]).toEqual({ question: 'Allow this command?', options: [{ label: 'Allow', recommended: true }, { label: 'Block' }], multiSelect: false, allowText: false, dialog: { kind: 'select', title: 'Allow this command?', options: ['Allow', 'Block'] } })

    const yes = host({ selected: ['Yes'] })
    expect(await yes.ui.confirm('Clear the session?', 'All messages will be lost.')).toBe(true)
    expect(yes.asked[0]).toMatchObject({ question: 'Clear the session?\n\nAll messages will be lost.', options: [{ label: 'Yes' }, { label: 'No', recommended: true }], dialog: { kind: 'confirm', title: 'Clear the session?', message: 'All messages will be lost.' } })
    expect(await host({ selected: ['No'] }).ui.confirm('Sure?', '')).toBe(false)
    // No answer is a no, never a yes.
    expect(await host({ selected: [] }).ui.confirm('Sure?', '')).toBe(false)

    const typed = host({ selected: [], text: 'main' })
    expect(await typed.ui.input('Branch', 'a name')).toBe('main')
    expect(typed.asked[0]).toMatchObject({ question: 'Branch (a name)', options: [{ label: 'Type your response', recommended: true }], allowText: true, dialog: { kind: 'input', title: 'Branch', placeholder: 'a name' } })
    expect(await host({ selected: [] }).ui.input('Branch')).toBeUndefined()
    const editor = host({ selected: [], text: 'edited' })
    expect(await editor.ui.editor('Edit', 'before')).toBe('edited')
    expect(editor.asked[0]).toMatchObject({ options: [{ label: 'Type your response', recommended: true }], allowText: true, dialog: { kind: 'editor', title: 'Edit', prefill: 'before' } })
    const empty = host({ selected: [] })
    expect(await empty.ui.select('Pick', [])).toBeUndefined()
    expect(empty.asked).toHaveLength(0)
  })

  it('gives up a dialog when the extension dismisses it or its time runs out', async () => {
    const never = new Promise<QuestionAnswer>(() => undefined)
    expect(await host(never).ui.confirm('Sure?', '', { timeout: 10 })).toBe(false)
    const controller = new AbortController()
    const pending = host(never).ui.select('Pick', ['a'], { signal: controller.signal })
    controller.abort()
    expect(await pending).toBeUndefined()
  })

  it('relays notifications, status lines and text widgets, and ignores what needs a terminal', async () => {
    const { ui, notices } = host({ selected: [] })
    ui.notify('Blocked', 'warning')
    ui.setStatus('budget', '3 of 10 requests')
    ui.setStatus('budget', undefined)
    ui.setWidget('plan', ['One', 'Two'])
    ui.setWidget('plan', (() => ({})) as never)
    ui.setTitle('Review')
    ui.setFooter(undefined)
    ui.setWorkingMessage('thinking')
    expect(notices).toEqual([
      { kind: 'notify', level: 'warning', text: 'Blocked' },
      { kind: 'status', key: 'budget', text: '3 of 10 requests' },
      { kind: 'status', key: 'budget', text: '' },
      { kind: 'widget', key: 'plan', text: 'One\nTwo' },
      { kind: 'title', text: 'Review' }
    ])
    expect(await ui.custom((() => ({})) as never)).toBeUndefined()
    expect(ui.getEditorText()).toBe('')
    // Styling returns the text unchanged: there is nothing to colour.
    expect((ui.theme as unknown as { fg(color: string, text: string): string }).fg('accent', 'plain')).toBe('plain')
    expect(ui.setTheme('dark')).toMatchObject({ success: false })
  })
})
