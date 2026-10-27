// Sending page notes to a session (PROP-0018, PROP-0048). Every note a person makes in the inspector
// is shared with their session at once and waits there, unsent. "Annotate & send", `s` or
// `/annotate:submit` sends all of the session's unsent notes as one message. A terminal session
// receives it as a new run here; a host's own session gets the composed text back, starts the run
// itself and reports the run id with `delivered`. A send while the session is busy goes out when its
// run ends.
import type { Bus } from '../core/bus'
import { HarnessError, invalid } from '../core/errors'
import { compose, MAX_SEND } from './queue'
import * as store from './store'

export interface TerminalSender {
  has(sessionId: string): boolean
  send(input: { sessionId: string; text: string }): Promise<{ runId: string }>
}

export type SendResult =
  | { state: 'sent'; runId: string; ids: string[] }
  | { state: 'busy'; ids: string[] }
  | { state: 'host'; text: string; ids: string[] }
  | { state: 'empty'; ids: []; unconfirmed: number }

export type NoteAction = 'save' | 'send'

export interface NoteDeliveryOptions {
  root: () => string
  bus: Bus
  terminals: () => TerminalSender | null
  /** Waits between tries to send notes held back while a run ends; tests shorten it. */
  retryDelays?: readonly number[]
}

const RETRY_DELAYS = [250, 1_000, 3_000, 8_000] as const

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

export class NoteDeliveries {
  private readonly sending = new Set<string>()
  private readonly retrying = new Set<string>()
  private readonly again = new Set<string>()

  constructor(private readonly options: NoteDeliveryOptions) {}

  private changed(sessionId: string | null, ids: string[]): void {
    this.options.bus.emit({ type: 'annotations.changed', sessionId, ids })
  }

  /** Shares a saved note with the session; it waits there, unsent. */
  share(id: string, expectedVersion: number | undefined, sessionId: string): store.Note {
    const note = store.markPending(this.options.root(), id, expectedVersion, sessionId)
    this.changed(sessionId, [id])
    return note
  }

  /**
   * Creates a note and acts on it in one step: what the popover's two buttons do. With a session the
   * note is always shared with it. `trusted` is false when the comment came from a script the page
   * could reach; it then waits for the person to confirm it before it is ever sent.
   */
  async createAndAct(input: store.NoteInput, action: NoteAction, sessionId: string | null, trusted: boolean): Promise<{ note: store.Note; send: SendResult | null }> {
    if (action !== 'save' && action !== 'send') throw invalid('action is save or send.')
    if (action === 'send' && !sessionId) throw invalid('Sending a note needs a session.')
    const root = this.options.root()
    let note = store.create(root, input)
    if (!sessionId) {
      this.changed(null, [note.id])
      return { note, send: null }
    }
    // A send that cannot go out yet (busy, or waiting for confirmation) goes when the session is idle.
    note = store.markPending(root, note.id, undefined, sessionId, { ...(action === 'send' ? { autoSend: true } : {}), ...(trusted ? {} : { confirm: true }) })
    this.changed(sessionId, [note.id])
    if (action === 'save' || !trusted) return { note, send: null }
    const send = await this.send(sessionId)
    return { note: store.read(root, note.id), send }
  }

  /** The person confirms a note the page could have forged; it is then sent with the next send. */
  confirm(id: string, expectedVersion: number | undefined): store.Note {
    const root = this.options.root()
    const note = store.read(root, id)
    if (note.delivery?.state !== 'pending') throw invalid('This note is not waiting to be sent.')
    const confirmed = store.markPending(root, id, expectedVersion, note.delivery.sessionId, { confirmed: true })
    this.changed(confirmed.delivery!.sessionId, [id])
    return confirmed
  }

  /** Confirms every page-origin note of the session at once; the person checked them in one prompt. */
  confirmAll(sessionId: string): store.Note[] {
    const notes = store.pending(this.options.root(), sessionId).filter((note) => note.delivery?.confirm)
    return notes.map((note) => this.confirm(note.id, note.version))
  }

  /** `/annotate:clear`: the session's unsent notes are resolved and stop being shared with it. */
  clear(sessionId: string): store.Note[] {
    const cleared = store.clearPending(this.options.root(), sessionId)
    if (cleared.length) this.changed(sessionId, cleared.map((note) => note.id))
    return cleared
  }

  private sendable(sessionId: string, filter: { ids?: string[] | null; auto?: boolean }): { notes: store.Note[]; unconfirmed: number } {
    const waiting = store.pending(this.options.root(), sessionId, { ids: filter.ids ?? null, auto: filter.auto === true })
    if (filter.ids != null && waiting.some((note) => note.delivery?.confirm)) throw invalid('Confirm page-origin notes before sending them.')
    const unconfirmed = waiting.filter((note) => note.delivery?.confirm === true).length
    return { notes: waiting.filter((note) => note.delivery?.confirm !== true).slice(0, MAX_SEND), unconfirmed }
  }

  /** The message for the session's unsent notes (or the given ones), for a host that runs it itself. */
  compose(sessionId: string, ids?: string[] | null, prompt?: string | null): { text: string; ids: string[] } {
    const { notes } = this.sendable(sessionId, { ids: ids ?? null })
    if (!notes.length) throw invalid('No confirmed notes are waiting for this session.')
    return { text: compose(notes, prompt), ids: notes.map((note) => note.id) }
  }

  /** A host started `runId` with composed notes. */
  delivered(ids: string[], sessionId: string, runId: string): store.Note[] {
    const sent = store.markSent(this.options.root(), ids, sessionId, runId)
    this.changed(sessionId, ids)
    return sent
  }

  /** Sends the session's unsent notes (or the given ones) as one run, with the person's own request when given. */
  async send(sessionId: string, filter: { ids?: string[] | null; auto?: boolean; prompt?: string | null } = {}): Promise<SendResult> {
    const root = this.options.root()
    const { notes, unconfirmed } = this.sendable(sessionId, filter)
    if (!notes.length) return { state: 'empty', ids: [], unconfirmed }
    const ids = notes.map((note) => note.id)
    const text = compose(notes, filter.prompt)
    const terminals = this.options.terminals()
    if (!terminals?.has(sessionId)) {
      // A host's session: the host starts the run and reports it with `delivered`.
      if (filter.auto) this.options.bus.emit({ type: 'annotations.ready', sessionId, ids })
      return { state: 'host', text, ids }
    }
    if (this.sending.has(sessionId)) return { state: 'busy', ids }
    this.sending.add(sessionId)
    try {
      const { runId } = await terminals.send({ sessionId, text })
      store.markSent(root, ids, sessionId, runId)
      this.changed(sessionId, ids)
      return { state: 'sent', runId, ids }
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'session_busy') {
        // Send it when the run ends. A request typed with /annotate:submit is not kept: the notes stay
        // unsent and the person submits again.
        if (filter.prompt?.trim()) return { state: 'busy', ids }
        for (const note of notes) if (!note.delivery?.autoSend) store.markPending(root, note.id, undefined, sessionId, { autoSend: true })
        this.changed(sessionId, ids)
        return { state: 'busy', ids }
      }
      throw error
    } finally {
      this.sending.delete(sessionId)
    }
  }

  /**
   * A run of the session ended: notes waiting for it to be idle go out now. The terminal can still
   * report the turn as active for a moment, so a busy answer is tried again a few times.
   */
  async runEnded(sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return
    if (this.retrying.has(sessionId)) {
      // Another run ended while we were still trying: start over once the current tries finish.
      this.again.add(sessionId)
      return
    }
    this.retrying.add(sessionId)
    try {
      for (const delay of this.options.retryDelays ?? RETRY_DELAYS) {
        await wait(delay)
        if (!store.pending(this.options.root(), sessionId, { auto: true }).length) return
        const result = await this.send(sessionId, { auto: true })
        if (result.state !== 'busy') return
      }
    } finally {
      this.retrying.delete(sessionId)
      if (this.again.delete(sessionId)) void this.runEnded(sessionId).catch(() => undefined)
    }
  }
}
