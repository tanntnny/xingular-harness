// A read-only, scrollable page of text: a variant diff, a refinement candidate, its output.
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'

export class TextPage implements TerminalPage {
  readonly presentation = 'fullscreen' as const
  private offset = 0
  private rows = 20

  constructor(private readonly title: string, private readonly text: string, private readonly changed: () => void = () => {}) {}

  tabs(): readonly TabInfo[] {
    return [{ id: 'text', title: this.title }]
  }

  activeTab(): string {
    return 'text'
  }

  private lines(width: number): string[] {
    return this.text.split('\n').flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(10, width)) : ['']))
  }

  render(width: number, rows: number): string[] {
    this.rows = Math.max(1, rows)
    const lines = this.lines(width)
    this.offset = Math.max(0, Math.min(this.offset, lines.length - this.rows))
    return lines.slice(this.offset, this.offset + this.rows).map((line) => truncateToWidth(line, width))
  }

  handleInput(data: string): boolean {
    const page = Math.max(1, this.rows - 1)
    if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down')) this.offset += 1
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - page)
    else if (matchesKey(data, 'pageDown') || data === ' ') this.offset += page
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = Number.MAX_SAFE_INTEGER
    else return false
    this.changed()
    return true
  }

  hint(): string {
    return '↑↓ PgUp/PgDn scroll'
  }
}
