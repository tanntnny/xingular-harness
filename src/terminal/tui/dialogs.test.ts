import type { Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { DialogPanel, SearchableSelect } from './dialogs'
import type { TerminalMouseInput } from './mouse'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const tui = {
  terminal: { columns: 80, rows: 24 },
  centeredDialogs: true
} as unknown as TUI

const mouse = (y: number, type: 'move' | 'click' = 'move'): TerminalMouseInput => ({
  type, button: type === 'click' ? 'left' : 'none', x: 0, y, screenX: 0, screenY: y,
  width: 56, height: 19, shift: false, alt: false, ctrl: false
})

function select(onSelect: (index: number) => void, search: 'always' | 'never' = 'always') {
  return new SearchableSelect(['First', 'Second'], tui, () => theme, onSelect, () => {}, search)
}

describe('mouse selection in Harness dialogs', () => {
  it('selects and activates an option through the searchable selector', () => {
    const onSelect = vi.fn()
    const list = select(onSelect)
    list.render(56)
    const firstOptionRow = list.pinnedRows

    expect(list.handleMouse(mouse(firstOptionRow + 1))).toMatchObject({ handled: true })
    expect(list.handleMouse(mouse(firstOptionRow + 1, 'click'))).toMatchObject({ handled: true, render: true })
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('maps a click through the centered dialog frame to its option row', () => {
    const onSelect = vi.fn()
    const list = select(onSelect)
    const panel = new DialogPanel('Choose', list, () => theme, 'Enter choose · Esc cancel')
    panel.centered = true
    panel.maxRows = () => 19
    panel.render(64)

    expect(panel.handleMouse({ ...mouse(10, 'click'), x: 8, screenX: 8 })).toMatchObject({ handled: true, render: true })
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('supports mouse selection without adding a search row to simple confirmations', () => {
    const onSelect = vi.fn()
    const list = select(onSelect, 'never')
    list.render(56)

    expect(list.pinnedRows).toBe(0)
    expect(list.handleMouse(mouse(1, 'click'))).toMatchObject({ handled: true, render: true })
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})
