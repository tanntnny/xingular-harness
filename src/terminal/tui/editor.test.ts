import { getSelectListTheme, initTheme, type KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, KeybindingsManager as TuiKeybindingsManager, renderFakeCursor, stripTerminalSequences, type TUI, type TuiMouseEvent, TUI_KEYBINDINGS, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { COMPOSER_SUGGESTIONS, type ComposerView, HarnessEditor } from './editor'
import { createHarnessTheme } from './theme'

initTheme('dark', false)
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const bandText = (width: number) => '[band]'.padEnd(width)
function setup(view: Partial<ComposerView> = {}) {
  const editor = new HarnessEditor({ terminal: { rows: 30 }, requestRender() {} } as unknown as TUI,
    { borderColor: (text) => text, selectList: getSelectListTheme() }, new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager, {
      band: (width) => bandText(width),
      theme: () => theme, placeholder: () => undefined, ...view
    })
  editor.focused = true
  return editor
}

describe('Claude-style composer frame over the native Pi editor', () => {
  it('frames the prompt between two full-width rules, with the band below', () => {
    const editor = setup()
    const rows = editor.render(40)
    expect(rows).toHaveLength(4)
    expect(stripTerminalSequences(rows[0])).toBe('─'.repeat(40))
    expect(rows[0]).toContain('38;2;136;136;136')
    expect(stripTerminalSequences(rows[1])).toMatch(/^❯ /)
    expect(rows[1]).toContain(CURSOR_MARKER)
    expect(stripTerminalSequences(rows[2])).toBe('─'.repeat(40))
    expect(stripTerminalSequences(rows[3]).trimEnd()).toBe('[band]')
    expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true)
    expect(editor.getText()).toBe('')
  })

  it('shows the suggestion as a fake cursor on its first character, only while focused', () => {
    const editor = setup({ placeholder: () => COMPOSER_SUGGESTIONS[0] })
    const rows = editor.render(60)
    expect(stripTerminalSequences(rows[1])).toContain('Try "fix the failing test"')
    expect(rows[1]).toContain(CURSOR_MARKER + renderFakeCursor('T'))
    editor.focused = false
    const idle = editor.render(60)[1]
    expect(idle).not.toContain(CURSOR_MARKER)
    expect(stripTerminalSequences(idle)).toContain('Try "fix the failing test"')
  })

  it('drops the suggestion as soon as there is a draft', () => {
    const editor = setup({ placeholder: () => 'fix the failing test' })
    editor.handleInput('h')
    const rows = editor.render(60)
    expect(editor.getText()).toBe('h')
    expect(stripTerminalSequences(rows[1])).toMatch(/^❯ h/)
    expect(stripTerminalSequences(rows[1])).not.toContain('Try')
  })

  it('does not render a shortcuts or thinking hint row', () => {
    const editor = setup()
    const rows = editor.render(80).map(stripTerminalSequences)
    expect(rows.join('\n')).not.toContain('? for shortcuts')
    expect(rows.join('\n')).not.toContain('to change thinking effort')
    editor.handleInput('x')
    expect(editor.render(80).map(stripTerminalSequences).join('\n')).not.toContain('to clear')
  })

  it('preserves editing, multiline wrapping, history, and cursor markers across resizes', () => {
    const editor = setup()
    const draft = 'Read 日本語 and compare the result'.repeat(3) + '\nSecond line'
    editor.setText(draft)
    for (const width of [120, 40, 10, 3, 1, 80]) {
      const rows = editor.render(width)
      expect(rows.every((row) => visibleWidth(row) <= width), `width ${width}`).toBe(true)
      expect(rows.join('')).not.toContain('\u0000')
      expect(rows.join('')).toContain(CURSOR_MARKER)
      expect(editor.getText()).toBe(draft)
    }
    editor.setText('')
    editor.handleInput('hello')
    expect(editor.getText()).toBe('hello')
    editor.addToHistory('previous prompt')
    editor.setText('')
    editor.handleInput('\x1b[A')
    expect(editor.getText()).toBe('previous prompt')
  })

  it('lists autocomplete above the composer with matching orange dividers and accepts a selection', async () => {
    const editor = setup()
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ items: [{ value: '/accounts', label: '/accounts' }, { value: '/plugins', label: '/plugins' }], prefix: '/' }),
      applyCompletion: (lines, line, _col, item) => ({ lines: lines.map((value, index) => index === line ? item.value : value), cursorLine: line, cursorCol: item.value.length })
    })
    editor.handleInput('/')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const rows = editor.render(50)
    const band = rows.findIndex((row) => stripTerminalSequences(row).startsWith('[band]'))
    const completion = rows.findIndex((row) => stripTerminalSequences(row).includes('/accounts'))
    const composerDivider = rows.findIndex((row, index) => index > completion && stripTerminalSequences(row) === '─'.repeat(50))
    expect(rows[0]).toContain('38;2;255;179;71')
    expect(rows[composerDivider]).toContain('38;2;136;136;136')
    expect(completion).toBeGreaterThan(0)
    expect(composerDivider).toBeGreaterThan(completion)
    expect(band).toBeGreaterThan(composerDivider)
    expect(rows.every((row) => visibleWidth(row) <= 50)).toBe(true)
    editor.handleInput('\t')
    expect(editor.getText()).toContain('/accounts')
  })

  it('does not hand the band row to the editor as its own', () => {
    const editor = setup()
    editor.render(40)
    const at = (y: number) => ({ x: 5, y, width: 40, height: 5 }) as TuiMouseEvent
    expect(editor.handleMouse(at(3))).toBeUndefined()
  })
})
