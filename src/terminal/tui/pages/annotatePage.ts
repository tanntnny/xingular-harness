/**
 * The annotate page (`/annotate:` and `/annotate:notes`, PROP-0018, PROP-0048): one full page with
 * two tabs. **Annotate** is the panel beside the window being inspected: the target and its address
 * or app are chosen in the page itself, the inspector outlines a component, and a click opens a
 * popover with two buttons, Annotate and Annotate & send. Every annotation is shared with this
 * session at once; `s` sends all the unsent ones. **All annotations** is the searchable list of every
 * saved annotation.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Input, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import type { MenuCall, MenuUi } from '../../pluginMenu'
import type { TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'
import type { Note, NoteApp, NoteTarget } from '../../../annotations/store'
import { normalizeAddress, normalizeDevTools } from '../annotateCommand'
import { describeSend, sendUnsent, unsent } from '../annotateSend'

export type AnnotateStart =
  | { kind: 'web'; url?: string }
  | { kind: 'cdp'; endpoint: string; name?: string }
  | { kind: 'bridge'; name?: string }
  /** Opens on the list of apps with a DevTools port. */
  | { kind: 'apps' }

export type AnnotateTab = 'annotate' | 'all'

export interface AnnotatePageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  changed(): void
  start: AnnotateStart
  initialTab?: AnnotateTab
  /** How often the inspector is asked for the person's next comment, in milliseconds. */
  pollMs?: number
}

interface TargetState {
  kind: 'web' | 'cdp' | 'bridge'
  app: NoteApp | null
  inspecting: boolean
  /** The script to load while it captures a bridge; shown again when the page reopens. */
  bridge?: { snippet: string }
  windows: { id: string; url: string; title: string; current: boolean }[]
}

interface Step {
  active: boolean
  note: Note | null
  message: string | null
}

interface DevToolsApp {
  endpoint: string
  port: number
  name: string
  browser: string
  electron: boolean
  windows: number
}

type FieldKind = 'address' | 'port' | 'path'
type NoteRow = { kind: 'note'; note: Note }
type AppRow = { kind: 'app'; app: DevToolsApp } | { kind: 'port' } | { kind: 'launch' } | { kind: 'bridge' } | { kind: 'web' }

const TABS = [{ id: 'annotate', title: 'Annotate' }, { id: 'all', title: 'All annotations' }] as const

const FIELDS: Record<FieldKind, { label: string; placeholder: string }> = {
  address: { label: 'Page address', placeholder: 'http://localhost:5173' },
  port: { label: 'DevTools port', placeholder: '9222' },
  path: { label: 'App to start', placeholder: '/Applications/MyApp.app' }
}

export const ANNOTATE_ACTIONS = {
  reveal: 'Show it in the window',
  send: 'Send it now',
  confirm: 'Confirm and send it (it came from the page)',
  edit: 'Edit the comment',
  resolve: 'Resolve',
  reopen: 'Reopen',
  share: 'Share it with this session',
  unshare: 'Stop sharing it with this session',
  delete: 'Delete'
} as const

const clip = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

export function describeTarget(target: NoteTarget): string {
  if (target.kind === 'text') return `“${clip(target.exact.replace(/\s+/g, ' '), 50)}”`
  if (target.kind === 'element') return `<${target.tag}> ${clip(target.name || target.text || target.selector, 40)}`
  return 'whole page'
}

/** Which group of the Annotate tab a note belongs in, for this session; null when it is not shown there. */
export function section(note: Note, sessionId: string | null): 'Unsent' | 'Sent' | null {
  if (note.status === 'resolved' || !note.delivery || note.delivery.sessionId !== sessionId) return null
  return note.delivery.state === 'pending' ? 'Unsent' : 'Sent'
}

export class AnnotatePage implements TerminalPage {
  presentation = 'fullscreen' as const
  private tab: AnnotateTab
  private view: 'notes' | 'apps' = 'notes'
  private field: { kind: FieldKind; input: Input } | null = null
  private notes: Note[] | undefined
  private sessionId: string | null = null
  private target: TargetState | null = null
  private apps: DevToolsApp[] | null = null
  private bridgeSnippet: string | null = null
  private error: string | undefined
  private busy = false
  private disposed = false
  private polling = false
  private focusedValue = false
  private timer: NodeJS.Timeout | null = null
  private refreshes = 0
  private listTop = 0
  private readonly noteList: FilterList<NoteRow>
  private readonly appList: FilterList<AppRow>
  private readonly allList: FilterList<NoteRow>

  constructor(private readonly options: AnnotatePageOptions) {
    this.tab = options.initialTab ?? 'annotate'
    this.noteList = new FilterList<NoteRow>({
      theme: options.theme, search: 'never', noun: ['annotation', 'annotations'],
      empty: 'No annotations yet. Press i and click a component in the window.',
      onActivate: row => { if (row.data) void this.noteMenu(row.data.note, 'annotate') }
    })
    this.appList = new FilterList<AppRow>({
      theme: options.theme, search: 'never', noun: ['choice', 'choices'],
      onActivate: row => { if (row.data) void this.chooseApp(row.data) }
    })
    this.allList = new FilterList<NoteRow>({
      theme: options.theme, search: 'always', noun: ['annotation', 'annotations'], empty: 'No web annotations yet',
      onActivate: row => { if (row.data) void this.noteMenu(row.data.note, 'all') }
    })
  }

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    this.syncFocus()
  }

  private syncFocus(): void {
    const value = this.focusedValue
    this.noteList.focused = value && this.tab === 'annotate' && this.view === 'notes' && !this.field
    this.appList.focused = value && this.tab === 'annotate' && this.view === 'apps' && !this.field
    this.allList.focused = value && this.tab === 'all'
    if (this.field) this.field.input.focused = value && this.tab === 'annotate'
  }

  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return this.tab }
  selectTab(id: string): void {
    if (id !== 'annotate' && id !== 'all') return
    this.tab = id
    this.syncFocus()
    this.options.changed()
  }

  hint(): string {
    if (this.tab === 'all') return 'Enter choose · type to search · Tab Annotate · Esc close'
    if (this.field) return 'Enter go · Esc cancel'
    if (this.view === 'apps') return 'Enter choose · r look again · Esc back'
    return `${this.target?.inspecting ? 'i stop inspecting' : 'i inspect'} · s send unsent · o page · a app · t window · Enter note · Tab all · Esc close`
  }

  activate(): void {
    void this.start()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.options.call('terminal.annotations.stopInspect').catch(() => undefined)
  }

  private async start(): Promise<void> {
    const start = this.options.start
    await this.reload()
    if (start.kind === 'web' && !start.url) {
      // The capture target outlives the page: reopening returns to the window still open.
      if (!await this.restore()) this.openField('address')
    } else if (start.kind === 'apps') await this.showApps()
    else await this.attempt(async () => {
      if (start.kind === 'web') await this.openPage(start.url!)
      else if (start.kind === 'cdp') await this.attachApp(start.endpoint, start.name)
      else if (start.kind === 'bridge') return this.attachBridge(start.name)
    })
    this.schedule()
  }

  /** Shows the target that is still open, with the inspector on again; false when no window is open. */
  private async restore(): Promise<boolean> {
    try {
      await this.refreshTarget()
    } catch {
      return false
    }
    const target = this.target
    if (!target || (target.kind === 'web' && !target.windows.length)) return false
    this.view = 'notes'
    this.bridgeSnippet = target.bridge?.snippet ?? null
    this.syncFocus()
    if (target.windows.length) await this.toggleInspect(true).catch(() => undefined)
    this.options.changed()
    return true
  }

  // ---- The target: a page, an app over its DevTools port, or the page bridge ----------------------

  private async refreshTarget(): Promise<void> {
    this.target = await this.options.call<TargetState>('terminal.annotations.target')
  }

  private async openPage(url: string): Promise<void> {
    await this.options.call('terminal.annotations.open', { url })
    await this.refreshTarget()
    await this.toggleInspect(true)
  }

  private async attachApp(endpoint: string, name?: string): Promise<void> {
    await this.options.call('terminal.annotations.attach', { kind: 'cdp', endpoint, ...(name ? { name } : {}) })
    await this.refreshTarget()
    this.view = 'notes'
    this.syncFocus()
    await this.toggleInspect(true)
  }

  private async attachBridge(name?: string): Promise<string | undefined> {
    const attached = await this.options.call<{ bridge?: { snippet: string } }>('terminal.annotations.attach', { kind: 'bridge', ...(name ? { name } : {}) })
    this.bridgeSnippet = attached.bridge?.snippet ?? null
    await this.refreshTarget()
    this.view = 'notes'
    this.syncFocus()
    if (this.target?.windows.length) {
      await this.toggleInspect(true)
      return undefined
    }
    return 'Load the bridge script in the app (shown at the top), then reload the app.'
  }

  private openField(kind: FieldKind): void {
    const input = new Input({ prompt: '', placeholder: FIELDS[kind].placeholder, placeholderStyle: text => this.options.theme().fg('dim', text) })
    this.field = { kind, input }
    this.syncFocus()
    this.options.changed()
  }

  private closeField(): void {
    this.field = null
    this.syncFocus()
    this.options.changed()
  }

  private submitField(): void {
    const field = this.field
    if (!field) return
    const value = field.input.getValue().trim()
    if (!value) return
    this.closeField()
    void this.attempt(async () => {
      if (field.kind === 'address') return this.openPage(normalizeAddress(value))
      if (field.kind === 'port') return this.attachApp(normalizeDevTools(value))
      const launched = await this.options.call<{ app: NoteApp | null }>('terminal.annotations.launch', { path: value })
      await this.refreshTarget()
      this.view = 'notes'
      this.syncFocus()
      await this.toggleInspect(true)
      return `Started ${launched.app?.name ?? 'the app'} and attached to its windows.`
    })
  }

  private async showApps(): Promise<void> {
    this.view = 'apps'
    this.syncFocus()
    this.appList.setRows(this.appRows())
    this.options.changed()
    try {
      this.apps = (await this.options.call<{ apps: DevToolsApp[] }>('terminal.annotations.discover')).apps
    } catch (error) {
      this.apps = []
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.appList.setRows(this.appRows())
    // The first app found is the likely choice.
    const first = this.apps[0]
    this.appList.select(first ? `app:${first.port}` : 'launch')
    this.options.changed()
  }

  appRows(): ListRow<AppRow>[] {
    const rows: ListRow<AppRow>[] = []
    const group = 'Apps with a DevTools port on this computer'
    if (!this.apps) rows.push({ id: 'looking', label: 'Looking for apps…', group, disabled: true })
    else if (!this.apps.length) rows.push({ id: 'none', label: 'None found on ports 9222–9230', group, detail: 'start one below', disabled: true, tone: 'dim' })
    for (const app of this.apps ?? []) {
      rows.push({
        id: `app:${app.port}`, label: app.name, group, tone: 'accent', data: { kind: 'app', app },
        detail: `${app.browser} · port ${app.port} · ${app.windows} window${app.windows === 1 ? '' : 's'}`
      })
    }
    rows.push(
      { id: 'launch', label: 'Start an app with a DevTools port…', group: 'Other ways', detail: 'Electron or Chromium app', data: { kind: 'launch' } },
      { id: 'port', label: 'Type a DevTools port…', group: 'Other ways', detail: 'an app started with --remote-debugging-port', data: { kind: 'port' } },
      { id: 'bridge', label: 'Use the page bridge…', group: 'Other ways', detail: 'a web view with no DevTools port', data: { kind: 'bridge' } },
      { id: 'web', label: 'Annotate a web page instead…', group: 'Other ways', detail: 'opens a browser window', data: { kind: 'web' } }
    )
    return rows
  }

  private chooseApp(row: AppRow): Promise<void> | void {
    if (row.kind === 'port') return this.openField('port')
    if (row.kind === 'launch') return this.openField('path')
    if (row.kind === 'web') {
      this.view = 'notes'
      return this.openField('address')
    }
    if (row.kind === 'bridge') return this.attempt(() => this.attachBridge())
    return this.attempt(async () => {
      await this.attachApp(row.app.endpoint, row.app.name)
      return `Attached to ${row.app.name}.`
    })
  }

  // ---- Notes ------------------------------------------------------------------------------------

  async reload(): Promise<void> {
    try {
      const result = await this.options.call<{ notes: Note[]; sessionId: string }>('terminal.annotations.list')
      this.notes = result.notes
      this.sessionId = result.sessionId
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.noteList.setRows(this.rows())
    this.allList.setRows(this.allRows())
    this.options.changed()
  }

  /** The Annotate tab: this session's unsent and sent annotations. */
  rows(): ListRow<NoteRow>[] {
    const waiting = unsent(this.notes ?? [], this.sessionId)
    const sent = (this.notes ?? []).filter(note => section(note, this.sessionId) === 'Sent')
    const row = (note: Note, group: string): ListRow<NoteRow> => {
      const delivery = note.delivery!
      const state = delivery.state === 'sent' ? `sent · ${describeTarget(note.target)}`
        : `${describeTarget(note.target)}${delivery.confirm ? ' · confirm before sending' : delivery.autoSend ? ' · sends when the agent finishes' : ''}`
      return {
        id: `note:${note.id}`, label: clip(note.body.replace(/\s+/g, ' '), 60), group, detail: state,
        tone: delivery.state === 'sent' ? 'muted' : delivery.confirm ? 'warning' : 'accent',
        data: { kind: 'note', note }
      }
    }
    return [...waiting.map(note => row(note, `Unsent (${waiting.length})`)), ...sent.map(note => row(note, 'Sent'))]
  }

  private shared(note: Note): boolean {
    return note.grants.some(grant => grant.principal.sessionId && grant.principal.sessionId === this.sessionId)
  }

  /** The All annotations tab: every saved annotation. */
  allRows(): ListRow<NoteRow>[] {
    return (this.notes ?? []).map(note => ({
      id: `note:${note.id}`, label: clip(note.body.replace(/\s+/g, ' '), 60), group: 'Annotations',
      detail: `${describeTarget(note.target)} · ${note.status}${this.shared(note) ? ' · shared here' : ''}`,
      tone: note.status === 'resolved' ? 'dim' : this.shared(note) ? 'success' : 'muted',
      searchText: `${note.body} ${note.source.url} ${note.source.title} ${note.tags.join(' ')}`,
      data: { kind: 'note', note }
    }))
  }

  /** Polls the inspector for the person's next comment, and the notes every few seconds. */
  private schedule(): void {
    if (this.disposed) return
    this.timer = setTimeout(() => void this.tick(), this.options.pollMs ?? 400)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.disposed) return
    if (!this.polling) {
      this.polling = true
      try {
        let changed = ++this.refreshes % 5 === 0
        if (this.target?.inspecting) {
          const step = await this.options.call<Step>('terminal.annotations.next')
          if (step.message) this.options.ui.notify(step.message, 'info')
          if (step.note) changed = true
          if (!step.active) { await this.refreshTarget(); this.options.changed() }
        } else if (this.target?.kind === 'bridge' && !this.target.windows.length) {
          // Waiting for the app to load the bridge script.
          await this.refreshTarget()
          if (this.target.windows.length) { await this.toggleInspect(true); changed = true }
        }
        if (changed) await this.reload()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.options.changed()
      } finally {
        this.polling = false
      }
    }
    this.schedule()
  }

  private async toggleInspect(on: boolean): Promise<void> {
    await this.options.call(on ? 'terminal.annotations.inspect' : 'terminal.annotations.stopInspect')
    await this.refreshTarget()
    this.options.changed()
  }

  /** Runs one action at a time; a key pressed meanwhile is answered, never dropped silently. */
  private async attempt(work: () => Promise<string | void>): Promise<void> {
    if (this.busy) {
      this.options.ui.notify('Still working on the last step. Try again in a moment.', 'info')
      return
    }
    this.busy = true
    try {
      const message = await work()
      if (message) this.options.ui.notify(message, 'info')
      this.error = undefined
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
    await this.reload()
  }

  sendAll(): Promise<void> {
    return this.attempt(() => sendUnsent(this.options.call, this.options.ui))
  }

  private chooseWindow(): Promise<void> {
    return this.attempt(async () => {
      await this.refreshTarget()
      const windows = this.target?.windows ?? []
      if (!windows.length) return 'No window is open.'
      const labels = windows.map(window => `${window.current ? '● ' : ''}${clip(window.title || window.url, 60)} — ${clip(window.url, 50)}`)
      const choice = await this.options.ui.select('Inspect which window?', labels)
      const index = choice ? labels.indexOf(choice) : -1
      if (index < 0) return
      await this.options.call('terminal.annotations.selectWindow', { window: windows[index].id })
      await this.refreshTarget()
    })
  }

  private async noteMenu(note: Note, from: AnnotateTab): Promise<void> {
    const { call, ui } = this.options
    const pendingHere = section(note, this.sessionId) === 'Unsent'
    const choices = from === 'annotate'
      ? [
          ANNOTATE_ACTIONS.reveal,
          ...(pendingHere ? [note.delivery?.confirm ? ANNOTATE_ACTIONS.confirm : ANNOTATE_ACTIONS.send] : []),
          ANNOTATE_ACTIONS.edit,
          ANNOTATE_ACTIONS.resolve,
          ANNOTATE_ACTIONS.delete
        ]
      : [
          ANNOTATE_ACTIONS.reveal,
          ANNOTATE_ACTIONS.edit,
          note.status === 'open' ? ANNOTATE_ACTIONS.resolve : ANNOTATE_ACTIONS.reopen,
          ...(note.status === 'open' ? [this.shared(note) ? ANNOTATE_ACTIONS.unshare : ANNOTATE_ACTIONS.share] : []),
          ANNOTATE_ACTIONS.delete
        ]
    const choice = await ui.select(`${clip(note.source.app?.name ?? note.source.title ?? note.source.url, 50)} · ${describeTarget(note.target)}`, choices)
    const id = note.id
    if (choice === ANNOTATE_ACTIONS.reveal) return this.attempt(async () => {
      const result = await call<{ state: string; reason?: string }>('terminal.annotations.reveal', { id })
      return result.state === 'matched' ? 'Marked in the window.' : `The target is ${result.state}${result.reason ? `: ${result.reason}` : ''}.`
    })
    if (choice === ANNOTATE_ACTIONS.confirm || choice === ANNOTATE_ACTIONS.send) return this.attempt(async () => {
      if (choice === ANNOTATE_ACTIONS.confirm) await call('terminal.annotations.confirm', { id, expectedVersion: note.version })
      return describeSend(await call('terminal.annotations.send', { ids: [id] }))
    })
    if (choice === ANNOTATE_ACTIONS.edit) return this.attempt(async () => {
      const body = await ui.input('Comment', note.body)
      if (!body?.trim() || body === note.body) return
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { body } })
    })
    if (choice === ANNOTATE_ACTIONS.resolve || choice === ANNOTATE_ACTIONS.reopen) return this.attempt(async () => {
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { status: choice === ANNOTATE_ACTIONS.resolve ? 'resolved' : 'open' } })
      return choice === ANNOTATE_ACTIONS.resolve ? 'Resolved.' : 'Reopened.'
    })
    if (choice === ANNOTATE_ACTIONS.share || choice === ANNOTATE_ACTIONS.unshare) return this.attempt(async () => {
      await call(choice === ANNOTATE_ACTIONS.share ? 'terminal.annotations.share' : 'terminal.annotations.unshare', { id })
      return choice === ANNOTATE_ACTIONS.share ? 'Shared with this session. It is unsent until you send it.' : 'No longer shared with this session.'
    })
    if (choice === ANNOTATE_ACTIONS.delete) return this.attempt(async () => {
      if (!await ui.confirm('Delete this annotation?', 'It cannot be restored.')) return
      await call('terminal.annotations.delete', { id, expectedVersion: note.version })
    })
  }

  // ---- Input and rendering -------------------------------------------------------------------------

  private currentList(): FilterList<NoteRow> | FilterList<AppRow> {
    if (this.tab === 'all') return this.allList
    return this.view === 'apps' ? this.appList : this.noteList
  }

  handleMouse(event: TerminalMouseInput) {
    return this.currentList().handleMouse({ ...event, y: event.y - this.listTop })
  }

  handleInput(data: string): boolean {
    if (this.tab === 'all') {
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { this.selectTab('annotate'); return true }
      if (matchesKey(data, 'escape')) return this.allList.query ? this.allList.handleInput(data) : false
      return this.allList.handleInput(data)
    }
    if (this.field) {
      if (matchesKey(data, 'escape')) { this.closeField(); return true }
      if (matchesKey(data, 'enter')) { this.submitField(); return true }
      this.field.input.handleInput(data)
      return true
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { this.selectTab('all'); return true }
    if (this.view === 'apps') {
      if (matchesKey(data, 'escape')) { this.view = 'notes'; this.syncFocus(); return true }
      if (data === 'r') { void this.showApps(); return true }
      return this.appList.handleInput(data)
    }
    if (data === 'i') { void this.attempt(() => this.toggleInspect(!this.target?.inspecting)); return true }
    if (data === 's') { void this.sendAll(); return true }
    if (data === 't') { void this.chooseWindow(); return true }
    if (data === 'o') { this.openField('address'); return true }
    if (data === 'a') { void this.showApps(); return true }
    return this.noteList.handleInput(data)
  }

  private header(width: number): string[] {
    const theme = this.options.theme()
    const target = this.target
    const current = target?.windows.find(window => window.current)
    const kind = !target ? 'No window yet' : target.kind === 'web' ? 'Browser window' : target.kind === 'cdp' ? `App · ${target.app?.name ?? ''} (DevTools)` : `App · ${target.app?.name ?? ''} (page bridge)`
    const lines = [
      `${theme.bold(kind)}${current ? theme.fg('muted', ` · ${clip(current.title || current.url, 40)} · ${clip(current.url, 60)}`) : ''}`,
      !target
        ? theme.fg('dim', 'Type a page address, or press a to annotate a desktop app.')
        : target.inspecting
          ? theme.fg('success', '● Inspecting: hover a component in the window and click it. The agent can read every annotation.')
          : theme.fg('dim', '○ Inspector off. Press i to turn it on.')
    ]
    if (this.bridgeSnippet && target?.kind === 'bridge') {
      lines.push(theme.fg(target.windows.length ? 'dim' : 'warning', `Load in the app while developing: ${this.bridgeSnippet}`))
    }
    if (this.error) lines.push(theme.fg('error', this.error))
    if (this.field) {
      const { label } = FIELDS[this.field.kind]
      const prefix = `${theme.fg('accent', '›')} ${theme.bold(label)}  `
      const room = Math.max(1, width - visibleWidth(prefix))
      lines.push('', prefix + (this.field.input.render(room)[0] ?? ''))
    }
    lines.push('')
    return lines.map(line => truncateToWidth(line, width, ''))
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.tab === 'all') {
      this.listTop = 0
      if (!this.notes) return [theme.fg('dim', this.error ? `Could not read web annotations: ${this.error}` : 'Reading web annotations…')]
      return this.allList.render(width, rows).slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    const header = this.header(width)
    this.listTop = header.length
    if (!this.notes) return [...header, theme.fg('dim', 'Reading annotations…')].slice(0, rows)
    const body = this.currentList().render(width, Math.max(1, rows - header.length))
    return [...header, ...body].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
