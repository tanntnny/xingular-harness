// Harness owns composer geometry and actions; Pi provides the editing primitive.
import { CustomEditor, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, type EditorTheme, type TUI, type TuiMouseEvent, parseColor, renderFakeCursor, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { composerRuleColor } from './theme'

const BOTTOM = '\u0000harness-composer-bottom'

// Generic on purpose: the placeholder names no file, project or product.
export const COMPOSER_SUGGESTIONS = [
  'fix the failing test',
  'explain how this project is laid out',
  'find where the configuration is loaded',
  'summarize what changed since the last commit',
  'write a test for the next change'
]

export interface ComposerView {
  band(width: number, hiddenAbove: number, hiddenBelow: number): string
  theme(): Theme
  placeholder(): string | undefined
  showHint(): boolean
  clearKey: string
  thinkingKey: string
}

export class HarnessEditor extends CustomEditor {
  private hiddenAbove = 0
  private hiddenBelow = 0
  private contentRows = 1
  private gutterWidth = 2

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly view: ComposerView) {
    super(tui, theme, keybindings, { paddingX: 0 })
  }

  override setPaddingX(_padding: number): void {
    super.setPaddingX(0)
  }

  protected override renderTopBorder(_width: number, hiddenLineCount: number): string {
    this.hiddenAbove = hiddenLineCount
    return ''
  }

  protected override renderBottomBorder(_width: number, hiddenLineCount: number): string {
    this.hiddenBelow = hiddenLineCount
    return BOTTOM
  }

  override render(width: number): string[] {
    if (width < 1) return []
    this.gutterWidth = Math.min(2, Math.max(0, width - 1))
    const innerWidth = Math.max(1, width - this.gutterWidth)
    // Pi 1.2 cannot lay out a two-cell grapheme in a one-cell text area.
    // Lay out safely, then clip the presentation without changing the draft.
    const rows = super.render(Math.max(3, innerWidth))
    const bottom = rows.indexOf(BOTTOM)
    const content = rows.slice(1, bottom)
    this.contentRows = content.length
    const theme = this.view.theme()
    const placeholder = this.getText() === '' ? this.view.placeholder() : undefined
    const prompt = content.map((line, index) => {
      const cue = theme.fg('dim', index === 0 ? '❯ '.slice(0, this.gutterWidth) : ' '.repeat(this.gutterWidth))
      if (index === 0 && placeholder) return cue + this.placeholderRow(placeholder, innerWidth, theme)
      return cue + line
    })
    const completions = rows.slice(bottom + 1).map((line) => ' '.repeat(this.gutterWidth) + line)
    const result = [
      this.rule(width, theme), ...prompt, this.rule(width, theme), this.footer(width, theme),
      this.view.band(width, this.hiddenAbove, this.hiddenBelow), ...completions
    ].map((line) => truncateToWidth(line, width, ''))
    if (this.focused && !result.some((line) => line.includes(CURSOR_MARKER))) {
      const index = Math.max(1, Math.min(result.length - 1, prompt.length))
      result[index] = truncateToWidth(result[index], Math.max(0, width - 1), '') + CURSOR_MARKER + ' '
    }
    return result
  }

  private rule(width: number, theme: Theme): string {
    return theme.style('─'.repeat(width), { fg: parseColor(composerRuleColor(theme)) })
  }

  private placeholderRow(suggestion: string, innerWidth: number, theme: Theme): string {
    const text = truncateToWidth(`Try "${suggestion}"`, innerWidth, '')
    if (!this.focused) return theme.fg('dim', text)
    // The first character is the fake cursor, so an empty prompt reads as the caret it will type into.
    const [first = '', ...rest] = Array.from(text)
    return CURSOR_MARKER + renderFakeCursor(first) + theme.fg('dim', rest.join(''))
  }

  private footer(width: number, theme: Theme): string {
    const empty = this.getText() === ''
    const left = theme.fg('dim', empty ? '? for shortcuts' : `${this.view.clearKey} to clear`)
    const right = empty && this.view.showHint()
      ? theme.fg('accent', this.view.thinkingKey) + ' ' + theme.italic(theme.fg('dim', 'to change thinking effort'))
      : ''
    const gap = width - this.gutterWidth - visibleWidth(left) - visibleWidth(right)
    return truncateToWidth(' '.repeat(this.gutterWidth) + left + (right && gap >= 1 ? ' '.repeat(gap) + right : ''), width, '')
  }

  override handleMouse(event: TuiMouseEvent) {
    // Pi sees only its own rules, prompt rows and completions. The footer and band rows sit between them.
    const footer = this.contentRows + 2
    if (event.y >= footer && event.y <= footer + 1) return undefined
    return super.handleMouse({
      ...event,
      x: event.x - this.gutterWidth,
      y: event.y > footer + 1 ? event.y - 2 : event.y,
      width: Math.max(1, event.width - this.gutterWidth)
    })
  }
}
