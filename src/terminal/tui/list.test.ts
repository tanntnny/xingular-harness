import type { Theme } from '@earendil-works/pi-coding-agent'
import { parseColor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { FilterList, type ListRow } from './list'
import type { TerminalMouseInput } from './mouse'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const rows = (count: number, extra: Partial<ListRow> = {}): ListRow[] => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, label: `Row ${index}`, ...extra }))
const plain = (list: FilterList<unknown>, width = 40, height?: number) => list.render(width, height).map(stripTerminalSequences)
const mouse = (y: number, type: 'move' | 'click' = 'move'): TerminalMouseInput => ({
  type, button: type === 'click' ? 'left' : 'none', x: 0, y, screenX: 0, screenY: y,
  width: 40, height: 20, shift: false, alt: false, ctrl: false
})
const make = (source: ListRow[], options: Partial<ConstructorParameters<typeof FilterList>[0]> = {}) => {
  const list = new FilterList({ theme: () => theme, rows: source, ...options })
  list.focused = true
  return list
}

describe('the shared filter list', () => {
  it('marks the selected row, fills its width with the selection background and moves with the arrows', () => {
    const list = make(rows(3), { search: 'never' })
    expect(plain(list)).toEqual(['❯ Row 0', '  Row 1', '  Row 2'].map(line => expect.stringContaining(line)))
    expect(list.render(40)[0]).toContain(theme.getBgAnsi('selectedBg'))
    expect(visibleWidth(stripTerminalSequences(list.render(40)[0]!))).toBe(40)
    list.handleInput('\x1b[B')
    expect(list.selected?.id).toBe('r1')
    list.handleInput('\x1b[B'); list.handleInput('\x1b[B')
    expect(list.selected?.id).toBe('r2')
    list.handleInput('\x1b[H')
    expect(list.selected?.id).toBe('r0')
    list.handleInput('\x1b[F')
    expect(list.selected?.id).toBe('r2')
  })

  it('renders optional muted subtitles as full-width second lines and maps pointer rows back to sessions', () => {
    const onActivate = vi.fn()
    const list = make([
      { id: 'first', label: 'First session', subtitle: '3 minutes ago · project:main · 5.1MB' },
      { id: 'second', label: 'Second session', subtitle: '1 hour ago · project:feature · 8.0KB' }
    ], { search: 'never', onActivate })
    const rendered = list.render(50, 4)

    expect(list.height).toBe(4)
    expect(rendered).toHaveLength(4)
    expect(stripTerminalSequences(rendered[0]!)).toContain('❯ First session')
    expect(stripTerminalSequences(rendered[1]!)).toContain('3 minutes ago · project:main · 5.1MB')
    expect(rendered[0]).toContain(theme.getBgAnsi('selectedBg'))
    expect(rendered[1]).toContain(theme.getBgAnsi('selectedBg'))
    expect(rendered[3]).toContain(theme.fg('muted', '  1 hour ago · project:feature · 8.0KB'))
    expect(list.handleMouse(mouse(3, 'click'))).toMatchObject({ handled: true, render: true })
    expect(list.selected?.id).toBe('second')
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'second' }))
  })

  it('adds row gaps without making spacer lines selectable or breaking click mapping', () => {
    const onActivate = vi.fn()
    const list = make([
      { id: 'first', label: 'First session', subtitle: '3 minutes ago · project:main · 5.1MB' },
      { id: 'second', label: 'Second session', subtitle: '1 hour ago · project:feature · 8.0KB' }
    ], { search: 'never', rowGap: 1, onActivate })
    const rendered = plain(list, 50, 5)

    expect(list.height).toBe(5)
    expect(rendered).toHaveLength(5)
    expect(rendered[0]).toContain('First session')
    expect(rendered[1]).toContain('3 minutes ago')
    expect(rendered[2]).toBe('')
    expect(rendered[3]).toContain('Second session')
    expect(rendered[4]).toContain('1 hour ago')
    expect(list.handleMouse(mouse(2, 'click'))).toBeUndefined()
    expect(list.selected?.id).toBe('first')
    expect(onActivate).not.toHaveBeenCalled()
    expect(list.handleMouse(mouse(3, 'click'))).toMatchObject({ handled: true, render: true })
    expect(list.selected?.id).toBe('second')
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'second' }))
  })

  it('colors label spans while selected rows retain high-contrast text and truncation', () => {
    const color = '#00ff88'
    const list = make([
      { id: 'selected', label: '✓ Agent  Title', labelParts: [{ text: '✓ ', tone: 'success' }, { text: 'Agent', color }, { text: '  Title' }] },
      { id: 'other', label: '✓ Agent  A much longer title', labelParts: [{ text: '✓ ', tone: 'success' }, { text: 'Agent', color }, { text: '  A much longer title' }] }
    ], { search: 'never' })
    const rows = list.render(18)
    const coloredAgent = theme.style('Agent', { fg: parseColor(color) })

    expect(rows[0]).not.toContain(coloredAgent)
    expect(rows[1]).toContain(coloredAgent)
    for (let width = 1; width <= 40; width += 1) {
      expect(visibleWidth(stripTerminalSequences(list.render(width)[1]!)), `width ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it('right-aligns a status and drops it before it crowds the label', () => {
    const list = make([{ id: 'a', label: 'Work', detail: 'Ready', tone: 'success' }], { search: 'never' })
    const wide = plain(list, 40)[0]!
    expect(wide.startsWith('❯ Work')).toBe(true)
    expect(wide.endsWith('Ready')).toBe(true)
    expect(plain(list, 9)[0]).not.toContain('Ready')
  })

  it('shows the search row when the rows do not fit, counts matches and filters as you type', () => {
    const list = make(rows(30), { limit: () => 8 })
    const first = plain(list, 40, 9)
    expect(first.some(line => line.includes('Type to search') && line.includes('30 options'))).toBe(true)
    expect(first).toHaveLength(9)
    list.handleInput('Row 2')
    expect(list.shown).toBeGreaterThan(0)
    expect(list.shown).toBeLessThan(30)
    expect(plain(list, 40, 9).some(line => line.includes(`${list.shown} of 30`))).toBe(true)
    expect(plain(list, 40, 9).slice(list.pinnedRows).every(line => /Row 2/.test(line))).toBe(true)
    list.handleInput('zzzz')
    expect(plain(list).at(-1)).toContain('No matches')
  })

  it('keeps the search row visible for a short list unless search is explicitly disabled', () => {
    expect(plain(make(rows(3), { limit: () => 8 })).some(line => line.includes('Type to search'))).toBe(true)
    const hidden = make(rows(3), { search: 'never' })
    expect(plain(hidden)[0]).toContain('Row 0')
    expect(hidden.handleInput('x')).toBe(false)
    expect(hidden.pinnedRows).toBe(0)
    expect(make(rows(3)).pinnedRows).toBe(5)
  })

  it('clears a search with Escape first and only then cancels', () => {
    const onCancel = vi.fn()
    const list = make(rows(3), { search: 'always', onCancel })
    list.handleInput('Row 1')
    expect(list.handleInput('\x1b')).toBe(true)
    expect(list.query).toBe('')
    expect(onCancel).not.toHaveBeenCalled()
    list.handleInput('\x1b')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('selects and activates the row under the pointer, ignoring headings and disabled rows', () => {
    const onActivate = vi.fn()
    const list = make([
      { id: 'a', label: 'Alpha', group: 'Choices' },
      { id: 'b', label: 'Beta', group: 'Choices', disabled: true },
      { id: 'c', label: 'Gamma', group: 'Other' }
    ], { search: 'never', onActivate })
    list.render(40)

    expect(list.handleMouse(mouse(0))).toBeUndefined()
    expect(list.handleMouse(mouse(1))).toMatchObject({ handled: true, render: false })
    expect(list.selected?.id).toBe('a')
    expect(list.handleMouse(mouse(2))).toBeUndefined()
    expect(list.handleMouse(mouse(4, 'click'))).toMatchObject({ handled: true, render: true })
    expect(list.selected?.id).toBe('c')
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
    expect(list.handleMouse(mouse(-1, 'click'))).toBeUndefined()
  })

  it('maps pointer rows after the pinned search field and activates a toggle row', () => {
    const onToggle = vi.fn()
    const list = make(rows(3), { onToggle })
    list.render(40, 8)

    expect(list.handleMouse(mouse(list.pinnedRows))).toMatchObject({ handled: true })
    expect(list.selected?.id).toBe('r0')
    expect(list.handleMouse(mouse(list.pinnedRows + 1, 'click'))).toMatchObject({ handled: true, render: true })
    expect(list.selected?.id).toBe('r1')
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
  })

  it('activates the selected row with Enter, toggles with Space only while the search is empty, and skips disabled rows', () => {
    const onActivate = vi.fn()
    const onToggle = vi.fn()
    const list = make([{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', disabled: true }, { id: 'c', label: 'Gamma' }], { search: 'always', onActivate, onToggle })
    list.handleInput('\x1b[B')
    expect(list.selected?.id).toBe('c')
    list.handleInput('\r')
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
    list.handleInput(' ')
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
    list.handleInput('g')
    list.handleInput(' ')
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(list.query).toBe('g ')
  })

  it('draws a heading for each group, hides them while searching, and keeps the selection when rows change', () => {
    const list = make([{ id: 'a', label: 'One', group: 'Theme' }, { id: 'b', label: 'Two', group: 'Theme' }, { id: 'c', label: 'Three', group: 'Display' }], { search: 'always' })
    const shown = plain(list, 40)
    expect(shown.filter(line => line === 'Theme' || line === 'Display')).toHaveLength(2)
    list.handleInput('\x1b[B'); list.handleInput('\x1b[B')
    list.setRows([{ id: 'c', label: 'Three', group: 'Display' }, { id: 'a', label: 'One', group: 'Theme' }])
    expect(list.selected?.id).toBe('c')
    list.handleInput('Th')
    expect(plain(list, 40).some(line => line === 'Theme' || line === 'Display')).toBe(false)
  })

  it('never writes past the width, including wide glyphs, and says when it is empty', () => {
    const list = make([{ id: 'a', label: '中文のラベル 🧠', detail: '日本語', group: '見出し' }], { search: 'always' })
    for (let width = 0; width <= 60; width++) for (const line of list.render(width, 6)) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width)
    expect(make([], { search: 'never', empty: 'No accounts yet' }).render(30).map(stripTerminalSequences)).toEqual(['No accounts yet'])
  })
})
