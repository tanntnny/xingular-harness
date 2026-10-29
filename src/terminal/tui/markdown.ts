// Markdown rendering for ANSI surfaces. The transcript uses OpenTUI's native markdown node; a
// pi-tui block, such as the `/btw` dock, renders the shared Markdown component through this module.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Markdown, stripTerminalSequences, type MarkdownTheme } from '@earendil-works/pi-tui'

/** The Harness markdown colours, mapped onto the component's callbacks. */
export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: text => theme.fg('mdHeading', text),
    link: text => theme.fg('mdLink', text),
    linkUrl: text => theme.fg('mdLinkUrl', text),
    code: text => theme.fg('mdCode', text),
    codeBlock: text => theme.fg('mdCodeBlock', text),
    codeBlockBorder: text => theme.fg('mdCodeBlockBorder', text),
    quote: text => theme.fg('mdQuote', text),
    quoteBorder: text => theme.fg('mdQuoteBorder', text),
    hr: text => theme.fg('mdHr', text),
    listBullet: text => theme.fg('mdListBullet', text),
    bold: text => theme.bold(text),
    italic: text => theme.italic(text),
    underline: text => theme.underline(text),
    strikethrough: text => theme.strikethrough(text),
    // A block surface has no syntax highlighter; its code keeps the theme's code colour.
    highlightCode: code => code.split('\n').map(line => theme.fg('mdCodeBlock', line))
  }
}

/** Model output as markdown source: terminal control sequences never reach the renderer. */
export function markdownSource(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, ' ')
}

/**
 * One surface's Markdown component. It re-renders only when the streamed text, the width or the
 * theme changes, and drops trailing blank rows so the caller frames the block itself.
 */
export class MarkdownBlock {
  private component: Markdown | undefined
  private theme: Theme | undefined
  private text = ''

  lines(text: string, width: number, theme: Theme): string[] {
    if (width < 1 || !text.trim()) return []
    if (!this.component || this.theme !== theme) {
      this.component = new Markdown('', 0, 0, markdownTheme(theme))
      this.theme = theme
      this.text = ''
    }
    if (this.text !== text) {
      this.component.setText(text)
      this.text = text
    }
    const lines = this.component.render(width)
    let end = lines.length
    while (end > 0 && !stripTerminalSequences(lines[end - 1]!).trim()) end -= 1
    return lines.slice(0, end)
  }
}
