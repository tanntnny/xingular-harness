// Sending page notes to a session (PROP-0018). A terminal session receives them as a new run here;
// a host's own session gets the composed text back and starts the run itself, then reports the
// run id with `delivered`. Notes a person sent with "Proceed now" while the session was busy go
// out when its run ends.
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
  | { state: 'empty'; ids: [] }

export type NoteAction = 'save' | 'queue' | 'send'

export interface NoteDeliveryOptions {
  root: () => string
  bus: Bus
  terminals: () => TerminalSender | null
}

export class NoteDeliveries {
  private readonly sending = new Set<string>()

  constructor(private readonly options: NoteDeliveryOptions) {}

  private changed(sessionId: string | null, ids: string[]): void {
    this.options.bus.emit({ type: 'annotations.changed', sessionId, ids })
  }

  queue(id: string, expectedVersion: number | undefined, sessionId: string, options: { autoSend?: boolean; confirm?: boolean } = {}): store.Note {
    const note = store.queue(this.options.root(), id, expectedVersion, sessionId, options)
    this.changed(sessionId, [id])
    return note
  }

  dequeue(id: string, expectedVersion: number | undefined): store.Note {
    const note = store.dequeue(this.options.root(), id, expectedVersion)
    this.changed(null, [id])
    return note
  }

  /**
   * Creates a note and acts on it in one step: what the popover's three buttons do. `trusted` is
   * false when the comment came from a script the page could reach; a send then waits in the queue
   * for the person to confirm it.
   */
  async createAndAct(input: store.NoteInput, action: NoteAction, sessionId: string | null, trusted: boolean): Promise<{ note: store.Note; send: SendResult | null }> {
    if (!['save', 'queue', 'send'].includes(action)) throw invalid('action is save, queue or send.')
    if (action !== 'save' && !sessionId) throw invalid('Queueing or sending a note needs a session.')
    const root = this.options.root()
    let note = store.create(root, input)
    if (action === 'save') {
      this.changed(null, [note.id])
      return { note, send: null }
    }
    const deliveryOptions = {
      ...(action === 'send' ? { autoSend: true } : {}),
      ...(!trusted ? { confirm: true } : {})
    }
    note = store.queue(root, note.id, undefined, sessionId!, deliveryOptions)
    this.changed(sessionId, [note.id])
    if (action === 'queue' || !trusted) return { note, send: null }
    const send = await this.send(sessionId!, { ids: [note.id] })
    return { note: store.read(root, note.id), send }
  }

  /** The person confirms a note the page could have forged; it is then sent with the next send. */
  confirm(id: string, expectedVersion: number | undefined): store.Note {
    const root = this.options.root()
    const note = store.read(root, id)
    if (note.delivery?.state !== 'queued') throw invalid('This note is not waiting to be sent.')
    const confirmed = store.queue(root, id, expectedVersion, note.delivery.sessionId, { autoSend: note.delivery.autoSend === true, confirmed: true })
    this.changed(confirmed.delivery!.sessionId, [id])
    return confirmed
  }

  /** The instruction for the session's queued notes (or the given ones), for a host that runs it itself. */
  compose(sessionId: string, ids?: string[] | null): { text: string; ids: string[] } {
    const waiting = store.queued(this.options.root(), sessionId, { ids: ids ?? null })
    if (ids != null && waiting.some((note) => note.delivery?.confirm)) throw invalid('Confirm page-origin notes before composing them.')
    const notes = waiting.filter((note) => note.delivery?.confirm !== true).slice(0, MAX_SEND)
    if (!notes.length) throw invalid('No confirmed notes are waiting for this session.')
    return { text: compose(notes), ids: notes.map((note) => note.id) }
  }

  /** A host started `runId` with composed notes. */
  delivered(ids: string[], sessionId: string, runId: string): store.Note[] {
    const sent = store.markSent(this.options.root(), ids, sessionId, runId)
    this.changed(sessionId, ids)
    return sent
  }

  /** Sends the session's queued notes (or the given ones) as one run. */
  async send(sessionId: string, filter: { ids?: string[] | null; auto?: boolean } = {}): Promise<SendResult> {
    const root = this.options.root()
    const waiting = store.queued(root, sessionId, { ids: filter.ids ?? null, auto: filter.auto === true })
    if (filter.ids != null && waiting.some((note) => note.delivery?.confirm)) throw invalid('Confirm page-origin notes before sending them.')
    const notes = waiting.filter((note) => note.delivery?.confirm !== true).slice(0, MAX_SEND)
    if (!notes.length) return { state: 'empty', ids: [] }
    const ids = notes.map((note) => note.id)
    const terminals = this.options.terminals()
    if (!terminals?.has(sessionId)) {
      // A host's session: the host starts the run and reports it with `delivered`.
      if (filter.auto) this.options.bus.emit({ type: 'annotations.ready', sessionId, ids })
      return { state: 'host', text: compose(notes), ids }
    }
    if (this.sending.has(sessionId)) return { state: 'busy', ids }
    this.sending.add(sessionId)
    try {
      const { runId } = await terminals.send({ sessionId, text: compose(notes) })
      store.markSent(root, ids, sessionId, runId)
      this.changed(sessionId, ids)
      return { state: 'sent', runId, ids }
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'session_busy') {
        // Send it when the run ends.
        for (const note of notes) if (!note.delivery?.autoSend) store.queue(root, note.id, undefined, sessionId, { autoSend: true })
        this.changed(sessionId, ids)
        return { state: 'busy', ids }
      }
      throw error
    } finally {
      this.sending.delete(sessionId)
    }
  }

  /** A run of the session ended: notes waiting for it to be idle go out now. */
  async runEnded(sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return
    if (!store.queued(this.options.root(), sessionId, { auto: true }).length) return
    await this.send(sessionId, { auto: true })
  }

  markFixed(id: string, caller: { sessionId?: string | null; agentId?: string | null }, summary: string): store.Note {
    const note = store.markFixed(this.options.root(), id, caller, summary)
    this.changed(note.delivery?.sessionId ?? null, [id])
    return note
  }
}
