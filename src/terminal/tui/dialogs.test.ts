import type { Theme } from '@earendil-works/pi-coding-agent'
import { Input, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { DialogPanel, SearchableSelect, SecretInput } from './dialogs'
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
  it('accepts bracketed paste in a centered input dialog', () => {
    const input = new Input({ prompt: '> ', placeholder: 'Paste a value' })
    const panel = new DialogPanel('API key', input, () => theme, 'Enter submit · Esc cancel')
    panel.centered = true

    panel.handleInput('\x1b[200~pasted-api-key\x1b[201~')

    expect(input.getValue()).toBe('pasted-api-key')
  })

  it('masks text pasted into a secret dialog input', () => {
    const value = 'connection-secret'
    const input = new SecretInput({ placeholder: 'Paste a value' })
    const panel = new DialogPanel('Credential', input, () => theme, 'Enter submit · Esc cancel')
    panel.centered = true

    panel.handleInput(`\x1b[200~${value}\x1b[201~`)

    const rendered = panel.render(64).join('\n')
    expect(input.getValue()).toBe(value)
    expect(rendered).not.toContain(value)
    expect(rendered).toContain('•'.repeat(value.length))
  })

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

  it('scrolls complete approval details inside a bounded dialog', () => {
    const list = new SearchableSelect(['Allow once', 'Deny'], tui, () => theme, () => {}, () => {}, 'never')
    const details = ['PageUp/PageDown scrolls the complete approval details.', '', ...Array.from({ length: 32 }, (_, index) => `command section ${index + 1}`), 'COMMAND-TAIL']
    const panel = new DialogPanel('Approve workspace-write?', list, () => theme, 'Enter choose · Esc deny', details.join('\n'))
    panel.centered = true
    panel.maxRows = () => 19

    expect(panel.render(64).join('\n')).toContain('PageUp/PageDown')
    expect(panel.render(64).join('\n')).not.toContain('COMMAND-TAIL')
    panel.handleInput('\x1b[6~')
    panel.handleInput('\x1b[6~')
    panel.handleInput('\x1b[6~')
    expect(panel.render(64).join('\n')).toContain('COMMAND-TAIL')
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
