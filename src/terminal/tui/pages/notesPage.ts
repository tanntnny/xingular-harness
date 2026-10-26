/**
 * The Web annotations page (`/annotate:notes`, `/annotate:annotate [url]`): comments a person keeps about web pages. A new annotation
 * is captured in a visible browser window: the whole page, text the person selects, or an element
 * they click. An annotation is private until it is shared with this session, whose agent can then read it
 * with `page_notes_read` (PROP-0017).
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'

import type { MenuCall, MenuUi } from '../../pluginMenu'
import type { TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'
import type { Note, NoteTarget } from '../../../annotations/store'

export interface NotesPageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  changed(): void
  /** Start a new annotation as soon as the page opens (`/annotate:annotate [url]`), on this address when given. */
  start?: { url?: string }
}

type Row = { kind: 'new' } | { kind: 'note'; note: Note }

const TABS = [{ id: 'notes', title: 'Web annotations' }] as const

export const NOTE_KINDS = { page: 'The whole page', text: 'Text I select in the window', element: 'An element I click in the window' } as const
export const NOTE_ACTIONS = {
  reveal: 'Show it in the browser window',
  edit: 'Edit the annotation',
  resolve: 'Mark resolved',
  reopen: 'Reopen',
  share: 'Let this session\'s agent read it',
  unshare: 'Stop sharing it with this session',
  delete: 'Delete'
} as const

const clip = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

function describeTarget(target: NoteTarget): string {
  if (target.kind === 'text') return `“${clip(target.exact.replace(/\s+/g, ' '), 60)}”`
  if (target.kind === 'element') return `<${target.tag}> ${clip(target.name || target.text, 50)}`
  return 'whole page'
}

export class NotesPage implements TerminalPage {
  presentation = 'centered' as const
  private notes: Note[] | undefined
  private sessionId: string | null = null
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<Row>

  constructor(private readonly options: NotesPageOptions) {
    this.list = new FilterList<Row>({
      theme: options.theme, search: 'always', noun: ['annotation', 'annotations'], empty: 'No web annotations yet',
      onActivate: row => { if (row.data) void this.activateRow(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void {
    void this.reload().then(() => {
      if (this.options.start) void this.newNote(this.options.start.url)
    })
  }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'notes' }
  hint(): string { return 'Enter choose · type to search · Esc close' }

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

  private shared(note: Note): boolean {
    return note.grants.some(grant => grant.principal.sessionId && grant.principal.sessionId === this.sessionId)
  }

  rows(): ListRow<Row>[] {
    const rows: ListRow<Row>[] = [{ id: 'new', label: 'New web annotation…', group: 'Actions', detail: 'opens a browser window', tone: 'accent', data: { kind: 'new' } }]
    for (const note of this.notes ?? []) {
      rows.push({
        id: `note:${note.id}`, label: clip(note.body.replace(/\s+/g, ' '), 60), group: 'Annotations',
        detail: `${describeTarget(note.target)} · ${note.status}${this.shared(note) ? ' · shared here' : ''}`,
        tone: note.status === 'resolved' ? 'dim' : this.shared(note) ? 'success' : 'muted',
        searchText: `${note.body} ${note.source.url} ${note.source.title} ${note.tags.join(' ')}`,
        data: { kind: 'note', note }
      })
    }
    return rows
  }

  private async attempt(work: () => Promise<string | void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const message = await work()
      if (message) this.options.ui.notify(message, 'info')
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
    await this.reload()
  }

  async activateRow(row: Row): Promise<void> {
    if (row.kind === 'new') return this.newNote()
    return this.noteMenu(row.note)
  }

  /** Opens the capture window, takes what the person points at, and saves their annotation. */
  newNote(startUrl?: string): Promise<void> {
    const { call, ui } = this.options
    return this.attempt(async () => {
      const url = startUrl ?? await ui.input('Page address', 'https://')
      if (!url) return
      await call('terminal.annotations.open', { url })
      const kind = await ui.select('What does the annotation point at?', Object.values(NOTE_KINDS))
      if (!kind) return
      let envelope: { url: string; title: string; documentId: string; target: NoteTarget } | null
      if (kind === NOTE_KINDS.page) {
        const identity = await call<{ url: string; title: string; documentId: string }>('terminal.annotations.identity')
        envelope = { ...identity, target: { kind: 'page' } }
      } else {
        const element = kind === NOTE_KINDS.element
        const { captureId } = await call<{ captureId: string }>('terminal.annotations.begin', { kind: element ? 'element' : 'text' })
        const ready = await ui.confirm(element ? 'Click the element in the browser window' : 'Select the text in the browser window', 'When it is selected, choose Yes to capture it. Choose No to cancel.')
        if (!ready) { await call('terminal.annotations.cancel', { captureId }); return }
        envelope = await call('terminal.annotations.capture', { captureId })
        if (!envelope) return 'Nothing was selected in the browser window, so no annotation was made.'
      }
      const body = await ui.input('Comment', 'What should change or be remembered?')
      if (!body?.trim()) return 'An annotation needs a comment; nothing was saved.'
      const tags = (await ui.input('Tags (optional, comma separated)', '') ?? '').split(',').map(tag => tag.trim()).filter(Boolean)
      const share = await ui.confirm('Share it with this session?', 'This session\'s agent can then read the annotation with page_notes_read. You can stop sharing it later.')
      await call('terminal.annotations.create', {
        source: { url: envelope.url, title: envelope.title, capturedAt: new Date().toISOString(), surface: 'terminal', representationHint: envelope.documentId },
        target: envelope.target, body, tags, share
      })
      return share ? 'Annotation saved and shared with this session.' : 'Annotation saved. It stays private until you share it.'
    })
  }

  private async noteMenu(note: Note): Promise<void> {
    const { call, ui } = this.options
    const choices = [
      NOTE_ACTIONS.reveal,
      NOTE_ACTIONS.edit,
      note.status === 'open' ? NOTE_ACTIONS.resolve : NOTE_ACTIONS.reopen,
      this.shared(note) ? NOTE_ACTIONS.unshare : NOTE_ACTIONS.share,
      NOTE_ACTIONS.delete
    ]
    const choice = await ui.select(`${clip(note.source.title || note.source.url, 60)} · ${describeTarget(note.target)}`, choices)
    const id = note.id
    if (choice === NOTE_ACTIONS.reveal) return this.attempt(async () => {
      const result = await call<{ state: string; reason?: string }>('terminal.annotations.reveal', { id })
      return result.state === 'matched' ? 'Marked in the browser window.' : `The target is ${result.state}${result.reason ? `: ${result.reason}` : ''}.`
    })
    if (choice === NOTE_ACTIONS.edit) return this.attempt(async () => {
      const body = await ui.input('Note', note.body)
      if (!body?.trim() || body === note.body) return
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { body } })
      return 'Annotation saved.'
    })
    if (choice === NOTE_ACTIONS.resolve || choice === NOTE_ACTIONS.reopen) return this.attempt(async () => {
      await call('terminal.annotations.update', { id, expectedVersion: note.version, patch: { status: choice === NOTE_ACTIONS.resolve ? 'resolved' : 'open' } })
    })
    if (choice === NOTE_ACTIONS.share || choice === NOTE_ACTIONS.unshare) return this.attempt(async () => {
      await call(choice === NOTE_ACTIONS.share ? 'terminal.annotations.share' : 'terminal.annotations.unshare', { id })
      return choice === NOTE_ACTIONS.share ? 'This session\'s agent can read the annotation.' : 'The annotation is no longer shared with this session.'
    })
    if (choice === NOTE_ACTIONS.delete) return this.attempt(async () => {
      if (!await ui.confirm('Delete this annotation?', 'It cannot be restored.')) return
      await call('terminal.annotations.delete', { id, expectedVersion: note.version })
      return 'Annotation deleted.'
    })
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.error) return [theme.fg('error', `Could not read web annotations: ${this.error}`)]
    if (!this.notes) return [theme.fg('dim', 'Reading web annotations…')]
    return this.list.render(width, rows).slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
