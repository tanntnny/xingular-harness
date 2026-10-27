/**
 * The Hub page: the Community catalog and all installed Hub receipts. Installing asks first,
 * installs exactly the listed version, and leaves code switched off and untrusted.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { HubOverview, HubPreviewPage } from '../../../hub/schema'
import { installHubEntry } from '../../hubMenu'
import type { MenuCall, MenuUi } from '../../pluginMenu'
import { inspectorListWidth, safeText, splitColumns, type TabInfo } from '../chrome'
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
const installedId = (id: string, version: string): string => `installed:${id}@${version}`

export class HubPage implements TerminalPage {
  readonly presentation = 'fullscreen'
  private catalog: HubOverview | undefined
  private section: typeof SECTIONS[number]['id'] = 'catalog'
  private error: string | undefined
  private refreshError: string | undefined
  private refreshing = false
  private previewTitle: string | undefined
  private previewText: string | undefined
  private previewOffset = 0
  private previewRows = 1
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>
  private pointerLayout?: { width: number; top: number; rows: number }

  constructor(private readonly options: HubPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['entry', 'entries'], empty: 'No Community entries have been published yet.',
      onActivate: row => { void this.activateRow(row.id) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.refreshOnOpen() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }
  hint(): string {
    if (this.previewText !== undefined) return '↑↓ scroll · PgUp/PgDn page · Esc back'
    if (this.list.query) return 'Enter open · Esc clear'
    if (this.section === 'installed') return 'Enter manage receipt · type to search'
    const selectedId = this.list.selected?.id
    const entry = this.catalog?.entries.find(candidate => candidate.channel === 'community' && candidate.id + '@' + candidate.version === selectedId)
    if (entry?.delivery.kind === 'pi-package') return 'Enter install exact version · type to search'
    return entry ? 'Enter preview or install · type to search' : 'Enter refresh catalog · type to search'
  }

  private async refreshOnOpen(): Promise<void> {
    await this.load(false)
    if (!this.disposed) await this.load(true)
  }

  private async load(refresh: boolean): Promise<void> {
    if (refresh) {
      this.refreshing = true
      this.options.changed()
    }
    try {
      const catalog = await this.options.call<HubOverview>('hub.list', refresh ? { refresh: true } : {})
      this.catalog = catalog
      this.error = undefined
      if (refresh) {
        this.refreshError = catalog.error ?? undefined
        if (catalog.error) this.options.ui.notify(`${catalog.error} Using ${catalog.origin} content.`, 'warning')
      } else if (catalog.error) {
        this.refreshError = catalog.error
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (refresh) this.refreshError = message
      else if (!this.catalog) this.error = message
    } finally {
      this.refreshing = false
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
      const receipts = this.catalog?.installed ?? []
      return [
        ...receipts.map(receipt => ({
          id: installedId(receipt.entry.id, receipt.entry.version),
          label: safeText(receipt.entry.title),
          group: safeText(receipt.entry.category),
          detail: `${receipt.entry.channel} · ${receipt.state ?? 'installed'} · ${receipt.entry.version}`,
          tone: receipt.state === 'installed' ? 'success' as const : 'warning' as const,
          searchText: `${receipt.entry.title} ${receipt.entry.category} ${receipt.entry.id} ${receipt.entry.publisher} ${receipt.entry.channel} ${receipt.state ?? ''}`
        })),
        { id: REFRESH, label: '⟳ Refresh catalog', group: 'Actions', tone: 'accent' as const }
      ]
    }
    const entries = (this.catalog?.entries ?? []).filter(entry => entry.channel === 'community').sort((left, right) => left.category.localeCompare(right.category))
    return [
      ...entries.map(entry => ({
        id: entry.id + '@' + entry.version, label: safeText(entry.title), group: safeText(entry.category),
        detail: entry.version, tone: 'muted' as const, searchText: `${entry.title} ${entry.category} ${entry.id} ${entry.publisher} ${entry.tags.join(' ')}`
      })),
      { id: REFRESH, label: '⟳ Refresh catalog', group: 'Actions', tone: 'accent' as const }
    ]
  }

  private async activateRow(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      if (id === REFRESH) { await this.load(true); return }
      if (id.startsWith('installed:')) {
        const receipt = this.catalog?.installed.find(candidate => installedId(candidate.entry.id, candidate.entry.version) === id)
        if (receipt) await this.manageReceipt(receipt)
        return
      }
      const entry = this.catalog?.entries.find(candidate => candidate.channel === 'community' && candidate.id + '@' + candidate.version === id)
      if (entry) {
        const installAction = `Install exact version ${entry.version}`
        const actions = entry.delivery.kind === 'pi-package'
          ? [installAction, 'Back']
          : ['Preview reviewed content', installAction, 'Back']
        const action = await this.options.ui.select(`${safeText(entry.title)} · ${entry.version}`, actions)
        if (action === 'Preview reviewed content') await this.previewEntry(entry)
        else if (action === installAction) {
          await installHubEntry(this.options.ui, this.options.call, entry)
          await this.load(false)
        }
      }
    } finally { this.busy = false }
  }

  private async previewEntry(entry: HubOverview['entries'][number]): Promise<void> {
    if (entry.delivery.kind === 'pi-package') return
    try {
      const page = await this.options.call<HubPreviewPage>('terminal.browser.hubPreview', { id: entry.id, version: entry.version })
      this.previewTitle = safeText(entry.title)
      this.previewText = page.content + (page.done ? '' : '\n\n[Preview limited to first page.]')
      this.previewOffset = 0
      this.pointerLayout = undefined
      this.options.changed()
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  private async manageReceipt(receipt: HubOverview['installed'][number]): Promise<void> {
    const action = await this.options.ui.select(`${receipt.entry.title} · ${receipt.entry.channel} · ${receipt.entry.version}`, ['Uninstall this version', 'Back'])
    if (action !== 'Uninstall this version') return
    const confirmed = await this.options.ui.confirm(`Uninstall ${receipt.entry.title}?`, `This removes only resources recorded by the ${receipt.entry.channel} receipt ${receipt.entry.id}@${receipt.entry.version} and revokes their attachment choices.`)
    if (!confirmed) return
    try {
      await this.options.call('hub.uninstall', { id: receipt.entry.id, version: receipt.entry.version })
      this.options.ui.notify(`Uninstalled ${receipt.entry.title} ${receipt.entry.version}.`, 'info')
      await this.load(false)
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  private status(): { text: string; tone: 'warning' | 'muted' | 'dim' } {
    const catalog = this.catalog!
    const error = this.refreshError ?? catalog.error
    const lastRefresh = catalog.refreshedAt ? ` · last refreshed ${catalog.refreshedAt}` : ''
    if (this.refreshing) return { text: `${catalog.origin} catalog · refreshing…${lastRefresh}`, tone: 'muted' }
    if (error) return { text: `${catalog.origin} catalog · refresh failed: ${error}${lastRefresh}`, tone: 'warning' }
    return { text: `${catalog.origin} catalog${catalog.refreshedAt ? ` · refreshed ${catalog.refreshedAt}` : ''}`, tone: 'dim' }
  }

  handleMouse(event: TerminalMouseInput) {
    if (this.previewText !== undefined) return { handled: true, render: false }
    const layout = this.pointerLayout
    if (!layout) return undefined
    if (event.x < 0 || event.x >= layout.width || event.y < layout.top || event.y >= layout.top + layout.rows) return { handled: true, render: false }
    return this.list.handleMouse({ ...event, y: event.y - layout.top })
  }

  handleInput(data: string): boolean {
    if (this.previewText !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.previewTitle = undefined
        this.previewText = undefined
        this.previewOffset = 0
        this.options.changed()
        return true
      }
      const page = Math.max(1, this.previewRows)
      const delta = matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1
        : matchesKey(data, 'pageDown') ? page : matchesKey(data, 'pageUp') ? -page : 0
      if (matchesKey(data, 'home')) this.previewOffset = 0
      else if (matchesKey(data, 'end')) this.previewOffset = Number.MAX_SAFE_INTEGER
      else this.previewOffset += delta
      this.options.changed()
      return true
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        this.section = this.section === 'catalog' ? 'installed' : 'catalog'
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  private entryInspector(entry: HubOverview['entries'][number] | undefined, installed: HubOverview['installed'][number] | undefined, width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!entry) return [theme.fg('muted', 'Select an entry to review its publisher, license, and version.')].slice(0, rows)
    const lines = [theme.bold(safeText(entry.title)), '', ...wrapTextWithAnsi(safeText(entry.description), width), '']
    lines.push(`Category: ${safeText(entry.category)}`, `Publisher: ${safeText(entry.publisher)}`, `License: ${safeText(entry.license)}`, `Version: ${safeText(entry.version)}`, `Channel: ${safeText(entry.channel)}`, `ID: ${safeText(entry.id)}`)
    lines.push('', ...wrapTextWithAnsi(theme.fg('dim', `Source: ${safeText(entry.sourceUrl)}`), width))
    if (installed) lines.push('', `Installed: ${safeText(installed.installedAt)}`, `Receipt: ${safeText(installed.state ?? 'installed')} · ${safeText(installed.entry.channel)}`)
    if (entry.delivery.kind === 'pi-package') lines.push('', theme.fg('warning', 'Package code stays switched off and untrusted until reviewed.'))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.previewText !== undefined) {
      const content = this.previewText.split('\n').flatMap(line => wrapTextWithAnsi(safeText(line), width))
      this.previewRows = Math.max(1, rows - 1)
      this.previewOffset = Math.min(this.previewOffset, Math.max(0, content.length - this.previewRows))
      const header = theme.bold(`Preview · ${this.previewTitle ?? 'Hub entry'} · ${this.previewOffset + 1}/${Math.max(1, content.length)}`)
      return [header, ...content.slice(this.previewOffset, this.previewOffset + this.previewRows)]
        .slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    if (!this.catalog) {
      this.pointerLayout = undefined
      return [theme.fg(this.error ? 'error' : 'dim', this.error ? 'Could not read the catalog: ' + safeText(this.error) : 'Reading the catalog…')]
    }
    const selectedId = this.list.selected?.id
    const installed = this.section === 'installed'
      ? this.catalog.installed.find(receipt => installedId(receipt.entry.id, receipt.entry.version) === selectedId)
      : undefined
    const entry = installed?.entry ?? this.catalog.entries.find(candidate => candidate.channel === 'community' && candidate.id + '@' + candidate.version === selectedId)
    const status = this.status()
    const statusLine = theme.fg(status.tone, truncateToWidth(safeText(status.text), width, ''))
    const paneWidth = inspectorListWidth(width)
    if (paneWidth !== undefined) {
      const bodyRows = Math.max(0, rows - 1)
      const rightWidth = Math.max(0, width - paneWidth - 3)
      const listLines = this.list.render(paneWidth, bodyRows)
      this.pointerLayout = { width: paneWidth, top: 1, rows: listLines.length }
      return [statusLine, ...splitColumns(listLines, this.entryInspector(entry, installed, rightWidth, bodyRows), paneWidth, width, bodyRows, theme)]
        .slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    const detail = entry && rows >= 9
      ? [...wrapTextWithAnsi(safeText(entry.description), width).slice(0, 3), `${entry.publisher} · ${entry.license} · ${entry.id}`,
          ...(installed ? [`Installed ${installed.installedAt} · ${installed.entry.channel} · ${installed.state ?? 'installed'}`] : [])]
      : []
    const detailHeight = detail.length ? detail.length + 1 : 0
    const listLines = this.list.render(width, Math.max(1, rows - 1 - detailHeight))
    this.pointerLayout = { width, top: 1, rows: Math.min(listLines.length, Math.max(0, rows - 1)) }
    const lines = [statusLine, ...listLines]
    if (detail.length) lines.push('', ...detail.map(line => theme.fg('muted', safeText(line))))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
