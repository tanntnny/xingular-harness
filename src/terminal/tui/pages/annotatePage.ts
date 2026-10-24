/**
 * The annotate pane (`/plugin:annotate`, PROP-0018): the person works in a browser window or an app's own
 * windows, and this page is the panel beside it. With the inspector on, hovering outlines a
 * component and a click opens a comment popover with three choices: keep it as a note, add it to
 * this session's queue, or send it to the agent now. The page lists the queue, what was sent and
 * what the agent says it fixed, and the notes kept on the side.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'

import type { MenuCall, MenuUi } from '../../pluginMenu'
import type { TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'
import type { Note, NoteApp, NoteTarget } from '../../../annotations/store'

export type AnnotateStart =
  | { kind: 'web'; url?: string }
  | { kind: 'cdp'; endpoint: string; name?: string }
  | { kind: 'bridge'; name?: string }

export interface AnnotatePageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  changed(): void
  start: AnnotateStart
  /** How often the inspector is asked for the person's next comment, in milliseconds. */
  pollMs?: number
}

interface TargetState {
  kind: 'web' | 'cdp' | 'bridge'
  app: NoteApp | null
  inspecting: boolean
  windows: { id: string; url: string; title: string; current: boolean }[]
}

interface Step {
  active: boolean
  note: Note | null
  message: string | null
}

type Row = { kind: 'note'; note: Note }

const TABS = [{ id: 'annotate', title: 'Annotate' }] as const

export const ANNOTATE_ACTIONS = {
  reveal: 'Show it in the window',
  send: 'Send to the agent now',
  confirm: 'Confirm sending it (it came from the page)',
  queue: 'Ask the agent to fix it (add to queue)',
  dequeue: 'Take it out of the queue',
  edit: 'Edit the comment',
  resolve: 'Resolve',
  delete: 'Delete'
} as const

const clip = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

export function describeTarget(target: NoteTarget): string {
  if (target.kind === 'text') return `“${clip(target.exact.replace(/\s+/g, ' '), 50)}”`
  if (target.kind === 'element') return `<${target.tag}> ${clip(target.name || target.text || target.selector, 40)}`
  return 'whole page'
}

/** Which section of the panel a note belongs in, for this session; null when it is not shown. */
export function section(note: Note, sessionId: string | null): 'Queue' | 'Sent and fixed' | 'Saved' | null {
  if (note.status === 'resolved') return null
  const delivery = note.delivery
  if (delivery && delivery.sessionId === sessionId) return delivery.state === 'queued' ? 'Queue' : 'Sent and fixed'
  if (!delivery) return 'Saved'
  return null
}

export class AnnotatePage implements TerminalPage {
  presentation = 'fullscreen' as const
  private notes: Note[] | undefined
  private sessionId: string | null = null
  private target: TargetState | null = null
  private bridgeSnippet: string | null = null
  private error: string | undefined
  private busy = false
  private disposed = false
  private polling = false
  private timer: NodeJS.Timeout | null = null
  private refreshes = 0
  private readonly list: FilterList<Row>

  constructor(private readonly options: AnnotatePageOptions) {
    this.list = new FilterList<Row>({
      theme: options.theme, search: 'never', noun: ['note', 'notes'], empty: 'Nothing here yet. Press i and click a component in the window.',
      onActivate: row => { if (row.data) void this.noteMenu(row.data.note) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'annotate' }
  hint(): string {
    return `${this.target?.inspecting ? 'i stop inspecting' : 'i inspect'} · s send queue · x unqueue · t window · Enter note · Esc close`
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
    const { call } = this.options
    const start = this.options.start
    await this.attempt(async () => {
      if (start.kind === 'web') {
        const url = start.url ?? await this.options.ui.input('Page or dev server address', 'http://localhost:5173')
        if (!url) return
        await call('terminal.annotations.open', { url })
      } else if (start.kind === 'cdp') {
        await call('terminal.annotations.attach', { kind: 'cdp', endpoint: start.endpoint, ...(start.name ? { name: start.name } : {}) })
      } else {
        const attached = await call<{ bridge?: { snippet: string } }>('terminal.annotations.attach', { kind: 'bridge', ...(start.name ? { name: start.name } : {}) })
        this.bridgeSnippet = attached.bridge?.snippet ?? null
      }
      await this.refreshTarget()
      if (this.target?.windows.length || start.kind !== 'bridge') await this.toggleInspect(true)
      return start.kind === 'bridge' && !this.target?.windows.length ? 'Load the bridge script in the app (shown at the top), then reload the app.' : undefined
    })
    this.schedule()
  }

  private async refreshTarget(): Promise<void> {
    this.target = await this.options.call<TargetState>('terminal.annotations.target')
  }

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
    this.list.setRows(this.rows())
    this.options.changed()
  }

  rows(): ListRow<Row>[] {
    const order = ['Queue', 'Sent and fixed', 'Saved'] as const
    const rows: ListRow<Row>[] = []
    for (const group of order) {
      for (const note of (this.notes ?? []).filter(entry => section(entry, this.sessionId) === group)) {
        const delivery = note.delivery
        const state = !delivery ? describeTarget(note.target)
          : delivery.state === 'queued' ? `${describeTarget(note.target)}${delivery.confirm ? ' · confirm to send' : delivery.autoSend ? ' · sends when idle' : ''}`
            : delivery.state === 'fixed' ? `fixed: ${clip(delivery.summary ?? '', 50)}` : `sent · ${describeTarget(note.target)}`
        rows.push({
          id: `note:${note.id}`, label: clip(note.body.replace(/\s+/g, ' '), 60), group: group === 'Queue' ? `Queue (${this.queued().length})` : group,
          detail: state,
          tone: delivery?.state === 'fixed' ? 'success' : delivery?.confirm ? 'warning' : delivery?.state === 'queued' ? 'accent' : 'muted',
          data: { kind: 'note', note }
        })
      }
    }
    return rows
  }

  private queued(): Note[] {
    return (this.notes ?? []).filter(note => section(note, this.sessionId) === 'Queue')
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

  private async attempt(work: () => Promise<string | void>): Promise<void> {
    if (this.busy) return
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

  sendQueue(): Promise<void> {
    return this.attempt(async () => {
      const waiting = this.queued()
      if (!waiting.length) return 'The queue is empty.'
      const unconfirmed = waiting.filter(note => note.delivery?.confirm)
      if (unconfirmed.length) {
        if (!await this.options.ui.confirm(`Send ${waiting.length} note(s) to the agent?`, `${unconfirmed.length} came from the page's own scripts. Check that you wrote them.`)) return
        for (const note of unconfirmed) await this.options.call('terminal.annotations.confirm', { id: note.id, expectedVersion: note.version })
      }
      const result = await this.options.call<{ state: string; ids: string[] }>('terminal.annotations.send')
      return result.state === 'sent' ? `Sent ${result.ids.length} note(s) to the agent.` : result.state === 'busy' ? 'The agent is working; the queue goes out when it finishes.' : 'Nothing was sent.'
    })
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

  private async noteMenu(note: Note): Promise<void> {
    const { call, ui } = this.options
    const where = section(note, this.sessionId)
    const choices = [
      ANNOTATE_ACTIONS.reveal,
      ...(where === 'Queue' ? [note.delivery?.confirm ? ANNOTATE_ACTIONS.confirm : ANNOTATE_ACTIONS.send, ANNOTATE_ACTIONS.dequeue] : [ANNOTATE_ACTIONS.queue]),
      ANNOTATE_ACTIONS.edit,
      ANNOTATE_ACTIONS.resolve,
      ANNOTATE_ACTIONS.delete
    ]
    const choice = await ui.select(`${clip(note.source.app?.name ?? note.source.title ?? note.source.url, 50)} · ${describeTarget(note.target)}`, choices)
    const id = note.id
    if (choice === ANNOTATE_ACTIONS.reveal) return this.attempt(async () => {
      const result = await call<{ state: string; reason?: string }>('terminal.annotations.reveal', { id })
      return result.state === 'matched' ? 'Marked in the window.' : `The target is ${result.state}${result.reason ? `: ${result.reason}` : ''}.`
    })
    if (choice === ANNOTATE_ACTIONS.queue) return this.attempt(async () => {
      await call('terminal.annotations.queue', { id, expectedVersion: note.version })
      return 'Added to the queue.'
    })
    if (choice === ANNOTATE_ACTIONS.dequeue) return this.attempt(async () => {
      await call('terminal.annotations.dequeue', { id, expectedVersion: note.version })
    })
    if (choice === ANNOTATE_ACTIONS.confirm || choice === ANNOTATE_ACTIONS.send) return this.attempt(async () => {
      if (choice === ANNOTATE_ACTIONS.confirm) await call('terminal.annotations.confirm', { id, expectedVersion: note.version })
      const result = await call<{ state: string }>('terminal.annotations.send', { ids: [id] })
      return result.state === 'sent' ? 'Sent to the agent.' : result.state === 'busy' ? 'It goes to the agent when it finishes.' : undefined
    })
    if (choice === ANNOTATE_ACTIONS.edit) return this.attempt(async () => {
      const body = await ui.input('Comment', note.body)
      if (!body?.trim() || body === note.body) return
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { body } })
    })
    if (choice === ANNOTATE_ACTIONS.resolve) return this.attempt(async () => {
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { status: 'resolved' } })
      return 'Resolved.'
    })
    if (choice === ANNOTATE_ACTIONS.delete) return this.attempt(async () => {
      if (!await ui.confirm('Delete this note?', 'It cannot be restored.')) return
      await call('terminal.annotations.delete', { id, expectedVersion: note.version })
    })
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (data === 'i') { void this.attempt(() => this.toggleInspect(!this.target?.inspecting)); return true }
    if (data === 's') { void this.sendQueue(); return true }
    if (data === 't') { void this.chooseWindow(); return true }
    if (data === 'x') {
      const row = this.list.selected?.data
      if (row && section(row.note, this.sessionId) === 'Queue') void this.attempt(async () => { await this.options.call('terminal.annotations.dequeue', { id: row.note.id, expectedVersion: row.note.version }) })
      return true
    }
    return this.list.handleInput(data)
  }

  private header(width: number): string[] {
    const theme = this.options.theme()
    const target = this.target
    const current = target?.windows.find(window => window.current)
    const kind = !target ? 'Starting…' : target.kind === 'web' ? 'Browser window' : target.kind === 'cdp' ? `App · ${target.app?.name ?? ''} (DevTools)` : `App · ${target.app?.name ?? ''} (page bridge)`
    const lines = [
      `${theme.bold(kind)}${current ? theme.fg('muted', ` · ${clip(current.title || current.url, 40)} · ${clip(current.url, 60)}`) : ''}`,
      target?.inspecting
        ? theme.fg('success', '● Inspecting: hover a component in the window and click it to comment.')
        : theme.fg('dim', '○ Inspector off. Press i to turn it on.')
    ]
    if (this.bridgeSnippet && target?.kind === 'bridge') {
      lines.push(theme.fg(target.windows.length ? 'dim' : 'warning', `Load in the app while developing: ${this.bridgeSnippet}`))
    }
    if (this.error) lines.push(theme.fg('error', this.error))
    lines.push('')
    return lines.map(line => truncateToWidth(line, width, ''))
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    const header = this.header(width)
    if (!this.notes) return [...header, theme.fg('dim', 'Reading page notes…')].slice(0, rows)
    const body = this.list.render(width, Math.max(1, rows - header.length))
    return [...header, ...body].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
