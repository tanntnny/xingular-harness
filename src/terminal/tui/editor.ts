// Harness owns composer geometry and actions; Pi provides the editing primitive.
import { CustomEditor, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, type EditorTheme, type TUI, type TuiMouseEvent, parseColor, renderFakeCursor, truncateToWidth } from '@earendil-works/pi-tui'

import { autocompleteRuleColor, composerRuleColor } from './theme'

const BOTTOM = '\u0000harness-composer-bottom'

// Generic on purpose: the placeholder names no file, project or product.
export const COMPOSER_SUGGESTIONS = [
  'fix the failing test',
  'explain how this project is laid out',
  'find where the configuration is loaded',
  'summarize what changed since the last commit',
  'write a test for the next change'
]

function leadingSlashCommand(text: string, validCommands: ReadonlySet<string>): string | null {
  const match = /^\s*\/([^\s/]+)(?=\s|$)/u.exec(text)
  if (!match || !validCommands.has(match[1]!)) return null
  return '/' + match[1]
}

export interface ComposerView {
  band(width: number, hiddenAbove: number, hiddenBelow: number): string
  theme(): Theme
  placeholder(): string | undefined
}

export class HarnessEditor extends CustomEditor {
  private hiddenAbove = 0
  private hiddenBelow = 0
  private contentRows = 1
  private completionRows = 0
  private gutterWidth = 2
  private validCommands = new Set<string>()

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly view: ComposerView) {
    super(tui, theme, keybindings, { paddingX: 0 })
  }

  setValidCommands(commands: readonly string[]): void {
    this.validCommands = new Set(commands)
    this.tui.requestRender()
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
    const command = leadingSlashCommand(this.getText(), this.validCommands)
    const commandLine = command ? content.findIndex(line => line.includes(command)) : -1
    const prompt = content.map((line, index) => {
      const cue = theme.fg('dim', index === 0 ? '❯ '.slice(0, this.gutterWidth) : ' '.repeat(this.gutterWidth))
      if (index === 0 && placeholder) return cue + this.placeholderRow(placeholder, innerWidth, theme)
      const renderedLine = index === commandLine && command ? line.replace(command, theme.fg('mdLink', command)) : line
      return cue + renderedLine
    })
    const completions = rows.slice(bottom + 1).map((line) => ' '.repeat(this.gutterWidth) + line)
    this.completionRows = completions.length
    const completionDivider = completions.length > 0 ? [this.rule(width, theme, autocompleteRuleColor(theme))] : []
    const result = [
      ...completionDivider, ...completions,
      this.rule(width, theme), ...prompt, this.rule(width, theme), this.view.band(width, this.hiddenAbove, this.hiddenBelow)
    ].map((line) => truncateToWidth(line, width, ''))
    if (this.focused && !result.some((line) => line.includes(CURSOR_MARKER))) {
      const composerOffset = completions.length > 0 ? completions.length + 1 : 0
      const index = composerOffset + Math.max(1, Math.min(result.length - composerOffset - 1, prompt.length))
      result[index] = truncateToWidth(result[index], Math.max(0, width - 1), '') + CURSOR_MARKER + ' '
    }
    return result
  }

  private rule(width: number, theme: Theme, color = composerRuleColor(theme)): string {
    return theme.style('─'.repeat(width), { fg: parseColor(color) })
  }

  private placeholderRow(suggestion: string, innerWidth: number, theme: Theme): string {
    const text = truncateToWidth(`Try "${suggestion}"`, innerWidth, '')
    if (!this.focused) return theme.fg('dim', text)
    // The first character is the fake cursor, so an empty prompt reads as the caret it will type into.
    const [first = '', ...rest] = Array.from(text)
    return CURSOR_MARKER + renderFakeCursor(first) + theme.fg('dim', rest.join(''))
  }

  override handleMouse(event: TuiMouseEvent) {
    // Pi sees its own rows; the suggestion divider and status band are presentation rows.
    const composerOffset = this.completionRows > 0 ? this.completionRows + 1 : 0
    const band = composerOffset + this.contentRows + 2
    if (event.y === band) return undefined
    if (this.completionRows > 0 && event.y === 0) return undefined
    const y = this.completionRows > 0 && event.y <= this.completionRows
      ? this.contentRows + 1 + event.y
      : event.y - composerOffset
    return super.handleMouse({
      ...event,
      x: event.x - this.gutterWidth,
      y,
      width: Math.max(1, event.width - this.gutterWidth)
    })
  }
}
