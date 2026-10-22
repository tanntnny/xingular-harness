import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { CENTER_DIALOG_PAD, CENTER_DIALOG_VERTICAL_PAD, CHROME_ROWS, blockFrame, centerDialogFrame, pageBodyRows, pageFrame, selectedRow, selectionText } from './chrome'
import { SELECTION_COLORS } from './selection'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const plain = (lines: string[]) => lines.map(stripTerminalSequences)
const BOX = /[╭╮╰╯│├┤┌┐└┘]/

describe('terminal surface chrome', () => {
  it('fills selected rows to their width with the shared high-contrast foreground', () => {
    const line = selectedRow(selectionText(theme, '❯ Active'), 30, theme)
    expect(plain([line])).toEqual(['❯ Active'.padEnd(30)])
    expect(line).toContain(theme.getBgAnsi('selectedBg'))
    expect(line).toContain('\x1b[38;2;244;248;255m')
    expect(line).not.toContain(theme.getFgAnsi('accent'))
    expect(SELECTION_COLORS.dark.background).toBe('#1b314d')
  })

  it('frames a block like the slash-command list: an amber rule, a title row, the body, a hint, a neutral rule', () => {
    const lines = blockFrame({ title: 'Approve bash?', meta: '12s', body: ['❯ Allow once', '  Deny'], footer: 'Enter choose · Esc deny', width: 60, theme })
    const rows = plain(lines)
    expect(rows).toHaveLength(2 + CHROME_ROWS)
    expect(rows[0]).toBe('─'.repeat(60))
    expect(rows[1]).toMatch(/^ {2}Approve bash\? +12s$/)
    expect(rows[1]).toHaveLength(58)
    expect(rows[2]).toBe('  ❯ Allow once')
    expect(rows.at(-2)).toBe('  Enter choose · Esc deny')
    expect(rows.at(-1)).toBe('─'.repeat(60))
    expect(lines[0]).toContain(theme.getFgAnsi('warning'))
    expect(lines.at(-1)).toContain(theme.getFgAnsi('dim'))
    expect(rows.join('\n')).not.toMatch(BOX)
  })

  it('fills a page to the terminal height with a header, rules and a footer', () => {
    const lines = pageFrame({ title: 'Settings', body: ['one', 'two'], footer: 'Esc close', width: 40, rows: 12, theme })
    const rows = plain(lines)
    expect(rows).toHaveLength(12)
    expect(rows[0]).toMatch(/^ {2}Settings\s*$/)
    expect(rows[1]).toBe('─'.repeat(40))
    expect(rows[2]).toBe('  one')
    expect(rows[3]).toBe('  two')
    expect(rows.at(-2)).toBe('─'.repeat(40))
    expect(rows.at(-1)).toBe('  Esc close')
    expect(rows.join('\n')).not.toMatch(BOX)
    expect(pageBodyRows(12)).toBe(8)
  })

  it('frames a centered dialog with four-cell insets, a plain title, muted Esc and no rules or footer', () => {
    const lines = centerDialogFrame({ title: 'Settings', body: ['Search', 'Choice'], width: 40, rows: 16, theme })
    const rows = plain(lines)
    expect(rows).toHaveLength(8)
    expect(rows.slice(0, 2)).toEqual(['', ''])
    expect(rows[2]).toMatch(/^ {4}Settings +Esc$/)
    expect(rows[3]).toBe('')
    expect(rows[4]).toBe('    Search')
    expect(rows[5]).toBe('    Choice')
    expect(rows.slice(6)).toEqual(['', ''])
    expect(rows.join('\n')).not.toMatch(/[─╭╮╰╯│├┤]/)
    expect(lines[2]).toContain(theme.getFgAnsi('muted'))
    expect(CENTER_DIALOG_PAD).toBe(4)
    expect(CENTER_DIALOG_VERTICAL_PAD).toBe(2)
  })

  it('drops body rows that do not fit instead of growing past the terminal', () => {
    const rows = plain(pageFrame({ title: 'Logs', body: Array.from({ length: 50 }, (_, index) => `line ${index}`), footer: 'Esc', width: 30, rows: 10, theme }))
    expect(rows).toHaveLength(10)
    expect(rows[2]).toBe('  line 0')
    expect(rows[7]).toBe('  line 5')
    expect(rows.at(-1)).toBe('  Esc')
  })

  it('never writes past the width, including wide glyphs, and returns nothing when there is no room', () => {
    for (let width = 0; width <= 120; width++) {
      const block = blockFrame({ title: '中文のタイトル 🧠', meta: '99s', body: ['日本語 🧠 row'], footer: '↑/↓ select · Enter confirm', width, theme })
      const page = pageFrame({ title: '中文のタイトル 🧠', meta: '1/2', body: ['日本語 🧠 row'], footer: '↑/↓ select · Enter confirm', width, rows: 9, theme })
      for (const row of [...block, ...page]) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
      if (width < 1) { expect(block).toEqual([]); expect(page).toEqual([]) }
    }
    expect(pageFrame({ title: 'x', body: [], footer: 'x', width: 20, rows: 0, theme })).toEqual([])
  })

  it('strips terminal control sequences from titles and hints', () => {
    const rows = plain(blockFrame({ title: 'Title\x1b[31m\x07red', body: [], footer: 'hint\x1b]0;owned\x07', width: 40, theme }))
    expect(rows.join('\n')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
    expect(rows[1]).toContain('Title')
  })
})
