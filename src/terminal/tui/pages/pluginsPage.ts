/**
 * The Plugins page: what this session loads, switched on or off, with trust for plugin code.
 * Enter opens what can be done with a row; nothing changes without a choice made here. A plugin
 * with settings has a Settings row that opens them as a subpage; Esc goes back to the list.
 */
import { describePlugin, surfaceBadge } from '../../../plugins/surfaces'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { Plugin, PluginSetting } from '../../../plugins/types'
import type { Proposal } from '../../../plugins/proposals'
import type { HubOverview } from '../../../hub/schema'
import { BACK, applyPluginAction, menuRows, rowActions, type MenuCall, type MenuRow, type MenuUi } from '../../pluginMenu'
import { inspectorListWidth, safeText, splitColumns } from '../chrome'
import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'

const SECTIONS = [
  { id: 'plugins', title: 'Plugins' },
  { id: 'trust', title: 'Trust' },
  { id: 'packages', title: 'Packages' },
  { id: 'proposals', title: 'Proposals' }
] as const

export interface PluginsPageOptions {
  theme: () => Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  changed(): void
}

type Setting = PluginSetting & { value: number }

const SETTINGS_ROW = 'settings:'
const PACKAGE_ROW = 'package:'
const INSTALL_PACKAGE = 'action:install-package'
const isSwitch = (setting: PluginSetting): boolean => setting.min === 0 && setting.max === 1
const settingValueText = (setting: Setting): string => isSwitch(setting)
  ? setting.value === 1 ? 'on' : 'off'
  : `${setting.value.toLocaleString('en-US')}${setting.value === setting.default ? ' · default' : ''}`
const settingsOf = (plugin: Plugin): Setting[] => plugin.settings ?? []
// Never execute or silently hide terminal controls in code being reviewed.
const reviewText = (line: string): string => line.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

export class PluginsPage implements TerminalPage {
  readonly presentation = 'fullscreen'
  private plugins: Plugin[] | undefined
  private proposals: Proposal[] = []
  private proposalError: string | undefined
  private preview: Proposal | undefined
  private previewOffset = 0
  private previewRows = 1
  private section: typeof SECTIONS[number]['id'] = 'plugins'
  private projectId: string | null = null
  private hubManagedIds = new Set<string>()
  private error: string | undefined
  private restart = false
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>
  private pointerLayout?: { list: FilterList<string>; width: number; top: number; rows: number }
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
    if (this.preview) return this.preview.status === 'pending' ? '↑↓ scroll · PgUp/PgDn page · Enter decide · Esc back' : '↑↓ scroll · PgUp/PgDn page · Esc back'
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
      try {
        this.proposals = await call<Proposal[]>('plugins.proposals.list')
        this.proposalError = undefined
      } catch (error) {
        this.proposals = []
        this.proposalError = error instanceof Error ? error.message : String(error)
      }
      this.hubManagedIds = new Set()
      try {
        const overview = await call<HubOverview>('hub.list')
        this.hubManagedIds = new Set(overview.installed.filter(receipt => receipt.entry.delivery.kind === 'pi-package').flatMap(receipt => receipt.resourceIds))
      } catch { /* Package actions still go through the receipt-aware Harness service. */ }
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

  /** Switch, trust, settings and package actions stay grouped under their owning plugin. */
  private rows(): ListRow<string>[] {
    if (this.section === 'proposals') return this.proposals.map(proposal => ({
      id: `proposal:${proposal.id}`, label: safeText(proposal.name), detail: proposal.status,
      tone: proposal.status === 'pending' ? 'warning' as const : 'muted' as const,
      searchText: `${proposal.name} ${proposal.description} ${proposal.status}`
    }))
    if (this.section === 'packages') return [
      ...(this.plugins ?? []).filter(plugin => plugin.install).map(plugin => {
        const source = plugin.install!.kind === 'folder' ? 'local folder' : 'package'
        const hub = this.hubManagedIds.has(plugin.id)
        return { id: `${PACKAGE_ROW}${plugin.id}`, group: safeText(plugin.title), label: 'Manage package', detail: `${source} · ${hub ? 'Hub' : 'local'} · ${plugin.version ?? plugin.install!.source}`, tone: 'muted' as const, searchText: `${plugin.title} ${plugin.install!.source} ${plugin.version ?? ''} package ${hub ? 'Hub' : 'local'}` }
      }),
      { id: INSTALL_PACKAGE, group: 'Packages', label: 'Install package…', detail: 'Folder, npm or Git', tone: 'accent' as const, searchText: 'install add package plugin npm Git folder' }
    ]
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
    if (this.section === 'plugins') for (const plugin of this.plugins ?? []) if (settingsOf(plugin).length && !placed.has(plugin.id)) out.push(settingsRow(plugin))
    return out
  }

  private menu(): MenuRow[] {
    const rows = menuRows(this.plugins ?? [], this.projectId)
    if (this.section === 'trust') return rows.filter(row => row.whole && Boolean(row.plugin.code))
    if (this.section === 'packages') return []
    return rows.filter(row => rowActions(row, this.projectId).some(action => action.startsWith('Switch ')))
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
    if (this.section === 'proposals' && id.startsWith('proposal:')) {
      if (this.busy) return
      this.busy = true
      try {
        this.preview = await this.options.call<Proposal>('plugins.proposals.preview', { id: id.slice('proposal:'.length) })
        this.previewOffset = 0
        this.pointerLayout = undefined
      } catch (error) { this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
      finally { this.busy = false; this.options.changed() }
      return
    }
    if (id.startsWith(SETTINGS_ROW)) {
      this.settingsFor = id.slice(SETTINGS_ROW.length)
      this.saved = false
      this.fill()
      this.options.changed()
      return
    }
    if (id === INSTALL_PACKAGE) { await this.installPackage(); return }
    if (id.startsWith(PACKAGE_ROW)) {
      const plugin = this.plugins?.find(candidate => candidate.id === id.slice(PACKAGE_ROW.length))
      if (plugin?.install) await this.managePackage(plugin)
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

  private async decideProposal(): Promise<void> {
    const preview = this.preview
    if (!preview || preview.status !== 'pending' || this.busy) return
    this.busy = true
    try {
      const action = await this.options.ui.select(`Proposal ${safeText(preview.name)} · ${preview.hash}`, ['Accept proposal', 'Reject proposal', BACK])
      if (action !== 'Accept proposal' && action !== 'Reject proposal') return
      const accept = action === 'Accept proposal'
      if (!await this.options.ui.confirm(action + '?', accept ? 'Install this reviewed proposal switched off and untrusted? Review and trust code separately.' : 'Reject this reviewed proposal?')) return
      await this.options.call(accept ? 'plugins.proposals.accept' : 'plugins.proposals.reject', { id: preview.id, hash: preview.hash })
      this.preview = undefined
      if (accept) this.restart = true
      this.options.ui.notify(accept ? 'Accepted switched off and untrusted. Changes apply after restart.' : 'Proposal rejected.', 'info')
      await this.reload()
    } catch (error) {
      this.preview = undefined
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      await this.reload()
    } finally { this.busy = false; if (!this.disposed) this.options.changed() }
  }

  private async installPackage(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const source = await this.options.ui.input('Install local plugin package', 'npm:package@version, Git address, or absolute folder path')
      if (!source?.trim()) return
      const confirmed = await this.options.ui.confirm('Install package?', `${source.trim()} will be installed without running package code. It arrives switched off and code remains untrusted until reviewed.`)
      if (!confirmed) return
      await this.options.call('plugins.install', { source: source.trim() })
      this.restart = true
      this.options.ui.notify('Installed switched off. Changes apply when this session restarts.', 'info')
      await this.reload()
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
      if (!this.disposed) this.options.changed()
    }
  }

  private async managePackage(plugin: Plugin): Promise<void> {
    if (this.busy || !plugin.install) return
    const hubManaged = this.hubManagedIds.has(plugin.id)
    const actions = [
      ...(hubManaged || plugin.install.kind === 'folder' ? [] : ['Update package']),
      hubManaged ? 'Uninstall Hub version' : 'Remove package',
      BACK
    ]
    this.busy = true
    try {
      const action = await this.options.ui.select(`${plugin.title}: ${plugin.install.source}`, actions)
      if (!action || action === BACK) return
      if (action === 'Update package') {
        const confirmed = await this.options.ui.confirm(`Update ${plugin.title}?`, 'Fetches a newer package version without running its scripts. Changed code remains subject to trust review.')
        if (!confirmed) return
        await this.options.call('plugins.update', { pluginId: plugin.id })
        this.options.ui.notify('Updated. Changes apply when this session restarts.', 'info')
      } else {
        const title = hubManaged ? `Uninstall ${plugin.title} from Hub?` : `Remove ${plugin.title}?`
        const message = hubManaged
          ? 'This removes the exact Hub receipt and only its recorded package resources.'
          : 'This removes the installed package. A local folder is moved to the Harness trash.'
        if (!await this.options.ui.confirm(title, message)) return
        await this.options.call('plugins.remove', { pluginId: plugin.id })
        this.options.ui.notify(hubManaged ? 'Hub package uninstalled.' : 'Package removed.', 'info')
      }
      this.restart = true
      await this.reload()
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
      if (!this.disposed) this.options.changed()
    }
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
    if (this.preview) return { handled: true, render: false }
    const layout = this.pointerLayout
    if (!layout) return undefined
    if (event.x < 0 || event.x >= layout.width || event.y < layout.top || event.y >= layout.top + layout.rows) return { handled: true, render: false }
    return layout.list.handleMouse({ ...event, y: event.y - layout.top })
  }

  handleInput(data: string): boolean {
    if (this.preview) {
      if (matchesKey(data, 'escape')) this.preview = undefined
      else if (matchesKey(data, 'enter')) void this.decideProposal()
      else if (matchesKey(data, 'home')) this.previewOffset = 0
      else if (matchesKey(data, 'end')) this.previewOffset = Number.MAX_SAFE_INTEGER
      else this.previewOffset = Math.max(0, this.previewOffset + (matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1 : matchesKey(data, 'pageDown') ? this.previewRows : matchesKey(data, 'pageUp') ? -this.previewRows : 0))
      this.options.changed()
      return true
    }
    if (this.settingsPlugin()) {
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) return true
      return this.settingsList.handleInput(data)
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        const direction = matchesKey(data, 'shift+tab') ? -1 : 1
        const current = SECTIONS.findIndex(section => section.id === this.section)
        this.section = SECTIONS[(current + direction + SECTIONS.length) % SECTIONS.length]!.id
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  private selectedPlugin(): Plugin | undefined {
    const selectedId = this.list.selected?.id
    return selectedId?.startsWith(SETTINGS_ROW)
      ? this.plugins?.find(candidate => `${SETTINGS_ROW}${candidate.id}` === selectedId)
      : selectedId?.startsWith(PACKAGE_ROW)
        ? this.plugins?.find(candidate => `${PACKAGE_ROW}${candidate.id}` === selectedId)
        : this.menu().find(candidate => this.key(candidate) === selectedId)?.plugin
  }

  private pluginInspector(plugin: Plugin | undefined, width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!plugin) {
      const action = this.list.selected?.id === INSTALL_PACKAGE
      return [theme.fg('muted', action ? 'Add a package from npm, Git, or a local folder.' : 'Select a plugin to inspect it.')].slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    const selectedId = this.list.selected?.id
    const row = this.menu().find(candidate => this.key(candidate) === selectedId)
    const title = row ? row.whole ? row.plugin.title : row.name : plugin.title
    const lines = [theme.bold(safeText(title))]
    if (title !== plugin.title) lines.push(theme.fg('dim', `Part of ${safeText(plugin.title)}`))
    lines.push('', ...wrapTextWithAnsi(safeText(describePlugin(plugin)), width))
    if (row) {
      const status = this.section === 'trust' && row.whole
        ? plugin.trust === 'trusted' ? 'Code trusted' : 'Code not trusted'
        : row.on ? 'Enabled' : 'Disabled'
      lines.push('', theme.fg(row.on ? 'success' : 'dim', status))
    }
    if (plugin.code) {
      lines.push(theme.fg('muted', `Code trust: ${plugin.trust === 'trusted' ? 'trusted' : 'not trusted'}`))
      lines.push(theme.fg('muted', `Fingerprint: ${plugin.code.hash.slice(0, 12)}`))
    }
    if (plugin.install) {
      lines.push('', theme.fg('muted', `Package: ${this.hubManagedIds.has(plugin.id) ? 'Hub receipt' : 'local'}`))
      lines.push(...wrapTextWithAnsi(theme.fg('dim', safeText(plugin.install.source)), width))
    }
    if (settingsOf(plugin).length) lines.push('', theme.fg('muted', `${settingsOf(plugin).length} settings`))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.preview) {
      const proposal = this.preview
      const text = [`Name: ${proposal.name}`, `Description: ${proposal.description}`, `Status: ${proposal.status}`, `SHA-256: ${proposal.hash}`, '', '--- package.json ---', proposal.manifest, ...Object.entries(proposal.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([path, content]) => ['', `--- ${path} ---`, content])].join('\n')
      const content = text.split('\n').flatMap(line => wrapTextWithAnsi(reviewText(line), width))
      this.previewRows = Math.max(1, rows - 1)
      this.previewOffset = Math.min(this.previewOffset, Math.max(0, content.length - this.previewRows))
      return [theme.bold(`Proposal preview · ${this.previewOffset + 1}/${Math.max(1, content.length)}`), ...content.slice(this.previewOffset, this.previewOffset + this.previewRows)].slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    if (this.section === 'proposals' && this.proposalError) return [theme.fg('error', `Could not read proposals: ${safeText(this.proposalError)}`)]
    if (!this.plugins) {
      this.pointerLayout = undefined
      return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read plugins: ${this.error}` : 'Reading plugins…')]
    }
    const plugin = this.settingsPlugin()
    if (plugin) return this.renderSettings(plugin, width, rows)
    const note = this.restart ? [theme.fg('warning', 'Saved. Changes apply when this session restarts.')] : []
    const paneWidth = inspectorListWidth(width)
    if (paneWidth !== undefined) {
      const bodyRows = Math.max(0, rows - note.length)
      const rightWidth = Math.max(0, width - paneWidth - 3)
      const listLines = this.list.render(paneWidth, bodyRows)
      this.pointerLayout = { list: this.list, width: paneWidth, top: note.length, rows: listLines.length }
      return [...note, ...splitColumns(listLines, this.pluginInspector(this.selectedPlugin(), rightWidth, bodyRows), paneWidth, width, bodyRows, theme)]
        .slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    const selected = this.selectedPlugin()
    const detail = selected && rows >= 8 ? wrapTextWithAnsi(safeText(describePlugin(selected)), width).slice(0, 3) : []
    const listRows = Math.max(2, rows - note.length - (detail.length ? detail.length + 1 : 0))
    const listLines = this.list.render(width, listRows)
    this.pointerLayout = { list: this.list, width, top: note.length, rows: Math.min(listLines.length, Math.max(0, rows - note.length)) }
    const lines = [...note, ...listLines]
    if (detail.length) lines.push('', ...detail.map(line => theme.fg('muted', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }

  private renderSettings(plugin: Plugin, width: number, rows: number): string[] {
    const theme = this.options.theme()
    const setting = settingsOf(plugin).find(candidate => candidate.key === this.settingsList.selected?.id)
    const range = setting && !isSwitch(setting) ? [`From ${setting.min.toLocaleString('en-US')} to ${setting.max.toLocaleString('en-US')} · default ${setting.default.toLocaleString('en-US')}`] : []
    const note = this.saved ? [theme.fg('success', 'Saved.')] : []
    const paneWidth = inspectorListWidth(width)
    if (paneWidth !== undefined) {
      const bodyRows = Math.max(0, rows - note.length)
      const rightWidth = Math.max(0, width - paneWidth - 3)
      const listLines = this.settingsList.render(paneWidth, bodyRows)
      const details = setting
        ? [theme.bold(safeText(setting.label)), '', ...wrapTextWithAnsi(safeText(setting.description), rightWidth), '', ...range.map(line => theme.fg('muted', line)), theme.fg('dim', `Current value: ${settingValueText(setting)}`)]
        : [theme.fg('muted', 'Select a setting to review its value and description.')]
      this.pointerLayout = { list: this.settingsList, width: paneWidth, top: note.length, rows: listLines.length }
      return [...note, ...splitColumns(listLines, details, paneWidth, width, bodyRows, theme)]
        .slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    const detail = setting && rows >= 8 ? [...wrapTextWithAnsi(safeText(setting.description), width).slice(0, 3), ...range] : []
    const listRows = Math.max(2, rows - note.length - (detail.length ? detail.length + 1 : 0))
    const listLines = this.settingsList.render(width, listRows)
    this.pointerLayout = { list: this.settingsList, width, top: note.length, rows: Math.min(listLines.length, Math.max(0, rows - note.length)) }
    const lines = [...note, ...listLines]
    if (detail.length) lines.push('', ...detail.map(line => theme.fg('muted', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
