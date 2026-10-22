/**
 * The Hub page: the reviewed catalog of skills, plugins and reusable documents. Installing asks first,
 * installs exactly the listed version, and leaves code switched off and untrusted.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { HubOverview } from '../../../hub/schema'
import { installHubEntry } from '../../hubMenu'
import type { MenuCall, MenuUi } from '../../pluginMenu'
import { safeText, type TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'

export interface HubPageOptions {
  theme: () => Theme
  call: MenuCall
  ui: MenuUi
  changed(): void
}

const SECTIONS = [
  { id: 'catalog', title: 'Catalog' },
  { id: 'installed', title: 'Installed' }
] as const

const REFRESH = 'action:refresh'

export class HubPage implements TerminalPage {
  private catalog: HubOverview | undefined
  private section: typeof SECTIONS[number]['id'] = 'catalog'
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>

  constructor(private readonly options: HubPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['entry', 'entries'], empty: 'The catalog has no entries.',
      onActivate: row => { void this.activateRow(row.id) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { if (!this.catalog) void this.load(false) }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }
  hint(): string {
    return this.list.query ? 'Enter open · Esc clear' : this.section === 'catalog' ? 'Enter review and install · type to search' : 'Select an installed entry · type to search'
  }

  private async load(refresh: boolean): Promise<void> {
    try {
      const catalog = await this.options.call<HubOverview>('hub.list', refresh ? { refresh: true } : {})
      this.catalog = catalog
      this.error = undefined
      if (refresh && catalog.error) this.options.ui.notify(`${catalog.error} Using ${catalog.origin} content.`, 'warning')
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.fill()
    this.options.changed()
  }

  private fill(): void {
    this.list.setRows(this.rows())
  }

  private rows(): ListRow<string>[] {
    if (this.section === 'installed') {
      return [
        ...(this.catalog?.installed ?? []).map(receipt => ({
          id: 'installed:' + receipt.entry.id + '@' + receipt.entry.version,
          label: safeText(receipt.entry.title),
          group: receipt.entry.category,
          detail: (receipt.state ?? 'installed') + ' · ' + receipt.entry.version,
          tone: receipt.state === 'installed' ? 'success' as const : 'warning' as const,
          searchText: receipt.entry.title + ' ' + receipt.entry.category + ' ' + receipt.entry.id + ' ' + receipt.entry.publisher + ' ' + (receipt.state ?? '')
        }))
      ]
    }
    const entries = [...(this.catalog?.entries ?? [])].sort((left, right) => left.category.localeCompare(right.category))
    return [
      ...entries.map(entry => ({
        id: entry.id + '@' + entry.version, label: safeText(entry.title), group: safeText(entry.category),
        detail: entry.version, tone: 'muted' as const, searchText: entry.title + ' ' + entry.category + ' ' + entry.id + ' ' + entry.publisher
      })),
      { id: REFRESH, label: '⟳ Refresh catalog', group: 'Actions', tone: 'accent' as const }
    ]
  }

  private async activateRow(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (id === REFRESH) { await this.load(true); return }
      if (id.startsWith('installed:')) return
      const entry = this.catalog?.entries.find(candidate => candidate.id + '@' + candidate.version === id)
      if (entry) await installHubEntry(this.options.ui, this.options.call, entry)
    } finally { this.busy = false }
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        this.section = this.section === 'catalog' ? 'installed' : 'catalog'
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.catalog) return [theme.fg(this.error ? 'error' : 'dim', this.error ? 'Could not read the catalog: ' + this.error : 'Reading the catalog…')]
    const selectedId = this.list.selected?.id
    const installed = this.section === 'installed'
      ? this.catalog.installed.find(receipt => 'installed:' + receipt.entry.id + '@' + receipt.entry.version === selectedId)
      : undefined
    const entry = installed?.entry ?? this.catalog.entries.find(candidate => candidate.id + '@' + candidate.version === selectedId)
    const detail = entry && rows >= 9
      ? [...wrapTextWithAnsi(safeText(entry.description), width).slice(0, 3), entry.publisher + ' · ' + entry.license + ' · ' + entry.id,
          ...(installed ? ['Installed ' + installed.installedAt + ' · ' + (installed.state ?? 'installed')] : [])]
      : []
    const lines = this.list.render(width, Math.max(2, rows - (detail.length ? detail.length + 1 : 0)))
    if (detail.length) lines.push('', ...detail.map(line => theme.fg('muted', safeText(line))))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
