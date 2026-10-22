/**
 * The Plugins page: what this session loads, switched on or off, with trust for plugin code.
 * Enter opens what can be done with a row; nothing changes without a choice made here.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { Plugin } from '../../../plugins/types'
import { BACK, applyPluginAction, menuRows, rowActions, type MenuCall, type MenuRow, type MenuUi } from '../../pluginMenu'
import { safeText } from '../chrome'
import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'

const SECTIONS = [
  { id: 'plugins', title: 'Plugins' },
  { id: 'trust', title: 'Trust' }
] as const

export interface PluginsPageOptions {
  theme: () => Theme
  call: MenuCall
  ui: MenuUi
  changed(): void
}

export class PluginsPage implements TerminalPage {
  private plugins: Plugin[] | undefined
  private section: typeof SECTIONS[number]['id'] = 'plugins'
  private projectId: string | null = null
  private error: string | undefined
  private restart = false
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>

  constructor(private readonly options: PluginsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['item', 'items'], empty: 'There is nothing to switch or trust here yet.',
      onActivate: row => { void this.open(row.id) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }
  hint(): string { return this.list.query ? 'Enter actions · Esc clear' : 'Enter actions · type to search' }

  private async reload(): Promise<void> {
    try {
      const { call } = this.options
      this.projectId = (await call<{ projectId: string | null }>('plugins.session').catch(() => ({ projectId: null }))).projectId
      this.plugins = await call<Plugin[]>('plugins.list')
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.fill()
    this.options.changed()
  }

  private fill(): void {
    this.list.setRows(this.menu().map(row => this.toRow(row)))
  }

  private menu(): MenuRow[] {
    const rows = menuRows(this.plugins ?? [], this.projectId)
    return this.section === 'trust'
      ? rows.filter(row => row.whole && Boolean(row.plugin.code))
      : rows.filter(row => rowActions(row, this.projectId).some(action => action.startsWith('Switch ')))
  }

  private key(row: MenuRow): string { return `${row.whole ? 'plugin' : 'item'}:${row.id}` }

  private toRow(row: MenuRow): ListRow<string> {
    const kind = row.whole ? row.note : row.note.replace(/ in .*$/, '')
    return {
      id: this.key(row), group: safeText(row.plugin.title), label: row.whole ? 'Whole plugin' : safeText(row.name),
      detail: `${row.on ? 'on' : 'off'}${kind ? ` · ${kind}` : ''}`, tone: row.on ? 'success' : 'dim',
      searchText: `${row.name} ${row.plugin.title} ${row.note}`
    }
  }

  private async open(id: string): Promise<void> {
    const row = this.menu().find(candidate => this.key(candidate) === id)
    if (!row || this.busy) return
    this.busy = true
    try {
      const action = await this.options.ui.select(`${row.plugin.title}: ${row.plugin.description || 'No description.'}`, rowActions(row, this.projectId))
      if (action && action !== BACK && await applyPluginAction(this.options.ui, this.options.call, row, action)) this.restart = true
    } finally { this.busy = false }
    await this.reload()
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        this.section = this.section === 'plugins' ? 'trust' : 'plugins'
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.plugins) return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read plugins: ${this.error}` : 'Reading plugins…')]
    const selected = this.menu().find(candidate => this.key(candidate) === this.list.selected?.id)
    const detail = selected && rows >= 8 ? wrapTextWithAnsi(safeText(selected.plugin.description || 'No description.'), width).slice(0, 2) : []
    const note = this.restart ? ['Saved. Changes apply when this session restarts.'] : []
    const extra = detail.length + note.length
    const lines = this.list.render(width, Math.max(2, rows - (extra ? extra + 1 : 0)))
    if (extra) lines.push('', ...detail.map(line => theme.fg('muted', line)), ...note.map(line => theme.fg('warning', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
