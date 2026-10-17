import type { Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { SettingsPanel, type TerminalSettingItem } from './settings'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const items: TerminalSettingItem[] = [
  { id: 'theme', tab: 'appearance', group: 'Theme', label: 'Dark Theme', value: 'Titanium', description: 'Theme used with dark terminal backgrounds.' },
  { id: 'composer', tab: 'appearance', group: 'Composer', label: 'Composer Shape', value: 'Band', description: 'Choose the terminal input layout.' },
  { id: 'expanded', tab: 'appearance', group: 'Display', label: 'Expand Tool Output', value: 'Off', description: 'Expand actual output from tools.' },
  { id: 'thinking', tab: 'model', group: 'Thinking', label: 'Thinking Level', value: 'High', description: 'Control reasoning effort for the current model.' },
  { id: 'input', tab: 'interaction', group: 'Input', label: 'Autocomplete', value: 'On' },
  { id: 'compact', tab: 'context', group: 'Compaction', label: 'Auto Compact', value: 'On', description: 'Compact the context when the supported token threshold is reached.' }
]
function setup(initialId?: string, rows = 30, source = items) {
  const terminal = { rows }
  const done = vi.fn()
  const panel = new SettingsPanel({ terminal } as unknown as TUI, () => theme, source, done, initialId)
  panel.focused = true
  return { panel, done, terminal }
}
const plain = (panel: SettingsPanel, width = 100) => panel.render(width).map(stripTerminalSequences)

describe('the supported settings terminal panel', () => {
  it('fills the terminal with the upstream rounded settings frame, supported tabs and group rail', () => {
    const { panel } = setup()
    const rows = plain(panel)
    expect(rows).toHaveLength(30)
    expect(rows[0]).toMatch(/^╭─ Settings /)
    expect(rows[0]).toMatch(/╮$/)
    expect(rows.at(-1)).toMatch(/^╰─.*╯$/)
    expect(rows[1]).toContain('🎨 Appearance')
    expect(rows[1]).toContain('Model')
    expect(rows[1]).toContain('Interaction')
    expect(rows[1]).toContain('Context')
    expect(rows.join('\n')).not.toMatch(/Providers|Advisor|Preview:|Tasks|Memory/)
    expect(rows.some(row => row.includes('│   Theme') && row.slice(25).includes('│'))).toBe(true)
    expect(rows.join('\n')).toContain('❯ Dark Theme')
    expect(rows.join('\n')).toContain('Titanium')
    expect(rows.join('\n')).toContain('Theme used with dark terminal backgrounds.')
    expect(panel.render(100).join('')).toContain(theme.getBgAnsi('selectedBg'))
    const compactTabs = plain(panel, 40)[1]
    for (const icon of ['🎨', '🤖', '⌨', '📋']) expect(compactTabs).toContain(icon)
  })

  it('uses flat rows at 80 columns and a section rail only when the value pane fits', () => {
    const { panel } = setup()
    const narrow = plain(panel, 80).find(row => row.includes('❯ Dark Theme'))!
    const wide = plain(panel, 100).find(row => row.includes('❯ Dark Theme'))!
    expect(narrow.match(/│/g)).toHaveLength(2)
    expect(wide.match(/│/g)).toHaveLength(3)
  })

  it('moves through tabs and items and resolves only an actual selected setting id', () => {
    const { panel, done } = setup()
    panel.handleInput('\x1b[B')
    expect(panel.selectedId).toBe('composer')
    panel.handleInput('\r')
    expect(done).toHaveBeenLastCalledWith('composer')
    panel.handleInput('\x1b[C')
    expect(panel.selectedId).toBe('thinking')
    panel.handleInput(' ')
    expect(done).toHaveBeenLastCalledWith('thinking')
    panel.handleInput('\x1b[D')
    expect(panel.selectedId).toBe('composer')
    panel.handleInput('\x1b')
    expect(done).toHaveBeenLastCalledWith(undefined)
  })

  it('moves group focus through the rail and returns to item editing without triggering an action', () => {
    const { panel, done } = setup()
    panel.handleInput('\t')
    panel.handleInput('\x1b[B')
    expect(panel.selectedId).toBe('composer')
    expect(plain(panel).join('\n')).toContain('❯ Composer')
    panel.handleInput('\r')
    expect(done).not.toHaveBeenCalled()
    panel.handleInput('\r')
    expect(done).toHaveBeenCalledWith('composer')
  })

  it('restores the last selected tab, group and item from initialId', () => {
    const { panel } = setup('compact')
    expect(panel.selectedId).toBe('compact')
    expect(plain(panel)[1]).toContain('Context')
    expect(plain(panel).join('\n')).toContain('❯ Auto Compact')
    expect(plain(panel).join('\n')).not.toContain('Dark Theme')
    expect(setup('missing').panel.selectedId).toBe('theme')
  })

  it('searches across supported tabs using labels, values and descriptions with a visible cursor', () => {
    const { panel, done } = setup()
    panel.handleInput('reasoning')
    const rows = plain(panel).join('\n')
    expect(rows).toContain('1 match')
    expect(rows).toContain('Thinking Level')
    expect(rows).not.toContain('Dark Theme')
    expect(panel.render(100).join('')).toContain(CURSOR_MARKER)
    panel.handleInput('\r')
    expect(done).toHaveBeenCalledWith('thinking')
    panel.handleInput('\x1b')
    expect(done).toHaveBeenLastCalledWith(undefined)
  })

  it('renders explicit empty search results and never selects a hidden item', () => {
    const { panel, done } = setup()
    panel.handleInput('zzzzzzzzzzz')
    expect(plain(panel).join('\n')).toContain('No matching settings')
    expect(panel.selectedId).toBeUndefined()
    panel.handleInput('\r')
    panel.handleInput(' ')
    expect(done).not.toHaveBeenCalled()
    panel.handleInput('\x7f')
    expect(panel.selectedId).toBeUndefined()
  })

  it('keeps the selected setting visible as lists grow and the terminal resizes', () => {
    const source = Array.from({ length: 100 }, (_, index) => ({ id: `item${index}`, tab: 'appearance', group: 'Display', label: `Setting ${index}`, value: String(index) }))
    const { panel, terminal } = setup('item85', 20, source)
    for (const height of [40, 20, 10, 7]) {
      terminal.rows = height
      expect(plain(panel).join('\n'), `height ${height}`).toContain('❯ Setting 85')
      expect(panel.render(80)).toHaveLength(height)
    }
    expect(panel.selectedId).toBe('item85')
  })

  it('bounds every row and terminal height for narrow Unicode labels and descriptions', () => {
    const source = [{ id: 'cjk', tab: 'appearance', group: '日本語 🧠', label: '知識設定 日本語', value: '🧠 有効', description: '日本語の説明を長く表示します。'.repeat(20) }]
    const { panel, terminal } = setup('cjk', 30, source)
    for (const height of [0, 1, 3, 6, 10, 20, 40]) {
      terminal.rows = height
      for (let width = 0; width <= 130; width++) {
        const rows = panel.render(width)
        expect(rows.length, `${width}x${height}`).toBeLessThanOrEqual(height)
        for (const row of rows) expect(visibleWidth(row), `${width}x${height}`).toBeLessThanOrEqual(width)
      }
    }
    expect(panel.selectedId).toBe('cjk')
  })

  it('does not expose unsupported categories or mutate caller setting data', () => {
    const source = Object.freeze([...items, Object.freeze({ id: 'fake', tab: 'tasks', group: 'Agents', label: 'Invented feature', value: 'Off' })])
    const { panel } = setup(undefined, 30, source as unknown as TerminalSettingItem[])
    expect(plain(panel).join('\n')).not.toContain('Invented feature')
    expect(source[0].value).toBe('Titanium')
  })
})
