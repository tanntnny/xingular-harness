// The one list every screen uses: an optional search row, windowed rows with a `❯` marker and a
// full-width selected row like the slash-command list, group headings, and a status at the right.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { fuzzyFilter, matchesKey, parseColor, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import { safeText, selectedRow, selectionMuted, selectionText } from './chrome'
import { SEARCH_FIELD_ROWS, SearchField, searchFieldRowsFor } from './search'
import { isPrimaryClick, type TerminalMouseInput } from './mouse'

export type RowTone = 'success' | 'warning' | 'error' | 'muted' | 'dim' | 'accent'

export interface ListLabelPart {
  text: string
  color?: string
  tone?: RowTone
}

export interface ListRow<T = unknown> {
  id: string
  label: string
  /** Optional colored spans for the label; selected rows keep the shared high-contrast text. */
  labelParts?: readonly ListLabelPart[]
  /** Shown at the right edge, in `tone`. */
  detail?: string
  /** An optional muted second line beneath the label. */
  subtitle?: string
  tone?: RowTone
  /** Rows with the same consecutive group share a heading (not shown while searching). */
  group?: string
  searchText?: string
  /** Shown dim, skipped by the arrow keys, never activated. */
  disabled?: boolean
  data?: T
}

export interface FilterListOptions<T> {
  theme: () => Theme
  rows?: readonly ListRow<T>[]
  /** Search is visible by default; use `never` only for a fixed, non-searchable choice list. */
  search?: 'always' | 'never'
  /** Rows the list may use; the search field is part of it. Defaults to what `render` is given. */
  limit?: () => number
  /** Blank lines between visible rows. */
  rowGap?: number
  empty?: string
  noun?: readonly [string, string]
  /** Short context included in the search row while a query is active. */
  searchContext?: (query: string) => string | undefined
  onActivate?: (row: ListRow<T>) => void
  /** Space, while the search is empty. */
  onToggle?: (row: ListRow<T>) => void
  onCancel?: () => void
}

interface Entry<T> { row?: ListRow<T>; heading?: string; spacer?: true }

export class FilterList<T = unknown> implements Component, Focusable {
  private rows: ListRow<T>[]
  private visible: ListRow<T>[]
  private selectedId: string | undefined
  private focusedValue = false
  private renderedSearchRows = SEARCH_FIELD_ROWS
  private renderedRows: (ListRow<T> | undefined)[] = []
  private readonly search: SearchField

  constructor(private readonly options: FilterListOptions<T>) {
    this.search = new SearchField(options.theme)
    this.rows = [...(options.rows ?? [])]
    this.visible = this.rows
    this.selectedId = this.firstSelectable()?.id
  }

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value }
  get query(): string { return this.search.value }
  get selected(): ListRow<T> | undefined { return this.visible.find(row => row.id === this.selectedId) }
  get total(): number { return this.rows.length }
  get shown(): number { return this.visible.length }
  /** Rows the list would use if nothing cut it: the search field, headings and rows. */
  get height(): number {
    return (this.searchVisible() ? this.renderedSearchRows : 0)
      + this.entries().reduce((height, entry) => height + (entry.row?.subtitle === undefined ? 1 : 2), 0)
  }
  /** Rows at the top of `render` that a frame must keep when it has to cut the list. */
  get pinnedRows(): number { return this.searchVisible() ? this.renderedSearchRows : 0 }

  setRows(rows: readonly ListRow<T>[]): void {
    this.rows = [...rows]
    this.refilter()
  }

  /** Searches for `text` as if it had been typed. */
  setQuery(text: string): void {
    this.search.setValue(text)
    this.refilter()
  }

  select(id: string): void {
    if (this.visible.some(row => row.id === id)) this.selectedId = id
  }

  /** Selects the row at a rendered line, and activates it on a primary click. */
  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    if (!Number.isInteger(event.y) || event.y < 0) return undefined
    const row = this.renderedRows[event.y]
    if (!row || row.disabled) return undefined
    const changed = this.selectedId !== row.id
    this.selectedId = row.id
    const activate = isPrimaryClick(event)
    if (activate) {
      if (this.options.onActivate) this.options.onActivate(row)
      else this.options.onToggle?.(row)
    }
    return { handled: true, render: changed || activate }
  }

  invalidate(): void { this.search.invalidate() }

  private limit(): number { return Math.max(1, Math.floor(this.options.limit?.() ?? Number.POSITIVE_INFINITY)) }
  private rowGap(): number {
    const gap = this.options.rowGap ?? 0
    return Number.isFinite(gap) ? Math.max(0, Math.floor(gap)) : 0
  }
  private mode(): 'always' | 'never' { return this.options.search ?? 'always' }
  private canSearch(): boolean { return this.mode() === 'always' }
  private searchVisible(): boolean { return this.canSearch() || this.query.length > 0 }
  private firstSelectable(): ListRow<T> | undefined { return this.visible.find(row => !row.disabled) }

  private refilter(): void {
    const query = this.query.trim()
    this.visible = query
      ? fuzzyFilter(this.rows, query, row => row.searchText ?? `${row.label} ${row.subtitle ?? ''} ${row.detail ?? ''} ${row.group ?? ''}`)
      : this.rows
    if (!this.visible.some(row => row.id === this.selectedId && !row.disabled)) this.selectedId = this.firstSelectable()?.id
  }

  private move(delta: number): void {
    const selectable = this.visible.filter(row => !row.disabled)
    if (!selectable.length) return
    const at = Math.max(0, selectable.findIndex(row => row.id === this.selectedId))
    this.selectedId = selectable[Math.max(0, Math.min(selectable.length - 1, at + delta))]!.id
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'escape')) {
      if (this.search.clear()) { this.refilter(); return true }
      this.options.onCancel?.()
      return Boolean(this.options.onCancel)
    }
    if (matchesKey(data, 'up')) { this.move(-1); return true }
    if (matchesKey(data, 'down')) { this.move(1); return true }
    if (matchesKey(data, 'pageUp')) { this.move(-Math.max(1, this.limit() - 1)); return true }
    if (matchesKey(data, 'pageDown')) { this.move(Math.max(1, this.limit() - 1)); return true }
    if (matchesKey(data, 'home')) { this.move(-this.visible.length); return true }
    if (matchesKey(data, 'end')) { this.move(this.visible.length); return true }
    if (matchesKey(data, 'enter')) {
      const row = this.selected
      if (row && !row.disabled) this.options.onActivate?.(row)
      return true
    }
    if (data === ' ' && !this.query && this.options.onToggle) {
      const row = this.selected
      if (row && !row.disabled) this.options.onToggle(row)
      return true
    }
    if (!this.canSearch() && !this.query) return false
    if (this.search.handleInput(data)) { this.refilter(); return true }
    return false
  }

  private entries(): Entry<T>[] {
    const entries: Entry<T>[] = []
    let last: string | undefined
    const gap = this.rowGap()
    for (const [index, row] of this.visible.entries()) {
      if (!this.query && row.group && row.group !== last) entries.push({ heading: row.group })
      last = row.group
      entries.push({ row })
      if (index < this.visible.length - 1) {
        for (let line = 0; line < gap; line += 1) entries.push({ spacer: true })
      }
    }
    return entries
  }

  private lines(row: ListRow<T>, width: number): string[] {
    const theme = this.options.theme()
    const selected = row.id === this.selectedId
    const detail = row.detail ? safeText(row.detail) : ''
    const room = width - 2
    const showDetail = detail && room >= visibleWidth(detail) + 6
    const label = truncateToWidth(safeText(row.label), Math.max(0, room - (showDetail ? visibleWidth(detail) + 2 : 0)), '…')
    const gap = ' '.repeat(Math.max(0, room - visibleWidth(label) - (showDetail ? visibleWidth(detail) : 0)))
    const tone = (text: string) => theme.fg(row.tone ?? 'muted', text)
    const prefix = selected ? '❯ ' : '  '
    const labelText = selected || row.disabled || !row.labelParts?.length ? label : this.labelParts(row.labelParts, label, theme)
    const main = prefix + label
    const primary = selected
      ? selectedRow(selectionText(theme, main) + gap + (showDetail ? selectionMuted(theme, detail) : ''), width, theme)
      : (row.disabled ? theme.fg('dim', main) : prefix + labelText) + gap + (showDetail ? tone(detail) : '')
    if (row.subtitle === undefined) return [primary]
    const subtitle = truncateToWidth(`  ${safeText(row.subtitle)}`, width, '…')
    const secondary = selected
      ? selectedRow(selectionMuted(theme, subtitle), width, theme)
      : theme.fg(row.disabled ? 'dim' : 'muted', subtitle)
    return [primary, secondary]
  }

  private labelParts(parts: readonly ListLabelPart[], visibleLabel: string, theme: Theme): string {
    const source = parts.map(part => safeText(part.text)).join('')
    const truncated = visibleWidth(source) > visibleWidth(visibleLabel)
    let remaining = Math.max(0, visibleWidth(visibleLabel) - (truncated ? 1 : 0))
    const output: string[] = []
    for (const part of parts) {
      if (remaining <= 0) break
      const text = safeText(part.text)
      const fitted = truncateToWidth(text, remaining, '')
      if (fitted) {
        output.push(part.color ? theme.style(fitted, { fg: parseColor(part.color) }) : part.tone ? theme.fg(part.tone, fitted) : fitted)
      }
      remaining -= visibleWidth(fitted)
      if (visibleWidth(fitted) < visibleWidth(text)) break
    }
    if (truncated) output.push('…')
    return output.join('')
  }

  /** `rows` is the most the list may use, the search row included. */
  render(width: number, rows?: number): string[] {
    this.renderedRows = []
    if (width < 1) return []
    const theme = this.options.theme()
    const searching = this.searchVisible()
    const rowBudget = Math.floor(rows ?? this.limit())
    this.renderedSearchRows = searching ? searchFieldRowsFor(rowBudget) : 0
    this.search.focused = this.focusedValue && searching
    const lines: string[] = []
    if (searching) {
      const [one, many] = this.options.noun ?? ['option', 'options']
      const count = this.query ? `${this.shown} of ${this.total}` : `${this.total} ${this.total === 1 ? one : many}`
      const context = this.query ? this.options.searchContext?.(this.query.trim()) : undefined
      const note = context ? `${count} · ${context}` : count
      const searchLines = this.search.renderLines(width, note, this.renderedSearchRows)
      lines.push(...searchLines)
      this.renderedRows.push(...searchLines.map(() => undefined))
    }
    const budget = Math.max(1, rowBudget - lines.length)
    const entries = this.entries()
    if (!entries.length) {
      lines.push(theme.fg('dim', this.query ? 'No matches' : this.options.empty ?? 'Nothing to show'))
      this.renderedRows.push(undefined)
      return lines.map(line => truncateToWidth(line, width, ''))
    }
    const at = Math.max(0, entries.findIndex(entry => entry.row?.id === this.selectedId))
    let start = at
    let end = at + 1
    let used = entries[at]?.row?.subtitle === undefined ? 1 : 2
    let preferBefore = true
    while (start > 0 || end < entries.length) {
      const before = entries[start - 1]
      const after = entries[end]
      const beforeHeight = before ? (before.row?.subtitle === undefined ? 1 : 2) : Number.POSITIVE_INFINITY
      const afterHeight = after ? (after.row?.subtitle === undefined ? 1 : 2) : Number.POSITIVE_INFINITY
      if (preferBefore && before && used + beforeHeight <= budget) {
        start -= 1
        used += beforeHeight
      } else if (after && used + afterHeight <= budget) {
        end += 1
        used += afterHeight
      } else if (before && used + beforeHeight <= budget) {
        start -= 1
        used += beforeHeight
      } else break
      preferBefore = !preferBefore
    }
    if (entries[start]?.spacer) start += 1
    if (entries[end - 1]?.spacer) end -= 1
    for (const entry of entries.slice(start, end)) {
      if (entry.row) {
        const rendered = this.lines(entry.row, width)
        lines.push(...rendered)
        this.renderedRows.push(...rendered.map(() => entry.row))
      } else if (entry.spacer) {
        lines.push('')
        this.renderedRows.push(undefined)
      } else {
        lines.push(theme.fg('dim', safeText(entry.heading ?? '')))
        this.renderedRows.push(undefined)
      }
    }
    this.renderedRows = this.renderedRows.slice(0, rowBudget)
    return lines.slice(0, rowBudget).map(line => truncateToWidth(line, width, ''))
  }
}
