/**
 * The Plugins page: what this session loads, switched on or off, with trust for plugin code.
 * Enter opens what can be done with a row; nothing changes without a choice made here. A plugin
 * with settings has a Settings row that opens them as a subpage; Esc goes back to the list.
 */
import { describePlugin, surfaceBadge } from '../../../plugins/surfaces'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { Plugin, PluginSetting } from '../../../plugins/types'
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
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  changed(): void
}

type Setting = PluginSetting & { value: number }

const SETTINGS_ROW = 'settings:'
const isSwitch = (setting: PluginSetting): boolean => setting.min === 0 && setting.max === 1
const settingValueText = (setting: Setting): string => isSwitch(setting)
  ? setting.value === 1 ? 'on' : 'off'
  : `${setting.value.toLocaleString('en-US')}${setting.value === setting.default ? ' · default' : ''}`
const settingsOf = (plugin: Plugin): Setting[] => plugin.settings ?? []

export class PluginsPage implements TerminalPage {
  private plugins: Plugin[] | undefined
  private section: typeof SECTIONS[number]['id'] = 'plugins'
  private projectId: string | null = null
  private error: string | undefined
  private restart = false
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>
  /** The plugin whose settings are open, or null on the list. */
  private settingsFor: string | null = null
  private saved = false
  private readonly settingsList: FilterList<string>

  constructor(private readonly options: PluginsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['item', 'items'], empty: 'There is nothing to switch or trust here yet.',
      onActivate: row => { void this.open(row.id) }
    })
    this.settingsList = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['setting', 'settings'], empty: 'This plugin has no settings.',
      onActivate: row => { void this.change(row.id) },
      onCancel: () => this.back()
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) {
    this.list.focused = value
    this.settingsList.focused = value
  }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] {
    const plugin = this.settingsPlugin()
    return plugin ? [{ id: 'settings', title: `Plugins › ${safeText(plugin.title)}` }] : SECTIONS
  }

  activeTab(): string { return this.settingsPlugin() ? 'settings' : this.section }

  hint(): string {
    if (this.settingsPlugin()) return this.settingsList.query ? 'Enter change · Esc clear' : 'Enter change · Esc back'
    return this.list.query ? 'Enter actions · Esc clear' : 'Enter actions · type to search'
  }

  private settingsPlugin(): Plugin | undefined {
    return this.settingsFor ? this.plugins?.find(plugin => plugin.id === this.settingsFor) : undefined
  }

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
    if (this.settingsFor && !this.settingsPlugin()) this.settingsFor = null
    this.list.setRows(this.rows())
    const plugin = this.settingsPlugin()
    if (plugin) this.settingsList.setRows(settingsOf(plugin).map(setting => ({
      id: setting.key, label: safeText(setting.label), detail: settingValueText(setting),
      tone: isSwitch(setting) ? (setting.value === 1 ? 'success' : 'dim') : 'muted',
      searchText: `${setting.label} ${setting.description}`
    })))
  }

  /** The menu rows, with a Settings row after the last row of each plugin that has settings. */
  private rows(): ListRow<string>[] {
    const menu = this.menu()
    const out: ListRow<string>[] = []
    const placed = new Set<string>()
    const settingsRow = (plugin: Plugin): ListRow<string> => {
      const count = settingsOf(plugin).length
      placed.add(plugin.id)
      return { id: `${SETTINGS_ROW}${plugin.id}`, group: safeText(plugin.title), label: 'Settings', detail: `${count} ${count === 1 ? 'setting' : 'settings'} ›`, tone: 'muted', searchText: `${plugin.title} settings ${settingsOf(plugin).map(setting => setting.label).join(' ')}` }
    }
    menu.forEach((row, index) => {
      out.push(this.toRow(row))
      const last = menu[index + 1]?.plugin.id !== row.plugin.id
      if (this.section === 'plugins' && last && settingsOf(row.plugin).length) out.push(settingsRow(row.plugin))
    })
    if (this.section === 'plugins') {
      for (const plugin of this.plugins ?? []) if (settingsOf(plugin).length && !placed.has(plugin.id)) out.push(settingsRow(plugin))
    }
    return out
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
      detail: `${row.on ? 'on' : 'off'}${kind ? ` · ${kind}` : ''}${row.whole && surfaceBadge(row.plugin.surfaces) ? ` · ${surfaceBadge(row.plugin.surfaces)}` : ''}`, tone: row.on ? 'success' : 'dim',
      searchText: `${row.name} ${row.plugin.title} ${row.note}`
    }
  }

  private async open(id: string): Promise<void> {
    if (id.startsWith(SETTINGS_ROW)) {
      this.settingsFor = id.slice(SETTINGS_ROW.length)
      this.saved = false
      this.fill()
      this.options.changed()
      return
    }
    const row = this.menu().find(candidate => this.key(candidate) === id)
    if (!row || this.busy) return
    this.busy = true
    try {
      const action = await this.options.ui.select(`${row.plugin.title}: ${describePlugin(row.plugin)}`, rowActions(row, this.projectId))
      if (action && action !== BACK && await applyPluginAction(this.options.ui, this.options.call, row, action)) this.restart = true
    } finally { this.busy = false }
    await this.reload()
  }

  private back(): void {
    this.settingsFor = null
    this.saved = false
    this.fill()
  }

  /** Flips a switch, or asks for a number inside the setting's range, and saves it. */
  private async change(key: string): Promise<void> {
    const plugin = this.settingsPlugin()
    const setting = plugin && settingsOf(plugin).find(candidate => candidate.key === key)
    if (!plugin || !setting || this.busy) return
    this.busy = true
    try {
      let value: number
      if (isSwitch(setting)) value = setting.value === 1 ? 0 : 1
      else {
        const answer = await this.options.ui.input(`${setting.label} (${setting.min.toLocaleString('en-US')}–${setting.max.toLocaleString('en-US')})`, String(setting.value))
        if (answer === undefined || !answer.trim()) return
        const typed = answer.trim().replace(/[,_]/g, '')
        value = Number(typed)
        if (!/^-?\d+$/.test(typed) || value < setting.min || value > setting.max) {
          this.options.ui.notify(`${setting.label} must be a whole number from ${setting.min.toLocaleString('en-US')} to ${setting.max.toLocaleString('en-US')}.`, 'error')
          return
        }
      }
      const fresh = await this.options.call<Plugin[]>('plugins.configure', { pluginId: plugin.id, settings: { [setting.key]: value } })
      if (Array.isArray(fresh)) this.plugins = fresh
      else await this.reload()
      this.saved = true
      this.fill()
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
      if (!this.disposed) this.options.changed()
    }
  }

  handleMouse(event: TerminalMouseInput) {
    return this.settingsPlugin() ? this.settingsList.handleMouse(event) : this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (this.settingsPlugin()) {
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) return true
      return this.settingsList.handleInput(data)
    }
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
    const plugin = this.settingsPlugin()
    if (plugin) return this.renderSettings(plugin, width, rows)
    const selectedId = this.list.selected?.id
    const selected = selectedId?.startsWith(SETTINGS_ROW)
      ? this.plugins.find(candidate => `${SETTINGS_ROW}${candidate.id}` === selectedId)
      : this.menu().find(candidate => this.key(candidate) === selectedId)?.plugin
    const detail = selected && rows >= 8 ? wrapTextWithAnsi(safeText(describePlugin(selected)), width).slice(0, 3) : []
    const note = this.restart ? ['Saved. Changes apply when this session restarts.'] : []
    const extra = detail.length + note.length
    const lines = this.list.render(width, Math.max(2, rows - (extra ? extra + 1 : 0)))
    if (extra) lines.push('', ...detail.map(line => theme.fg('muted', line)), ...note.map(line => theme.fg('warning', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }

  private renderSettings(plugin: Plugin, width: number, rows: number): string[] {
    const theme = this.options.theme()
    const setting = settingsOf(plugin).find(candidate => candidate.key === this.settingsList.selected?.id)
    const range = setting && !isSwitch(setting) ? [`From ${setting.min.toLocaleString('en-US')} to ${setting.max.toLocaleString('en-US')} · default ${setting.default.toLocaleString('en-US')}`] : []
    const detail = setting && rows >= 8 ? [...wrapTextWithAnsi(safeText(setting.description), width).slice(0, 3), ...range] : []
    const note = this.saved ? ['Saved.'] : []
    const extra = detail.length + note.length
    const lines = this.settingsList.render(width, Math.max(2, rows - (extra ? extra + 1 : 0)))
    if (extra) lines.push('', ...detail.map(line => theme.fg('muted', line)), ...note.map(line => theme.fg('success', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
