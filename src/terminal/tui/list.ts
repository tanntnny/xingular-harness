// The one list every screen uses: an optional search row, windowed rows with a `❯` marker and a
// full-width selected row like the slash-command list, group headings, and a status at the right.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import { safeText, selectedRow, selectionMuted, selectionText } from './chrome'
import { SEARCH_FIELD_ROWS, SearchField, searchFieldRowsFor } from './search'
import { isPrimaryClick, type TerminalMouseInput } from './mouse'

export type RowTone = 'success' | 'warning' | 'error' | 'muted' | 'dim' | 'accent'

export interface ListRow<T = unknown> {
  id: string
  label: string
  /** Shown at the right edge, in `tone`. */
  detail?: string
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
  empty?: string
  noun?: readonly [string, string]
  /** Short context included in the search row while a query is active. */
  searchContext?: (query: string) => string | undefined
  onActivate?: (row: ListRow<T>) => void
  /** Space, while the search is empty. */
  onToggle?: (row: ListRow<T>) => void
  onCancel?: () => void
}

interface Entry<T> { row?: ListRow<T>; heading?: string }

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
  get height(): number { return (this.searchVisible() ? this.renderedSearchRows : 0) + this.entries().length }
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
  private mode(): 'always' | 'never' { return this.options.search ?? 'always' }
  private canSearch(): boolean { return this.mode() === 'always' }
  private searchVisible(): boolean { return this.canSearch() || this.query.length > 0 }
  private firstSelectable(): ListRow<T> | undefined { return this.visible.find(row => !row.disabled) }

  private refilter(): void {
    const query = this.query.trim()
    this.visible = query
      ? fuzzyFilter(this.rows, query, row => row.searchText ?? `${row.label} ${row.detail ?? ''} ${row.group ?? ''}`)
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
    for (const row of this.visible) {
      if (!this.query && row.group && row.group !== last) entries.push({ heading: row.group })
      last = row.group
      entries.push({ row })
    }
    return entries
  }

  private line(row: ListRow<T>, width: number): string {
    const theme = this.options.theme()
    const selected = row.id === this.selectedId
    const detail = row.detail ? safeText(row.detail) : ''
    const room = width - 2
    const showDetail = detail && room >= visibleWidth(detail) + 6
    const label = truncateToWidth(safeText(row.label), Math.max(0, room - (showDetail ? visibleWidth(detail) + 2 : 0)), '…')
    const gap = ' '.repeat(Math.max(0, room - visibleWidth(label) - (showDetail ? visibleWidth(detail) : 0)))
    const tone = (text: string) => theme.fg(row.tone ?? 'muted', text)
    const main = (selected ? '❯ ' : '  ') + label
    if (selected) return selectedRow(selectionText(theme, main) + gap + (showDetail ? selectionMuted(theme, detail) : ''), width, theme)
    return (row.disabled ? theme.fg('dim', main) : main) + gap + (showDetail ? tone(detail) : '')
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
    const start = Math.max(0, Math.min(Math.max(0, entries.length - budget), at - Math.floor(budget / 2)))
    for (const entry of entries.slice(start, start + budget)) {
      lines.push(entry.row ? this.line(entry.row, width) : theme.fg('dim', safeText(entry.heading ?? '')))
      this.renderedRows.push(entry.row)
    }
    return lines.map(line => truncateToWidth(line, width, ''))
  }
}
