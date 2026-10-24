/**
 * The Settings page. It lists existing host settings and asks the host to change one; the values
 * and actions belong to the host. Categories are page-local tabs (Tab / Shift+Tab).
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { safeText } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'

export interface TerminalSettingItem {
  id: string
  tab: string
  group: string
  label: string
  value: string
  description?: string
}

const CATEGORIES = [
  { id: 'appearance', title: 'Appearance' }, { id: 'model', title: 'Model' },
  { id: 'interaction', title: 'Interaction' }, { id: 'context', title: 'Context' },
  { id: 'browser', title: 'Browser' }
] as const

const tabOf = (item: TerminalSettingItem) => item.tab.toLowerCase()

export interface SettingsPageOptions {
  theme: () => Theme
  items(): TerminalSettingItem[]
  /** Loads device-local settings that need a protected Harness call. */
  load?(): Promise<void>
  /** Changes the setting; the page reads the items again afterwards. */
  apply(id: string): Promise<void>
  notify(message: string, type?: string): void
  changed(): void
}

export class SettingsPage implements TerminalPage {
  readonly presentation = 'fullscreen'
  private items: TerminalSettingItem[] = []
  private category = ''
  private disposed = false
  private readonly list: FilterList<TerminalSettingItem>

  constructor(private readonly options: SettingsPageOptions) {
    this.list = new FilterList<TerminalSettingItem>({
      theme: options.theme, search: 'always', noun: ['setting', 'settings'], empty: 'No settings',
      searchContext: () => 'every category',
      onActivate: row => {
        void options.apply(row.id).then(() => this.reload(), error => options.notify(error instanceof Error ? error.message : String(error), 'error'))
      }
    })
    this.reload()
    if (options.load) {
      void options.load().then(() => {
        if (!this.disposed) this.reload()
      }, error => {
        if (!this.disposed) options.notify(error instanceof Error ? error.message : String(error), 'error')
      })
    }
  }

  dispose(): void {
    this.disposed = true
  }

  set focused(value: boolean) { this.list.focused = value }
  get focused(): boolean { return this.list.focused }

  private categories(): typeof CATEGORIES[number][] {
    return CATEGORIES.filter(category => this.items.some(item => tabOf(item) === category.id))
  }

  private rowsFor(items: TerminalSettingItem[]): ListRow<TerminalSettingItem>[] {
    return items.map(item => ({
      id: item.id, label: safeText(item.label), detail: safeText(item.value), group: safeText(item.group), data: item,
      searchText: `${item.label} ${item.id} ${item.value} ${item.description ?? ''} ${item.group} ${item.tab}`
    }))
  }

  private reload(): void {
    const selected = this.list.selected?.id
    this.items = this.options.items().filter(item => CATEGORIES.some(category => category.id === tabOf(item)))
    if (!this.categories().some(category => category.id === this.category)) this.category = this.categories()[0]?.id ?? ''
    this.fill()
    if (selected) this.list.select(selected)
    this.options.changed()
  }

  /** Searching looks through every category; otherwise the page shows the current one. */
  private fill(): void {
    this.list.setRows(this.rowsFor(this.list.query ? this.items : this.items.filter(item => tabOf(item) === this.category)))
  }

  tabs() { return this.categories() }
  activeTab(): string { return this.category }
  hint(): string { return this.list.query ? 'Enter change · Esc clear' : 'Enter change · type to search' }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const categories = this.categories()
      if (!this.list.query && categories.length > 1) {
        const at = Math.max(0, categories.findIndex(category => category.id === this.category))
        this.category = categories[(at + (matchesKey(data, 'shift+tab') ? -1 : 1) + categories.length) % categories.length]!.id
        this.fill()
      }
      return true
    }
    const before = this.list.query
    const used = this.list.handleInput(data)
    if (this.list.query !== before) this.fill()
    return used
  }

  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    const description = this.list.selected?.data?.description
    const descriptionRows = Math.min(3, Math.max(0, rows - 7))
    const reserved = descriptionRows ? descriptionRows + 1 : 0
    const lines = this.list.render(width, Math.max(2, rows - 1 - reserved))
    if (descriptionRows) {
      lines.push('')
      const wrapped = description ? wrapTextWithAnsi(safeText(description), Math.max(1, width)) : []
      for (let index = 0; index < descriptionRows; index++) lines.push(theme.fg('muted', wrapped[index] ?? ''))
    }
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
