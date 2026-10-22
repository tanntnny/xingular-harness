/**
 * The `/tree` page: the session's branches as a tree, searched in the standard place, filtered by
 * entry kind, folded by branch, labelled and copied. Enter goes to the selected entry; what
 * follows (summarising the branch left behind) is the command's.
 */
import type { SessionTreeNode, Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'

import { centerDialogChromeRows, centerDialogContentWidth, centerDialogFrame, contentWidth, pageFrame, safeText, selectedRow, selectionText, tabStrip } from './chrome'
import { centeredDialogHost, dialogFits, pageRows } from './dialogGeometry'
import { SearchField, searchFieldRowsFor } from './search'
import { TREE_FILTER_MODES, TreeModel, type FlatNode, type TreeFilterMode } from './treeModel'

const GUTTER = 2
const MIN_ANCHOR_CONTENT = 4
const MAX_ANCHOR_CONTENT = 20
const MIN_ANCHOR_CONTEXT = 2
const MAX_ANCHOR_CONTEXT = 12

const FILTER_TITLES: Record<TreeFilterMode, string> = {
  default: 'Default', 'no-tools': 'No tools', 'user-only': 'User only', 'labeled-only': 'Labeled', all: 'All'
}
const FILTERS = TREE_FILTER_MODES.map(id => ({ id, title: FILTER_TITLES[id] }))

export interface TreePickerOptions {
  theme: () => Theme
  tui: TUI
  /** Whether a key press is one of the named application actions, such as `app.tree.foldOrUp`. */
  matches(data: string, action: string): boolean
  tree: SessionTreeNode[]
  currentLeafId: string | null
  initialFilterMode?: TreeFilterMode
  select(entryId: string): void
  cancel(): void
  copy(text: string): void
  /** Asks for a label; `undefined` means the person backed out, an empty string removes the label. */
  editLabel(entryId: string, current: string | undefined): Promise<string | undefined>
  /** Records a label change in the session. */
  labelChanged(entryId: string, label: string | undefined): void
  changed(): void
}

interface Row { gutter: string; body: string; anchor: number; width: number; selected: boolean }

/** Keeps the gutter in view and pans the bodies only as far as needed to show the selected row's text. */
function viewport(rows: Row[], width: number, theme: Theme): string[] {
  const room = Math.max(0, width - GUTTER)
  const widest = rows.reduce((most, row) => Math.max(most, row.width), 0)
  const maxScroll = Math.max(0, widest - room)
  const selected = rows.find(row => row.selected)
  let scroll = 0
  if (selected && maxScroll > 0) {
    const needed = Math.min(MAX_ANCHOR_CONTENT, Math.max(MIN_ANCHOR_CONTENT, Math.floor(room / 3)))
    if (selected.anchor > room - needed) {
      const context = Math.min(MAX_ANCHOR_CONTEXT, Math.max(MIN_ANCHOR_CONTEXT, Math.floor(room / 4)))
      scroll = Math.min(maxScroll, selected.anchor - context)
    }
  }
  return rows.map(row => {
    const line = scroll > 0 ? `${row.gutter}${sliceByColumn(row.body, scroll, room, true)}\x1b[0m` : row.gutter + row.body
    return row.selected ? selectedRow(line, width, theme) : truncateToWidth(line, width, '')
  })
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()} ${time}`
  return `${String(date.getFullYear()).slice(-2)}/${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export class TreePicker implements Component, Focusable {
  private readonly model: TreeModel
  private readonly search: SearchField
  private focusedValue = false
  private editing = false
  private closed = false

  constructor(private readonly options: TreePickerOptions) {
    this.model = new TreeModel(options.tree, options.currentLeafId, undefined, options.initialFilterMode)
    this.search = new SearchField(options.theme)
    // A conversation with nothing in it has nothing to navigate.
    if (!options.tree.length) setTimeout(() => this.cancel(), 100).unref?.()
  }

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value; this.search.focused = value }
  get state(): TreeModel { return this.model }

  invalidate(): void { this.search.invalidate() }
  dispose(): void { this.closed = true }

  private cancel(): void {
    if (this.closed) return
    this.closed = true
    this.options.cancel()
  }

  private async editLabel(): Promise<void> {
    const node = this.model.selectedNode
    if (!node || this.editing) return
    this.editing = true
    try {
      const value = await this.options.editLabel(node.entry.id, node.label)
      if (value === undefined || this.closed) return
      const label = value.trim() || undefined
      this.model.setLabel(node.entry.id, label)
      this.options.labelChanged(node.entry.id, label)
    } finally {
      this.editing = false
      this.options.changed()
    }
  }

  handleInput(data: string): void {
    const { matches } = this.options
    const model = this.model
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    if (this.editing) return
    if (matchesKey(data, 'ctrl+c')) { this.cancel(); return }
    if (matchesKey(data, 'escape')) {
      if (this.search.clear()) model.setSearch('')
      else this.cancel()
    } else if (matchesKey(data, 'up')) model.move(-1)
    else if (matchesKey(data, 'down')) model.move(1)
    else if (matches(data, 'app.tree.foldOrUp')) model.foldOrUp()
    else if (matches(data, 'app.tree.unfoldOrDown')) model.unfoldOrDown()
    else if (matchesKey(data, 'left') && centered) model.cycleFilter(-1)
    else if (matchesKey(data, 'right') && centered) model.cycleFilter(1)
    else if (matchesKey(data, 'pageUp')) model.move(-this.listRows())
    else if (matchesKey(data, 'pageDown')) model.move(this.listRows())
    else if (matchesKey(data, 'home')) model.move(-model.rows.length)
    else if (matchesKey(data, 'end')) model.move(model.rows.length)
    else if (matchesKey(data, 'enter')) {
      const node = model.selectedNode
      if (node) this.options.select(node.entry.id)
      return
    } else if (matches(data, 'app.message.copy')) {
      const text = model.copyText()
      if (text) this.options.copy(text)
    } else if (matches(data, 'app.tree.filter.default')) model.setFilter('default')
    else if (matches(data, 'app.tree.filter.noTools')) model.toggleFilter('no-tools')
    else if (matches(data, 'app.tree.filter.userOnly')) model.toggleFilter('user-only')
    else if (matches(data, 'app.tree.filter.labeledOnly')) model.toggleFilter('labeled-only')
    else if (matches(data, 'app.tree.filter.all')) model.toggleFilter('all')
    else if (matches(data, 'app.tree.filter.cycleForward')) model.cycleFilter(1)
    else if (matches(data, 'app.tree.filter.cycleBackward')) model.cycleFilter(-1)
    else if (matches(data, 'app.tree.editLabel')) { void this.editLabel(); return }
    else if (matches(data, 'app.tree.toggleLabelTimestamp')) model.showLabelTimestamps = !model.showLabelTimestamps
    else if (this.search.handleInput(data)) model.setSearch(this.search.value)
    else return
    this.options.changed()
  }

  private searchRows(): number {
    const rows = pageRows(this.options.tui)
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const chromeRows = centered ? centerDialogChromeRows(rows) : 4
    return searchFieldRowsFor(rows - chromeRows - 1)
  }

  /** Rows the list can show: the page (or dialog), less the frame, the search field and filter strip. */
  private listRows(): number {
    const rows = pageRows(this.options.tui)
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    return Math.max(1, rows - (centered ? centerDialogChromeRows(rows) : 4) - this.searchRows() - 1)
  }

  private prefix(flat: FlatNode, entryId: string): string {
    const model = this.model
    const indent = model.roots ? Math.max(0, flat.indent - 1) : flat.indent
    const connector = flat.showConnector && !flat.isVirtualRootChild
    const connectorLevel = connector ? indent - 1 : -1
    const chars: string[] = []
    for (let i = 0; i < indent * 3; i++) {
      const level = Math.floor(i / 3)
      const place = i % 3
      const gutter = flat.gutters.find(item => item.position === level)
      if (gutter) chars.push(place === 0 && gutter.show ? '│' : ' ')
      else if (connector && level === connectorLevel) {
        if (place === 0) chars.push(flat.isLast ? '└' : '├')
        else if (place === 1) chars.push(model.isFolded(entryId) ? '⊞' : model.isFoldable(entryId) ? '⊟' : '─')
        else chars.push(' ')
      } else chars.push(' ')
    }
    return chars.join('')
  }

  private row(flat: FlatNode, selected: boolean): Row {
    const theme = this.options.theme()
    const model = this.model
    const entry = flat.node.entry
    const connector = flat.showConnector && !flat.isVirtualRootChild
    const foldText = model.isFolded(entry.id) && !connector ? '⊞ ' : ''
    const pathText = model.isOnActivePath(entry.id) ? '• ' : ''
    const fold = foldText ? theme.fg('accent', foldText) : ''
    const path = pathText ? theme.fg('accent', pathText) : ''
    const labelText = flat.node.label ? `[${safeText(flat.node.label)}] ` : ''
    const label = flat.node.label ? theme.fg('warning', `[${safeText(flat.node.label)}] `) : ''
    const stampText = model.showLabelTimestamps && flat.node.label && flat.node.labelTimestamp ? `${formatTime(flat.node.labelTimestamp)} ` : ''
    const stamp = model.showLabelTimestamps && flat.node.label && flat.node.labelTimestamp ? theme.fg('muted', `${formatTime(flat.node.labelTimestamp)} `) : ''
    const text = model.describe(flat.node)
    const content = theme.fg(text.leadTone, safeText(text.lead)) + (text.textTone ? theme.fg(text.textTone, safeText(text.text)) : safeText(text.text))
    const contentText = safeText(text.lead) + safeText(text.text)
    const leadText = this.prefix(flat, entry.id) + foldText + pathText
    const lead = theme.fg('dim', this.prefix(flat, entry.id)) + fold + path
    const marker = selected ? selectionText(theme, '❯ ') : '  '
    const body = selected
      ? selectionText(theme, leadText + labelText + stampText + contentText)
      : lead + label + stamp + content
    return { gutter: marker, body, anchor: visibleWidth(lead), width: visibleWidth(body), selected }
  }

  render(width: number): string[] {
    const rows = pageRows(this.options.tui)
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const inner = centered ? centerDialogContentWidth(width) : contentWidth(width)
    const model = this.model
    const total = model.rows.length
    const count = this.listRows()
    const start = Math.max(0, Math.min(Math.max(0, total - count), model.selectedIndex - Math.floor(count / 2)))
    const shown = model.rows.slice(start, start + count).map((flat, offset) => this.row(flat, start + offset === model.selectedIndex))
    const stamps = model.showLabelTimestamps ? theme.fg('dim', '  [label time]') : ''
    const strip = tabStrip(FILTERS, model.filterMode, inner, theme, 'sub') + stamps
    const searchNote = model.searchQuery ? `${total} ${total === 1 ? 'entry' : 'entries'} · all entries` : `${total} ${total === 1 ? 'entry' : 'entries'}`
    const body = [
      ...this.search.renderLines(inner, searchNote, this.searchRows()),
      strip,
      ...(total ? viewport(shown, inner, theme) : [theme.fg('dim', 'No entries found')])
    ]
    if (centered) return centerDialogFrame({ title: 'Session tree', body: body.map(line => truncateToWidth(line, inner, '')), width, rows, theme })
    return pageFrame({
      title: 'Session tree', meta: total ? `(${model.selectedIndex + 1}/${total})` : '(0/0)', body,
      footer: '↑/↓ move · ←/→ page · Alt+←/→ branch · Ctrl+E label · Ctrl+X copy · Ctrl+O filter · Enter go · Esc cancel',
      width, rows, theme
    })
  }
}

export { TREE_FILTER_MODES, type TreeFilterMode }
