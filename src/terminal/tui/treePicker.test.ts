import type { SessionEntry, SessionTreeNode, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { TreePicker } from './treePicker'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const at = '2026-10-18T00:00:00.000Z'
const message = (id: string, parentId: string | null, role: string, text: string): SessionEntry => ({
  type: 'message', id, parentId, timestamp: at, message: { role, content: [{ type: 'text', text }] }
}) as unknown as SessionEntry
const tree: SessionTreeNode[] = [{
  entry: message('u1', null, 'user', 'start here'), children: [{
    entry: message('a1', 'u1', 'assistant', 'hello there'), children: [
      { entry: message('u2', 'a1', 'user', 'branch A question'), children: [] },
      { entry: message('u3', 'a1', 'user', 'branch B question'), children: [{
        entry: message('a3', 'u3', 'assistant', 'answer B'), children: []
      }] }
    ]
  }]
}]

function setup(rows = 24, extra: Partial<ConstructorParameters<typeof TreePicker>[0]> = {}) {
  const select = vi.fn()
  const cancel = vi.fn()
  const copy = vi.fn()
  const labelChanged = vi.fn()
  const changed = vi.fn()
  const editLabel = vi.fn(async () => 'Important')
  const picker = new TreePicker({
    theme: () => theme, tui: { terminal: { rows } } as unknown as TUI,
    matches: (data, action) => data === ({ 'app.message.copy': 'copy', 'app.tree.editLabel': 'label', 'app.tree.filter.cycleForward': 'cycle' } as Record<string, string>)[action],
    tree, currentLeafId: 'a3', select, cancel, copy, editLabel, labelChanged, changed, ...extra
  })
  picker.focused = true
  return { picker, select, cancel, copy, editLabel, labelChanged, changed }
}
const plain = (picker: TreePicker, width = 80) => picker.render(width).map(stripTerminalSequences)

describe('the tree picker', () => {
  it('uses the shared search row and filter strip, highlights the selected row across the list, and fits narrow terminals', () => {
    const { picker } = setup()
    const rows = plain(picker)
    expect(rows.some(row => row.includes('Type to search'))).toBe(true)
    expect(rows.some(row => row.includes('Default'))).toBe(true)
    const selected = rows.findIndex(row => row.includes('❯'))
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(picker.render(80)[selected]).toContain(theme.getBgAnsi('selectedBg'))
    expect(picker.render(80)[selected]).not.toContain(theme.getFgAnsi('accent'))
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯]/)
    for (let width = 0; width <= 120; width++) {
      const lines = picker.render(width)
      expect(lines.length).toBeLessThanOrEqual(24)
      for (const line of lines) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width)
    }
    picker.dispose()
  })

  it('fits its content inside a padded dialog for a host that centers pages', () => {
    const { picker } = setup(24, { tui: { terminal: { columns: 80, rows: 24 }, centeredDialogs: true } as unknown as TUI })
    const rows = plain(picker, 64)
    expect(rows.length).toBeLessThan(19)
    expect(rows.slice(0, 2)).toEqual(Array(2).fill(''))
    expect(rows[2]).toMatch(/^ {4}Session tree +Esc$/)
    expect(rows[3]).toBe('')
    expect(rows.slice(-2)).toEqual(Array(2).fill(''))
    expect(rows.join('\n')).not.toContain('↑/↓ move')
    expect(rows.filter(row => /─{10}/.test(row))).toHaveLength(2)
    picker.dispose()
  })

  it('filters entries with the standard query, clears before cancel, and selects the remaining row', () => {
    const first = setup()
    first.picker.handleInput('branch b')
    expect(first.picker.state.rows.map(row => row.node.entry.id)).toEqual(['u3'])
    first.picker.handleInput('\x1b')
    expect(first.picker.state.searchQuery).toBe('')
    first.picker.handleInput('branch b')
    first.picker.handleInput('\r')
    expect(first.select).toHaveBeenCalledWith('u3')
    first.picker.dispose()

    const second = setup()
    second.picker.handleInput('answer')
    second.picker.handleInput('\x1b')
    expect(second.cancel).not.toHaveBeenCalled()
    second.picker.handleInput('\x1b')
    expect(second.cancel).toHaveBeenCalledOnce()
  })

  it('forwards copy and label actions and applies the five-mode filter cycle', async () => {
    const { picker, copy, editLabel, labelChanged } = setup()
    picker.handleInput('copy')
    expect(copy).toHaveBeenCalledWith('answer B')
    picker.handleInput('label')
    await vi.waitFor(() => expect(labelChanged).toHaveBeenCalledWith('a3', 'Important'))
    expect(editLabel).toHaveBeenCalledWith('a3', undefined)
    picker.handleInput('cycle')
    expect(picker.state.filterMode).toBe('no-tools')
    picker.handleInput('cycle')
    expect(picker.state.filterMode).toBe('user-only')
    picker.dispose()
  })

  it('uses Left and Right to navigate the filter tabs', () => {
    const { picker } = setup(24, { tui: { terminal: { columns: 80, rows: 24 }, centeredDialogs: true } as unknown as TUI })
    expect(picker.state.filterMode).toBe('default')
    picker.handleInput('\x1b[C')
    expect(picker.state.filterMode).toBe('no-tools')
    picker.handleInput('\x1b[D')
    expect(picker.state.filterMode).toBe('default')
    picker.dispose()
  })
})
