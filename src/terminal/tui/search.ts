// The one search field every list uses. It sits under the title or tab strip and takes only text;
// the keys a screen owns stay with the screen.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, visibleWidth, type KeyId } from '@earendil-works/pi-tui'

import { MouseSafeInput } from './mouseReport'

export const SEARCH_GLYPH = '⌕'
export const SEARCH_PLACEHOLDER = 'Type to search'
export const SEARCH_FIELD_ROWS = 5

export function searchFieldRowsFor(availableRows: number): number {
  const fieldRoom = Math.max(0, Math.floor(availableRows) - 1)
  if (fieldRoom >= SEARCH_FIELD_ROWS) return SEARCH_FIELD_ROWS
  return fieldRoom >= 3 ? 3 : 1
}

const SCREEN_KEYS: KeyId[] = ['left', 'right', 'up', 'down', 'enter', 'tab', 'shift+tab', 'escape', 'pageUp', 'pageDown', 'home', 'end']

export class SearchField {
  private readonly input: MouseSafeInput

  constructor(private readonly theme: () => Theme, placeholder = SEARCH_PLACEHOLDER) {
    this.input = new MouseSafeInput({ prompt: '', placeholder, placeholderStyle: text => this.theme().fg('dim', text) })
  }

  get value(): string { return this.input.getValue() }
  set focused(value: boolean) { this.input.focused = value }

  /** Presets the text, for a command that was given something to search for. */
  setValue(text: string): void { this.input.setValue(text) }

  /** Empties the field; says whether there was anything to empty. */
  clear(): boolean {
    if (!this.value) return false
    this.input.setValue('')
    return true
  }

  /** Takes typed text, paste, Backspace and Ctrl+U. Says whether the text changed. */
  handleInput(data: string): boolean {
    if (SCREEN_KEYS.some(key => matchesKey(data, key))) return false
    const before = this.value
    this.input.handleInput(data)
    return this.value !== before
  }

  invalidate(): void { this.input.invalidate() }

  /** One row, `width` cells: the glyph, the text or placeholder, and `note` at the right edge. */
  render(width: number, note = ''): string {
    if (width < 1) return ''
    const theme = this.theme()
    const glyph = theme.fg('text', `${SEARCH_GLYPH} `)
    const room = Math.max(0, width - visibleWidth(glyph))
    const shownNote = note && room > visibleWidth(note) + 8 ? note : ''
    const field = this.input.render(Math.max(1, room - (shownNote ? visibleWidth(shownNote) + 1 : 0)))[0] ?? ''
    return truncateToWidth(glyph + field + (shownNote ? ' ' + theme.fg('muted', shownNote) : ''), width, '')
  }

  renderLines(width: number, note = '', rows = SEARCH_FIELD_ROWS): string[] {
    if (width < 1) return []
    if (rows < 3) return [this.render(width, note)]
    const rule = this.theme().fg('border', '─'.repeat(width))
    return rows >= SEARCH_FIELD_ROWS
      ? ['', rule, this.render(width, note), rule, '']
      : [rule, this.render(width, note), rule]
  }
}
