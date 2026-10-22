import type { Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { createHarnessTheme } from '../theme'
import { SEARCH_FIELD_ROWS } from '../search'
import { SettingsPage, type TerminalSettingItem } from './settingsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const items: TerminalSettingItem[] = [
  { id: 'theme', tab: 'appearance', group: 'Theme', label: 'Dark Theme', value: 'Titanium', description: 'Theme used with dark terminal backgrounds.' },
  { id: 'composer', tab: 'appearance', group: 'Composer', label: 'Composer Shape', value: 'Band', description: 'Choose the terminal input layout.' },
  { id: 'expanded', tab: 'appearance', group: 'Display', label: 'Expand Tool Output', value: 'Off', description: 'Expand actual output from tools.' },
  { id: 'thinking', tab: 'model', group: 'Thinking', label: 'Thinking Level', value: 'High', description: 'Control reasoning effort for the current model.' },
  { id: 'input', tab: 'interaction', group: 'Input', label: 'Autocomplete', value: 'On' },
  { id: 'compact', tab: 'context', group: 'Compaction', label: 'Auto Compact', value: 'On', description: 'Compact the context when the supported token threshold is reached.' }
]

function setup(source = items, apply = vi.fn(async (_id: string) => {})) {
  let current = source
  const notify = vi.fn()
  const changed = vi.fn()
  const page = new SettingsPage({ theme: () => theme, items: () => current, apply, notify, changed })
  page.focused = true
  return { page, apply, notify, changed, set: (next: TerminalSettingItem[]) => { current = next } }
}
const plain = (page: SettingsPage, width = 80, rows = 24) => page.render(width, rows).map(stripTerminalSequences)

describe('the Settings page', () => {
  it('shows the search row, then the category strip, grouped rows with values at the right, and the description', () => {
    const { page } = setup()
    const rows = plain(page)
    expect(rows.some(row => row.includes('Type to search') && row.includes('3 settings'))).toBe(true)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Appearance', 'Model', 'Interaction', 'Context'])
    expect(rows.some(row => row === 'Theme')).toBe(true)
    expect(rows).toContain('Theme')
    expect(rows.some(row => row.startsWith('❯ Dark Theme') && row.endsWith('Titanium'))).toBe(true)
    expect(rows.join('\n')).toContain('Theme used with dark terminal backgrounds.')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
    expect(rows.join('\n')).not.toMatch(/Providers|Advisor|Tasks|Memory/)
  })

  it('changes category with Tab and Shift+Tab, wrapping, and leaves ←/→ without changing the page section', () => {
    const { page } = setup()
    expect(page.handleInput('\t')).toBe(true)
    expect(plain(page).join('\n')).toContain('❯ Thinking Level')
    page.handleInput('\t'); page.handleInput('\t')
    expect(plain(page).join('\n')).toContain('❯ Auto Compact')
    page.handleInput('\t')
    expect(plain(page).join('\n')).toContain('❯ Dark Theme')
    page.handleInput('\x1b[Z')
    expect(plain(page).join('\n')).toContain('❯ Auto Compact')
    expect(page.handleInput('\x1b[C')).toBe(false)
    expect(page.handleInput('\x1b[D')).toBe(false)
  })

  it('applies the selected setting with Enter and reads the values again afterwards', async () => {
    const { page, apply, set, changed } = setup()
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    expect(apply).toHaveBeenCalledWith('composer')
    set(items.map(item => item.id === 'composer' ? { ...item, value: 'Plain' } : item))
    await vi.waitFor(() => expect(plain(page).some(row => row.startsWith('❯ Composer Shape') && row.endsWith('Plain'))).toBe(true))
    expect(changed).toHaveBeenCalled()
  })

  it('reports a failed change instead of throwing', async () => {
    const { page, notify } = setup(items, vi.fn(async () => { throw new Error('Unknown theme') }))
    page.handleInput('\r')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Unknown theme', 'error'))
  })

  it('searches every category by label, value and description, with a visible cursor', () => {
    const { page, apply } = setup()
    page.handleInput('reasoning')
    const rows = plain(page)
    expect(rows.some(row => row.includes('1 of 6 · every category'))).toBe(true)
    expect(rows).not.toContain('Searching every category')
    expect(rows.join('\n')).toContain('Thinking Level')
    expect(rows.join('\n')).not.toContain('Dark Theme')
    expect(page.render(100, 24).join('')).toContain(CURSOR_MARKER)
    page.handleInput('\r')
    expect(apply).toHaveBeenCalledWith('thinking')
  })

  it('clears the search with Escape before the overlay may close, and shows an empty result plainly', () => {
    const { page, apply } = setup()
    page.handleInput('zzzzzzzzzzz')
    expect(plain(page).join('\n')).toContain('No matches')
    page.handleInput('\r')
    expect(apply).not.toHaveBeenCalled()
    expect(page.handleInput('\x1b')).toBe(true)
    expect(plain(page).join('\n')).toContain('❯ Dark Theme')
    expect(page.handleInput('\x1b')).toBe(false)
  })

  it('keeps the selected setting visible as the list grows and the height shrinks', () => {
    const source = Array.from({ length: 100 }, (_, index) => ({ id: `item${index}`, tab: 'appearance', group: 'Display', label: `Setting ${index}`, value: String(index) }))
    const { page } = setup(source)
    for (let index = 0; index < 85; index++) page.handleInput('\x1b[B')
    for (const rows of [40, 20, 10, 7]) {
      expect(plain(page, 80, rows).join('\n'), `rows ${rows}`).toContain('❯ Setting 85')
      expect(page.render(80, rows).length).toBeLessThanOrEqual(rows)
    }
  })

  it('bounds every row for narrow Unicode labels and descriptions', () => {
    const source = [{ id: 'cjk', tab: 'appearance', group: '日本語 🧠', label: '知識設定 日本語', value: '🧠 有効', description: '日本語の説明を長く表示します。'.repeat(20) }]
    const { page } = setup(source)
    for (const rows of [0, 1, 3, 6, 10, 20, 40]) {
      for (let width = 0; width <= 130; width++) {
        const lines = page.render(width, rows)
        expect(lines.length, `${width}x${rows}`).toBeLessThanOrEqual(rows)
        for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('does not list unsupported categories or change the caller data', () => {
    const source = Object.freeze([...items, Object.freeze({ id: 'fake', tab: 'tasks', group: 'Agents', label: 'Invented feature', value: 'Off' })])
    const { page } = setup(source as unknown as TerminalSettingItem[])
    expect(plain(page).join('\n')).not.toContain('Invented feature')
    page.handleInput('Invented feature')
    expect(plain(page).join('\n')).not.toContain('Invented feature\n')
    expect(plain(page).slice(SEARCH_FIELD_ROWS).join('\n')).not.toContain('Invented feature')
    expect(source[0]!.value).toBe('Titanium')
  })
})
