import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { SEARCH_GLYPH, SearchField } from './search'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const field = () => { const value = new SearchField(() => theme); value.focused = true; return value }

describe('the shared search field', () => {
  it('shows the glyph and placeholder when empty and the typed text afterwards', () => {
    const search = field()
    expect(stripTerminalSequences(search.render(40))).toContain(`${SEARCH_GLYPH} `)
    expect(stripTerminalSequences(search.render(40))).toContain('Type to search')
    expect(search.handleInput('ab')).toBe(true)
    expect(search.value).toBe('ab')
    expect(stripTerminalSequences(search.render(40))).not.toContain('Type to search')
  })

  it('never takes the keys a screen owns, as text or as cursor moves', () => {
    const search = field()
    search.handleInput('abc')
    for (const key of ['\x1b[D', '\x1b[C', '\x1b[A', '\x1b[B', '\r', '\t', '\x1b[Z', '\x1b', '\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F']) {
      expect(search.handleInput(key), JSON.stringify(key)).toBe(false)
    }
    expect(search.value).toBe('abc')
  })

  it('deletes with Backspace, clears with Ctrl+U and clear(), and accepts a paste', () => {
    const search = field()
    search.handleInput('abc')
    expect(search.handleInput('\x7f')).toBe(true)
    expect(search.value).toBe('ab')
    expect(search.handleInput('\x15')).toBe(true)
    expect(search.value).toBe('')
    search.handleInput('\x1b[200~pasted text\x1b[201~')
    expect(search.value).toBe('pasted text')
    expect(search.clear()).toBe(true)
    expect(search.clear()).toBe(false)
  })

  it('puts the note at the right edge, drops it when it would crowd the text, and never overflows', () => {
    const search = field()
    const row = stripTerminalSequences(search.render(60, '12 options'))
    expect(row).toHaveLength(60)
    expect(row.endsWith('12 options')).toBe(true)
    expect(stripTerminalSequences(search.render(14, '12 options'))).not.toContain('12 options')
    for (let width = 0; width <= 80; width++) expect(visibleWidth(search.render(width, '12 of 40')), `width ${width}`).toBeLessThanOrEqual(width)
    expect(search.render(0)).toBe('')
  })
})
