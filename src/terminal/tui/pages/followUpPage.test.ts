import { describe, expect, it, vi } from 'vitest'
import type { FollowUpQueueEditor, FollowUpQueueEntry } from '../commands'
import type { TerminalMouseInput } from '../mouse'
import { FollowUpQueuePage } from './followUpQueuePage'

const theme = {} as never

function setup(entries: FollowUpQueueEntry[] = []) {
  const editor: FollowUpQueueEditor = {
    entries: () => entries,
    edit: vi.fn(async () => {}),
    sendNext: vi.fn(async () => {}),
    remove: vi.fn(id => { const index = entries.findIndex(entry => entry.id === id); if (index >= 0) entries.splice(index, 1) }),
    close: vi.fn()
  }
  const changed = vi.fn()
  const close = vi.fn()
  const page = new FollowUpQueuePage({ editor, theme: () => theme, changed, close })
  return { page, editor, changed, close }
}

describe('FollowUpQueuePage', () => {
  it('shows separate queue kinds in FIFO order and explains empty state', () => {
    const { page } = setup([
      { id: 'f1', kind: 'followUp', text: 'Later', hasImages: true },
      { id: 's1', kind: 'steering', text: 'Now', hasImages: false }
    ])
    const output = page.render(80, 24).join('\\n')
    expect(output.indexOf('Steer\\n')).toBeLessThan(output.indexOf('Follow-up\\n'))
    expect(output).toContain('Steer  Now')
    expect(output).toContain('Follow-up · images  Later')
    expect(setup().page.render(80, 24).join('\\n')).toContain('Queue is empty')
  })

  it('selects a queue row by mouse before removing it', () => {
    const { page, editor } = setup([
      { id: 'steer', kind: 'steering', text: 'Now', hasImages: false },
      { id: 'follow', kind: 'followUp', text: 'Later', hasImages: false }
    ])
    const row = page.render(120, 100).findIndex(line => line.includes('Follow-up  Later'))
    expect(row).toBeGreaterThanOrEqual(0)

    page.handleMouse({ type: 'click', button: 'left', x: 0, y: row } as TerminalMouseInput)
    page.handleInput('d')
    expect(editor.remove).toHaveBeenCalledWith('follow')
  })

  it('supports selection and edit, send-next, remove, return actions, then closes on disposal', async () => {
    const { page, editor, changed, close } = setup([
      { id: 'first', kind: 'steering', text: 'One', hasImages: false },
      { id: 'second', kind: 'followUp', text: 'Two', hasImages: false }
    ])
    page.handleInput('\u001b[B')
    page.handleInput('e')
    await Promise.resolve()
    expect(editor.edit).toHaveBeenCalledWith('second')
    page.handleInput('s')
    await Promise.resolve()
    expect(editor.sendNext).toHaveBeenCalledOnce()
    page.handleInput('d')
    expect(editor.remove).toHaveBeenCalledWith('second')
    page.handleInput('r')
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    page.dispose()
    expect(editor.close).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalled()
  })
})
