import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { BROWSER_SECTIONS, browserItems, catalogSection, type BrowserChannel, type BrowserItem, type BrowserRuntime, type BrowserSection, type BrowserSnapshot, type BrowserSource } from '../../browser'
import type { HubEntry, HubPreviewPage } from '../../../hub/schema'
import type { Connection, ConnectionInput } from '../../../mcp/types'
import type { Plugin } from '../../../plugins/types'
import { PI_SURFACE } from '../../../variant/surface'
import { BACK, applyPluginAction, menuRows, rowActions, type MenuCall, type MenuUi } from '../../pluginMenu'
import { safeText, selectedRow, selectionText } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'
import type { TerminalPermissionState } from '../runtime'

export interface BrowserPageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & {
    input(title: string, placeholder?: string): Promise<string | undefined>
    secretInput(title: string, placeholder?: string): Promise<string | undefined>
  }
  runtime(): BrowserRuntime
  permissions(): Promise<TerminalPermissionState>
  setGlobalTool(tool: string, allowed: boolean): Promise<void>
  useSkill(name: string): void
  changed(): void
  section?: BrowserSection
  source?: BrowserSource
}

interface Row {
  item?: BrowserItem
  hub?: HubEntry
  section?: BrowserSection
  action?: 'import' | 'package' | 'connection' | 'refresh'
}
interface Action { id: string; label: string; run(): Promise<void> | void }
const TITLES: Record<BrowserSection, string> = { overview: 'Overview', foundation: 'Foundation', variant: 'Variant', skills: 'Skills', plugins: 'Plugins', connections: 'Connections', tools: 'Tools', library: 'Library' }
const LOCAL = ['all', 'local', 'built-in'] as const

export class BrowserPage implements TerminalPage {
  readonly presentation = 'fullscreen'
  readonly ownsNavigation = true
  private section: BrowserSection
  private source: BrowserSource
  private channel: BrowserChannel = 'all'
  private local: typeof LOCAL[number] = 'all'
  private focus: 'section' | 'source' | 'filter' | 'actions' | 'list' | 'inspector' = 'list'
  private snapshot?: BrowserSnapshot
  private permissions?: TerminalPermissionState
  private error?: string
  private busy = false
  private disposed = false
  private generation = 0
  private detail?: Row
  private content?: string
  private contentOffset = 0
  private contentTotal = 0
  private contentRows = 1
  private saved = new Map<BrowserSection, { query: string; selected?: string }>()
  private readonly list: FilterList<Row>
  private readonly actionList: FilterList<Action>
  private toolbarHits: { start: number; end: number; row: Row }[] = []
  private filterStart = 0
  private filterRow = 0
  private inspectorActionRow = 0
  private actionRow = 2
  private pointer = { wide: false, body: 0, listWidth: 1 }

  constructor(private readonly options: BrowserPageOptions) {
    this.section = options.section ?? 'overview'
    this.source = options.source ?? 'installed'
    this.list = new FilterList<Row>({ theme: options.theme, search: 'always', noun: ['resource', 'resources'],
      empty: 'No matching resources. Change the filter or Discover.', onActivate: row => { void this.open(row.data) } })
    this.actionList = new FilterList<Action>({ theme: options.theme, search: 'never', noun: ['action', 'actions'],
      onActivate: row => { if (row.data) void this.perform(row.data.run) } })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value; this.actionList.focused = value }
  tabs() { return BROWSER_SECTIONS.map(id => ({ id, title: TITLES[id] })) }
  activeTab(): string { return this.section }
  selectTab(id: string): void {
    if (!this.busy && BROWSER_SECTIONS.includes(id as BrowserSection)) this.navigate(id as BrowserSection)
  }
  hint(): string { return this.content !== undefined ? '↑↓ scroll · PgUp/PgDn page' : this.detail ? 'Enter action · Tab controls' : 'Tab controls · ←→ tabs · Enter inspect · Ctrl+F search' }
  activate(): void { void this.load() }
  dispose(): void { this.disposed = true; this.generation += 1 }

  private async load(refresh = false): Promise<void> {
    const generation = ++this.generation
    try {
      const [snapshot, permissions] = await Promise.all([
        this.options.call<BrowserSnapshot>('terminal.browser.snapshot', { refresh }), this.options.permissions()
      ])
      if (this.disposed || generation !== this.generation) return
      this.snapshot = snapshot
      this.permissions = permissions
      this.error = undefined
      this.fill()
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.options.changed()
  }

  private async perform(action: Action['run']): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.options.changed()
    try { await action() } catch (error) {
      if (!this.disposed) this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
      if (!this.disposed) {
        if (!this.detail && this.focus === 'inspector') this.focus = 'list'
        await this.load()
        this.options.changed()
      }
    }
  }

  private resources(): BrowserItem[] { return this.snapshot ? browserItems(this.snapshot, this.options.runtime()) : [] }
  private discoverable(): boolean { return this.section !== 'foundation' && this.section !== 'variant' }

  private rows(): ListRow<Row>[] {
    if (!this.snapshot) return []
    if (this.source === 'discover' && this.discoverable()) {
      const hub = this.snapshot.hub
      return (hub?.entries ?? []).filter(entry => (this.section === 'overview' || catalogSection(entry) === this.section || (this.section === 'tools' && entry.delivery.kind === 'pi-package'))
        && (this.channel === 'all' || entry.channel === this.channel)).map(entry => ({
        id: `hub:${entry.id}@${entry.version}`, label: entry.title, detail: hub?.installed.some(receipt => receipt.entry.id === entry.id && receipt.entry.version === entry.version) ? 'Installed' : entry.channel,
        group: entry.category, searchText: `${entry.title} ${entry.description} ${entry.publisher} ${entry.tags.join(' ')}`,
        data: { hub: entry }
      }))
    }
    const all = this.resources()
    if (this.section === 'overview') return BROWSER_SECTIONS.filter(section => section !== 'overview').map(section => ({
      id: `section:${section}`, label: TITLES[section], detail: `${all.filter(item => item.section === section).length}`,
      data: { section }, searchText: `${TITLES[section]} ${section === 'connections' ? 'MCP' : ''}`
    }))
    const rows: ListRow<Row>[] = all.filter(item => (item.section === this.section || (this.section === 'library' && item.componentId))
      && (this.local === 'all' || (this.local === 'built-in' ? /built.?in|^pi$/i.test(item.origin) : !/built.?in|^pi$/i.test(item.origin))))
      .map(item => ({ id: item.id, label: item.name, detail: item.status, group: item.owner, tone: item.available ? 'success' : item.status.includes('trust') || item.status.includes('failed') ? 'warning' : 'muted',
        searchText: `${item.name} ${item.description} ${item.owner} ${item.origin} ${item.path ?? ''}`, data: { item } }))
    if (this.section === 'variant') {
      for (const component of [...PI_SURFACE.components].reverse()) {
        if (!rows.some(row => row.data?.item?.description.startsWith(`c${component.index} ·`))) rows.unshift({
          id: `empty:${component.id}`, label: `c${component.index} · ${component.title}`, detail: 'Empty',
          data: { item: { id: `empty:${component.id}`, section: 'variant', name: component.title, description: `${component.description} Path: ${component.path}. Loaded: ${component.reach}.`, owner: 'Variant', origin: 'Variant', status: 'No files in this component' } }
        })
      }
    }
    for (const receipt of this.snapshot.hub?.installed ?? []) {
      if (receipt.entry.delivery.kind !== 'document') continue
      if (this.section !== catalogSection(receipt.entry) && this.section !== 'library') continue
      rows.push({ id: `installed:${receipt.entry.id}@${receipt.entry.version}`, label: receipt.entry.title,
        detail: receipt.state === 'installed' || !receipt.state ? 'Downloaded definition' : receipt.state, group: 'Hub documents',
        searchText: `${receipt.entry.title} ${receipt.entry.description} ${receipt.entry.publisher}`, data: { hub: receipt.entry } })
    }
    return rows
  }

  private fill(): void { this.list.setRows(this.rows()) }

  private navigate(section: BrowserSection): void {
    this.saved.set(this.section, { query: this.list.query, selected: this.list.selected?.id })
    this.section = section
    this.detail = undefined
    this.content = undefined
    const saved = this.saved.get(section)
    this.list.setQuery(saved?.query ?? '')
    this.fill()
    if (saved?.selected) this.list.select(saved.selected)
    this.focus = 'list'
    this.options.changed()
  }

  private async open(row: Row | undefined): Promise<void> {
    if (!row || this.busy) return
    if (row.section) { this.navigate(row.section); return }
    if (row.action) { await this.perform(() => this.toolbar(row.action!)); return }
    this.detail = row
    this.focus = 'inspector'
    this.content = undefined
    this.actionList.setRows(this.actions(row).map(action => ({ id: action.id, label: action.label, data: action })))
    this.options.changed()
  }

  private actions(row: Row): Action[] {
    const actions: Action[] = []
    const item = row.item
    if (row.hub) {
      const entry = row.hub
      const installed = this.snapshot?.hub?.installed.some(receipt => receipt.entry.id === entry.id && receipt.entry.version === entry.version)
      actions.push({ id: 'preview', label: 'Preview reviewed content', run: async () => {
        const page = await this.options.call<HubPreviewPage>('terminal.browser.hubPreview', { id: entry.id, version: entry.version })
        this.showContent(page.content + (page.done ? '' : '\n\n[Preview limited to first page.]'))
      } })
      if (!installed) actions.push({ id: 'install', label: `Install ${entry.version}`, run: async () => {
        if (!await this.options.ui.confirm(`Install ${entry.title}?`, `${entry.description}\nPublisher: ${entry.publisher}\nLicense: ${entry.license}\nSource: ${entry.sourceUrl}\nVersion: ${entry.version}\nInstallation does not grant trust, enablement, credentials or permissions.`)) return
        await this.options.call('hub.install', { id: entry.id, version: entry.version })
        this.options.ui.notify('Installed. Review it in Installed before enabling or adding it to a variant.', 'info')
        this.source = 'installed'
        this.section = catalogSection(entry)
        this.detail = undefined
      } })
      if (installed && entry.category === 'connector' && entry.delivery.kind === 'document') actions.push({ id: 'setup', label: 'Set up a connection from this definition', run: async () => {
        const result = await this.options.call<{ content: string }>('terminal.browser.hubDocument', { id: entry.id, version: entry.version })
        const value: unknown = JSON.parse(result.content)
        if (!value || typeof value !== 'object') throw new Error('Unsupported connector definition.')
        const definition = value as Record<string, unknown>
        if (definition.kind !== 'remote' || typeof definition.url !== 'string' || typeof definition.name !== 'string') throw new Error('Unsupported connector definition. Configure a connection manually.')
        await this.configureConnection(undefined, { name: definition.name, url: definition.url, auth: typeof definition.auth === 'string' ? definition.auth : 'none', catalogId: entry.id })
      } })
      return actions
    }
    if (!item) return actions
    const related: Partial<Record<string, BrowserSection>> = { 'foundation:prompt': 'variant', 'foundation:surface': 'variant', 'foundation:loader': 'plugins', 'foundation:gate': 'tools' }
    const section = related[item.id]
    if (section) actions.push({ id: 'related', label: `Browse ${TITLES[section]}`, run: () => this.navigate(section) })
    if (item.read) actions.push({ id: 'read', label: item.section === 'variant' ? 'Read pinned version' : 'Read content', run: () => this.read(item) })
    actions.push({ id: 'details', label: 'Read full description and metadata', run: () => this.showContent(this.description(row).join('\n\n')) })
    if (item.section === 'variant' && item.read && this.snapshot?.variant.latest !== this.snapshot?.variant.pinned) actions.push({ id: 'latest', label: 'Compare pinned and latest saved version', run: async () => {
      const pinned = await this.options.call<{ content: string }>('terminal.browser.read', { id: item.id })
      const latest = await this.options.call<{ content: string }>('terminal.browser.read', { id: item.id, latest: true })
      this.showContent(`PINNED ${this.snapshot?.variant.pinned}\n${pinned.content}\n\nLATEST ${this.snapshot?.variant.latest}\n${latest.content}`)
    } })
    if (item.skillName && item.available && this.options.runtime().skillCommands) actions.unshift({ id: 'use', label: `Use $${item.skillName} in draft`, run: () => this.options.useSkill(item.skillName!) })
    if (item.componentId && !item.added && !item.componentId.startsWith('prompts/') && this.snapshot?.variant.writable) actions.push({ id: 'add', label: 'Add to variant for future sessions', run: async () => {
      if (!await this.options.ui.confirm(`Add ${item.name}?`, 'Creates a validated variant version for future sessions. This terminal keeps its pinned version.')) return
      const result = await this.options.call<{ fingerprint: string }>('terminal.components.add', { id: item.componentId })
      this.options.ui.notify(`Saved for a future session · ${result.fingerprint}`, 'info')
      this.detail = undefined
    } })
    const plugin = this.snapshot?.plugins.find(plugin => plugin.id === item.pluginId)
    if (plugin) {
      if (item.section !== 'plugins') actions.push({ id: 'owner', label: 'View owning plugin and its contributions', run: () => {
        this.navigate('plugins'); this.list.select(`plugin:${plugin.id}`)
      } })
      actions.push({ id: 'manage', label: 'Manage attachment and code trust', run: () => this.managePlugin(plugin, item.contributionId) })
      if (item.section === 'plugins') actions.push({ id: 'contributions', label: 'Inspect plugin contributions', run: () => this.showContent(plugin.contributions.map(entry => `${entry.kind}: ${entry.name} [${entry.state}]\n${entry.description}${entry.path ? '\n' + entry.path : ''}`).join('\n\n')) })
      if (plugin.settings.length) actions.push({ id: 'settings', label: 'Configure plugin settings', run: () => this.configurePlugin(plugin) })
      for (const template of plugin.connectorTemplates) actions.push({ id: `template:${template.id}`, label: `Set up ${template.name} connection`, run: () => this.configureConnection(undefined,
        { name: template.name, url: template.url, auth: template.auth, catalogId: template.id }) })
      if (plugin.install && !plugin.required) actions.push({ id: 'remove', label: 'Remove installed plugin', run: async () => {
        if (await this.options.ui.confirm(`Remove ${plugin.title}?`, 'Removes this installed resource and its saved attachment choices. The running session is not reloaded.')) {
          await this.options.call('plugins.remove', { pluginId: plugin.id }); this.detail = undefined
        }
      } })
    }
    if (item.connectionId) {
      const connection = this.snapshot?.connections.find(connection => connection.id === item.connectionId)
      if (connection) {
        actions.push({ id: 'configure', label: 'Edit connection configuration', run: () => this.configureConnection(connection) })
        actions.push({ id: 'test', label: 'Test connection and list its tools', run: async () => {
          if (!await this.options.ui.confirm('Test connection?', 'Starts the configured local process or contacts the remote server to list tools. No connector tool is called.')) return
          const result = await this.options.call<Connection>('terminal.browser.connections.test', { id: connection.id })
          this.options.ui.notify(result.error || 'Connection test passed.', result.error ? 'error' : 'info')
          this.detail = undefined
        } })
        if (connection.auth === 'oauth') actions.push({ id: 'auth', label: connection.authState === 'signed_in' ? 'Sign out' : 'Sign in through browser', run: async () => {
          await this.options.call(`terminal.browser.connections.${connection.authState === 'signed_in' ? 'signOut' : 'signIn'}`, { id: connection.id }); this.detail = undefined
        } })
        actions.push({ id: 'enable', label: connection.enabled ? 'Disable connection' : 'Enable connection', run: async () => {
          if (!await this.options.ui.confirm(`${connection.enabled ? 'Disable' : 'Enable'} ${connection.name}?`, 'Changes its saved availability. Scope, host policy and per-call approvals still apply.')) return
          await this.options.call('terminal.browser.connections.save', { input: { ...connection, enabled: !connection.enabled } }); this.detail = undefined
        } })
        actions.push({ id: 'tools', label: 'Inspect last reported tools', run: () => this.showContent(JSON.stringify(connection.tools, null, 2)) })
        actions.push({ id: 'remove-connection', label: 'Remove connection', run: async () => {
          if (await this.options.ui.confirm(`Remove ${connection.name}?`, 'Removes the connection and its saved credentials.')) {
            await this.options.call('terminal.browser.connections.remove', { id: connection.id }); this.detail = undefined
          }
        } })
      }
    }
    if (item.section === 'tools') actions.push({ id: 'permission', label: 'Review saved approval for this tool', run: async () => {
      const state = await this.options.permissions()
      const allowed = state.globalTools.includes(item.name)
      if (await this.options.ui.confirm(`${allowed ? 'Revoke' : 'Allow'} ${item.name} everywhere?`, 'Changes eligible future approvals in terminal sessions sharing this device state. Hard denials and capability restrictions still apply.')) await this.options.setGlobalTool(item.name, !allowed)
    } })
    return actions
  }

  private async read(item: BrowserItem): Promise<void> {
    const result = await this.options.call<{ content: string }>('terminal.browser.read', { id: item.id })
    this.showContent(result.content)
  }

  private showContent(content: string): void { this.content = content; this.contentOffset = 0; this.options.changed() }

  private async managePlugin(plugin: Plugin, contributionId?: string): Promise<void> {
    const projectId = (await this.options.call<{ projectId: string | null }>('plugins.session')).projectId
    const rows = menuRows(this.snapshot?.plugins ?? [], projectId).filter(row => row.plugin.id === plugin.id)
    let row = rows.find(row => contributionId ? row.id === contributionId : row.whole)
    if (!row && !contributionId && rows.length) {
      const selected = await this.options.ui.select('Choose contribution', rows.map(row => row.label))
      row = rows.find(row => row.label === selected)
      if (!row) return
    }
    if (!row) { this.options.ui.notify(plugin.required || 'This resource is not switchable.', 'info'); return }
    const action = await this.options.ui.select(plugin.title, rowActions(row, projectId))
    if (action && action !== BACK && await applyPluginAction(this.options.ui, this.options.call, row, action)) this.options.ui.notify('Saved. Reopen the terminal to apply resource changes; the current selection stays pinned.', 'info')
    this.detail = undefined
  }

  private async configurePlugin(plugin: Plugin): Promise<void> {
    const selected = await this.options.ui.select(`${plugin.title} settings`, plugin.settings.map(setting => `${setting.label}: ${setting.value}`))
    const setting = plugin.settings.find(setting => selected === `${setting.label}: ${setting.value}`)
    if (!setting) return
    const answer = await this.options.ui.input(`${setting.label} (${setting.min}–${setting.max})`, String(setting.value))
    if (answer === undefined) return
    const value = Number(answer)
    if (!answer.trim() || !Number.isInteger(value) || value < setting.min || value > setting.max) throw new Error('Enter a whole number inside the setting range.')
    await this.options.call('plugins.configure', { pluginId: plugin.id, settings: { [setting.key]: value } })
    this.options.ui.notify('Setting saved.', 'info')
    this.detail = undefined
  }

  private async configureConnection(existing?: Connection, template?: { name: string; url: string; auth: string; catalogId: string }): Promise<void> {
    const ui = this.options.ui
    let kind = existing?.kind ?? (template ? 'remote' : '')
    if (!kind) {
      const transport = await ui.select('Connection transport', ['Local command (stdio)', 'Remote URL (HTTP)'])
      if (!transport) return
      kind = transport === 'Local command (stdio)' ? 'local' : 'remote'
    }
    const name = await ui.input('Connection name', existing?.name ?? template?.name ?? '')
    if (!name?.trim()) return
    const input: ConnectionInput = { ...existing, name, kind, enabled: existing?.enabled ?? false, catalogId: template?.catalogId ?? existing?.catalogId }
    if (kind === 'remote') {
      const url = await ui.input('MCP URL', existing?.url ?? template?.url ?? '')
      if (url === undefined) return
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
      input.url = url
      const auth = await ui.select('Authentication', ['None', 'Headers / token', 'OAuth browser sign-in'])
      if (!auth) return
      input.auth = auth === 'None' ? 'none' : auth === 'Headers / token' ? 'headers' : 'oauth'
      if (input.auth === 'headers') {
        const header = await ui.input('Credential header name', 'Authorization')
        if (!header) return
        const value = await ui.secretInput('Header value (include Bearer prefix if needed)')
        if (value === undefined) return
        if (value) input.headers = { [header]: value }
      }
      if (input.auth === 'oauth') {
        const clients = await this.options.call<{ catalogIds: string[] }>('terminal.browser.connections.appClients')
        const appClient = Boolean(input.catalogId && clients.catalogIds?.includes(input.catalogId))
        const client = await ui.select('OAuth client', [...(appClient ? ['Application client'] : []), 'Dynamic registration', 'My client ID'])
        if (!client) return
        input.oauthClient = client === 'My client ID' ? 'user' : client === 'Application client' ? 'app' : 'dynamic'
        const scopes = await ui.input('OAuth scopes (space-separated; empty for defaults)', existing?.oauthScopes.join(' ') ?? '')
        if (scopes === undefined) return
        input.oauthScopes = scopes.trim().split(/\s+/).filter(Boolean)
        if (input.oauthClient === 'user') {
          const clientId = await ui.input('OAuth client ID')
          if (!clientId) return
          const clientSecret = await ui.secretInput('OAuth client secret (empty for public client)')
          if (clientSecret === undefined) return
          input.oauthCredentials = { clientId, clientSecret }
        }
      }
    } else {
      const command = await ui.input('Executable (no shell command string)', existing?.command ?? '')
      if (!command?.trim()) return
      const argumentsText = await ui.input('Arguments as a JSON array', JSON.stringify(existing?.args ?? []))
      if (argumentsText === undefined) return
      const args: unknown = JSON.parse(argumentsText)
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Arguments must be a JSON array of strings.')
      input.command = command
      input.args = args
      const cwd = await ui.input('Working directory (empty for default)', existing?.cwd ?? '')
      if (cwd === undefined) return
      input.cwd = cwd || null
      const key = await ui.input('Environment variable name (empty to skip)')
      if (key === undefined) return
      if (key) {
        const value = await ui.secretInput(`Value for ${key}`)
        if (value === undefined) return
        input.env = { [key]: value }
      }
    }
    const projectId = (await this.options.call<{ projectId: string | null }>('plugins.session')).projectId
    const scope = await ui.select('Availability scope', projectId ? ['Current project', 'Everywhere'] : ['Everywhere'])
    if (!scope) return
    input.global = scope === 'Everywhere'
    input.projectIds = scope === 'Current project' ? [projectId!] : []
    if (!await ui.confirm(`Save ${name}?`, `${kind === 'remote' ? 'Remote MCP server' : 'Local MCP process'} · ${scope}. ${input.enabled ? 'Keeps its current enabled setting.' : 'Saved disabled.'} Saving does not connect, sign in or grant tool approvals.`)) return
    await this.options.call('terminal.browser.connections.save', { input })
    this.detail = undefined
    this.options.ui.notify('Connection saved. Test, sign in if required, then enable it here.', 'info')
  }

  private async toolbar(action: NonNullable<Row['action']>): Promise<void> {
    if (action === 'refresh') { await this.load(this.source === 'discover'); return }
    if (action === 'connection') { await this.configureConnection(); return }
    const source = await this.options.ui.input(action === 'import' ? 'Skill folder or SKILL.md path' : 'Plugin folder, npm package or Git source')
    if (!source?.trim()) return
    if (!await this.options.ui.confirm(action === 'import' ? 'Import local skill?' : 'Install plugin?', `${source}\nThe resource is saved for review. Installing grants no attachment, code trust or permissions.`)) return
    if (action === 'import') await this.options.call('terminal.browser.importSkill', { path: source })
    else await this.options.call('plugins.install', { source })
    this.options.ui.notify('Saved locally. Review it in Installed.', 'info')
    this.source = 'installed'
  }

  private toolbarActions(): Row[] {
    return [...(this.section === 'skills' ? [{ action: 'import' as const }] : []), ...(this.section === 'plugins' ? [{ action: 'package' as const }] : []),
      ...(this.section === 'connections' ? [{ action: 'connection' as const }] : []), { action: 'refresh' as const }]
  }

  private toolbarLabel(row: Row): string {
    return row.action === 'import' ? 'Import skill' : row.action === 'package' ? 'Add plugin' : row.action === 'connection' ? 'Add connection' : this.source === 'discover' ? 'Refresh Hub' : 'Refresh'
  }

  handleInput(data: string): boolean {
    if (this.busy) return !matchesKey(data, 'ctrl+c')
    if (this.focus === 'section' && (matchesKey(data, 'left') || matchesKey(data, 'right'))) {
      const delta = matchesKey(data, 'left') ? -1 : 1
      const index = BROWSER_SECTIONS.indexOf(this.section)
      this.navigate(BROWSER_SECTIONS[(index + delta + BROWSER_SECTIONS.length) % BROWSER_SECTIONS.length]!)
      this.focus = 'section'
      return true
    }
    if (!this.snapshot && matchesKey(data, 'tab')) { this.focus = 'section'; return true }
    if (!this.snapshot) {
      if (matchesKey(data, 'enter')) { void this.load(); return true }
      return !matchesKey(data, 'escape')
    }
    if (matchesKey(data, 'ctrl+f')) { this.detail = undefined; this.content = undefined; this.focus = 'list'; return true }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const order: typeof this.focus[] = ['section', ...(this.discoverable() ? ['source', 'filter'] as const : []), 'actions', 'list',
        ...(this.detail || this.pointer.wide && (this.list.selected?.data?.item || this.list.selected?.data?.hub) ? ['inspector'] as const : [])]
      const index = order.indexOf(this.focus)
      this.focus = order[(index + (matchesKey(data, 'shift+tab') ? -1 : 1) + order.length) % order.length]!
      if (this.focus === 'inspector' && !this.detail) void this.open(this.list.selected?.data)
      if (this.focus !== 'section' && this.focus !== 'inspector') { this.detail = undefined; this.content = undefined }
      return true
    }
    if (this.focus === 'inspector' && this.content !== undefined) {
      if (matchesKey(data, 'escape')) { this.content = undefined; return true }
      const delta = matchesKey(data, 'down') ? 1 : matchesKey(data, 'up') ? -1 : matchesKey(data, 'pageDown') ? this.contentRows : matchesKey(data, 'pageUp') ? -this.contentRows : 0
      if (matchesKey(data, 'home')) this.contentOffset = 0
      else if (matchesKey(data, 'end')) this.contentOffset = Math.max(0, this.contentTotal - this.contentRows)
      else this.contentOffset = Math.max(0, Math.min(Math.max(0, this.contentTotal - this.contentRows), this.contentOffset + delta))
      return true
    }
    if (this.focus === 'inspector' && this.detail) {
      if (matchesKey(data, 'escape')) { this.detail = undefined; this.focus = 'list'; return true }
      this.actionList.handleInput(data)
      return true
    }
    if (this.focus !== 'list') {
      const delta = matchesKey(data, 'left') ? -1 : matchesKey(data, 'right') ? 1 : 0
      if (this.focus === 'source' && delta) {
        this.source = this.source === 'installed' ? 'discover' : 'installed'; this.fill()
      } else if (this.focus === 'filter' && delta) {
        if (this.source === 'discover') {
          const channels: BrowserChannel[] = ['all', 'community', 'official']
          this.channel = channels[(channels.indexOf(this.channel) + delta + channels.length) % channels.length]!
        } else this.local = LOCAL[(LOCAL.indexOf(this.local) + delta + LOCAL.length) % LOCAL.length]!
        this.fill()
      } else if (this.focus === 'section' && matchesKey(data, 'enter')) {
        this.focus = 'list'
      } else if (matchesKey(data, 'enter')) {
        void this.perform(async () => {
          if (this.focus === 'actions') {
            const actions = this.toolbarActions()
            const selected = await this.options.ui.select('Resource actions', actions.map(row => this.toolbarLabel(row)))
            const action = actions.find(row => this.toolbarLabel(row) === selected)
            if (action?.action) await this.toolbar(action.action)
            return
          }
          const choices = this.focus === 'source' ? ['Installed', 'Discover'] : this.source === 'discover' ? ['All', 'Community', 'Official'] : ['All', 'Local', 'Built-in']
          const selected = await this.options.ui.select('Choose view', choices)
          if (!selected) return
          if (this.focus === 'source') this.source = selected.toLowerCase() as BrowserSource
          else if (this.source === 'discover') this.channel = selected.toLowerCase() as BrowserChannel
          else this.local = selected.toLowerCase() as typeof this.local
        })
      } else if (matchesKey(data, 'escape')) { this.focus = 'list'; this.detail = undefined; this.content = undefined; return true }
      return true
    }
    if (matchesKey(data, 'escape')) return this.list.query ? this.list.handleInput(data) : false
    return this.list.handleInput(data)
  }

  handleMouse(event: TerminalMouseInput) {
    if (event.type === 'wheel') {
      if (this.busy) return { handled: true, render: false }
      const inspector = this.pointer.wide ? event.x >= this.pointer.listWidth + 3 : Boolean(this.detail)
      if (inspector && !this.detail) void this.open(this.list.selected?.data)
      this.focus = inspector && this.detail ? 'inspector' : 'list'
      if (this.focus === 'list') { this.detail = undefined; this.content = undefined }
      this.handleInput((event.wheelDelta ?? 1) < 0 ? '\x1b[A' : '\x1b[B')
      return { handled: true, render: true }
    }
    if (event.type !== 'click' || event.button !== 'left' || this.busy) return undefined
    if (event.y < this.pointer.body && (this.pointer.wide || !this.detail)) {
      if ((event.y === 0 || event.y === this.filterRow) && this.discoverable()) {
        this.focus = this.filterRow !== 0 ? event.y === 0 ? 'source' : 'filter' : event.x < this.filterStart ? 'source' : 'filter'
        this.handleInput('\r'); return { handled: true, render: true }
      }
      if (event.y === this.actionRow) {
        const hit = this.toolbarHits.find(hit => event.x >= hit.start && event.x < hit.end)
        if (!hit) return undefined
        void this.open(hit.row); return { handled: true, render: true }
      }
      return undefined
    }
    if ((this.pointer.wide && event.x >= this.pointer.listWidth + 3) || (!this.pointer.wide && this.detail)) {
      if (!this.detail) void this.open(this.list.selected?.data)
      this.focus = 'inspector'
      if (this.content !== undefined) return { handled: true, render: true }
      return this.actionList.handleMouse({ ...event, x: event.x - (this.pointer.wide ? this.pointer.listWidth + 3 : 0), y: event.y - this.inspectorActionRow })
    }
    this.focus = 'list'
    this.detail = undefined
    this.content = undefined
    return this.list.handleMouse({ ...event, y: event.y - this.pointer.body })
  }

  private description(row: Row | undefined): string[] {
    if (!row) return ['Select a resource to inspect it.']
    if (row.hub) {
      const entry = row.hub
      return [entry.title, entry.description, `Publisher: ${entry.publisher}`, `Channel: ${entry.channel} · ${entry.version}`, `License: ${entry.license}`, `Source: ${entry.sourceUrl}`, 'Installation does not activate this resource.']
    }
    const item = row.item
    if (!item) return [row.section ? TITLES[row.section] : '']
    const state = this.options.runtime().skillCommands ? '' : item.section === 'skills' ? 'Skill commands are off. Browsing remains available; enable them in Settings to insert an invocation.' : ''
    const connection = this.snapshot?.connections.find(connection => connection.id === item.connectionId)
    let endpoint: string | undefined
    if (connection?.url) {
      try { const url = new URL(connection.url); endpoint = `${url.origin}${url.pathname}` } catch { endpoint = 'Invalid URL' }
    }
    return [item.name, `Owner: ${item.owner}`, `Origin: ${item.origin}`, `State: ${item.status}`, item.description, ...(item.scope ? [`Scope: ${item.scope}`] : []),
      ...(connection ? [endpoint ? `Endpoint: ${endpoint}` : `Executable: ${connection.command} · ${connection.args.length} arguments`,
        `Authentication: ${connection.auth}`, `Environment keys: ${connection.envKeys.join(', ') || 'none'}`, `Header keys: ${connection.headerKeys.join(', ') || 'none'}`,
        ...(connection.error ? [`Last error: ${connection.error}`] : [])] : []),
      ...(item.path ? [`Path: ${item.path}`] : []), ...(item.required ? [item.required] : []), ...(state ? [state] : []),
      ...(item.section === 'tools' ? [`Saved approval: ${this.permissions?.globalTools.includes(item.name) ? 'allowed everywhere' : 'no per-tool grant'}${this.permissions?.full ? ' · Full Permission on' : ''}`,
        'Availability is separate from authorization. Every call still passes the approval gate.', ...(item.parameters ? [JSON.stringify(item.parameters, null, 2)] : [])] : [])]
  }

  private renderInspector(width: number, rows: number, row: Row | undefined, bodyStart: number): string[] {
    const theme = this.options.theme()
    if (this.content !== undefined) {
      const lines = this.content.split('\n').flatMap(line => wrapTextWithAnsi(safeText(line), width))
      this.contentRows = Math.max(1, rows - 1)
      this.contentTotal = lines.length
      this.contentOffset = Math.min(this.contentOffset, Math.max(0, lines.length - this.contentRows))
      return [theme.bold(`Content · ${this.contentOffset + 1}/${Math.max(1, lines.length)}`), ...lines.slice(this.contentOffset, this.contentOffset + this.contentRows)]
    }
    const description = this.description(row).flatMap(line => wrapTextWithAnsi(safeText(line), width))
      .slice(0, Math.max(1, Math.min(6, Math.floor(rows / 2))))
    const actions = row ? this.actions(row) : []
    this.actionList.setRows(actions.map(action => ({ id: action.id, label: action.label, data: action })))
    this.actionList.focused = this.focus === 'inspector'
    this.inspectorActionRow = bodyStart + description.length + 1
    return [...description, '', ...this.actionList.render(width, Math.max(0, rows - description.length - 1))].slice(0, rows)
  }

  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    const clip = (lines: string[]) => lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
    if (!this.snapshot) return clip([theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read resources: ${this.error}` : 'Reading Harness resources…'), 'Enter retry · Esc close'])
    const wide = width >= 88
    if (!wide && this.detail) {
      this.pointer = { wide: false, body: 0, listWidth: width }
      return clip(this.renderInspector(width, rows, this.detail, 0))
    }
    const control = (text: string, focus: typeof this.focus) => this.focus === focus ? selectedRow(selectionText(theme, text), Math.min(width, visibleWidth(text)), theme) : theme.fg('muted', text)
    const header: string[] = []
    this.filterStart = visibleWidth(this.source === 'installed' ? '[Installed]  Discover' : 'Installed  [Discover]') + 2
    const sourceLabel = control(this.source === 'installed' ? '[Installed]  Discover' : 'Installed  [Discover]', 'source')
    const filterLabel = control(`Filter: ${this.source === 'discover' ? this.channel : this.local}`, 'filter')
    this.filterRow = width < 44 && this.discoverable() ? 1 : 0
    if (this.discoverable()) header.push(...(this.filterRow === 1 ? [sourceLabel, filterLabel] : [`${sourceLabel}  ${filterLabel}`]))
    else if (this.section === 'foundation') header.push(theme.fg('muted', 'Fixed runtime · changes by release'))
    else if (!this.snapshot.variant.pinned) header.push(theme.fg('muted', 'No variant selected · read-only'))
    else if (width < 48) header.push(theme.fg('muted', `Pinned: ${this.snapshot.variant.pinned}`), theme.fg('muted', `Latest: ${this.snapshot.variant.latest ?? 'none'}`))
    else header.push(theme.fg('muted', `Pinned ${this.snapshot.variant.pinned} · Latest ${this.snapshot.variant.latest ?? 'none'}`))
    const toolbar = this.toolbarActions()
    this.actionRow = header.length
    let actionX = 0
    this.toolbarHits = toolbar.map(row => {
      const start = actionX
      actionX += visibleWidth(this.toolbarLabel(row)) + 3
      return { start, end: actionX - 3, row }
    })
    header.push(control(toolbar.map(row => this.toolbarLabel(row)).join(' · '), 'actions'))
    const status = this.error || (this.source === 'discover' && this.discoverable() ? `${this.snapshot.hub?.origin ?? 'unavailable'} catalog${this.snapshot.hub?.refreshedAt ? ` · ${this.snapshot.hub.refreshedAt}` : ''}${this.snapshot.hub?.error ? ` · ${this.snapshot.hub.error}` : ''}` : '')
    if (this.busy || status) header.push(theme.fg(this.error ? 'error' : 'dim', this.busy ? 'Working…' : status))
    const bodyRows = Math.max(0, rows - header.length)
    const listWidth = wide ? Math.max(32, Math.floor((width - 3) * 0.4)) : width
    this.pointer = { wide, body: header.length, listWidth }
    this.list.focused = this.focus === 'list'
    let list = this.list.render(listWidth, bodyRows)
    if (!this.list.total && bodyRows >= 3) {
      const message = this.source === 'discover' ? `No ${this.channel === 'all' ? '' : this.channel + ' '}entries for ${TITLES[this.section]}. Change the filter or refresh Hub.` : this.section === 'variant' ? 'No variant selected. This terminal uses foundation resources only.' : 'No resources in this view. Change the filter, import locally, or choose Discover.'
      list = wrapTextWithAnsi(message, listWidth).slice(0, bodyRows)
    }
    if (!wide) return clip([...header, ...list])
    const inspector = this.renderInspector(width - listWidth - 3, bodyRows, this.detail ?? this.list.selected?.data, header.length)
    const body = Array.from({ length: bodyRows }, (_, index) => {
      const line = truncateToWidth(list[index] ?? '', listWidth, '')
      return line + ' '.repeat(Math.max(0, listWidth - visibleWidth(line))) + theme.fg('dim', ' │ ') + (inspector[index] ?? '')
    })
    return clip([...header, ...body])
  }
}
