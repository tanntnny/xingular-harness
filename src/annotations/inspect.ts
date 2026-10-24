// One step of the inspector loop (PROP-0018), shared by the terminal and a host: read the next
// comment from the capture target, keep it as a note, act on the button the person pressed, and
// tell them in the page what happened. Whether a send goes straight to the agent depends on where
// the comment came from, never on what the page or a client claims.
import { now } from '../core/fs'
import type { AnnotationCapture, InspectState } from './capture'
import type { NoteDeliveries, SendResult } from './delivery'
import type { Note } from './store'

export interface InspectStep extends Omit<InspectState, 'result'> {
  note: Note | null
  send: SendResult | null
  /** What the person was told in the page. */
  message: string | null
}

function message(action: 'save' | 'queue' | 'send', note: Note, send: SendResult | null, sessionId: string | null): string {
  if (action === 'save' || !sessionId) return 'Annotation saved'
  if (action === 'queue') return 'Added to the agent\'s queue'
  if (note.delivery?.confirm) return 'Queued — confirm sending it in the panel'
  if (send?.state === 'sent') return 'Sent to the agent'
  if (send?.state === 'busy') return 'Queued — it goes to the agent when it finishes'
  return 'Sending to the agent'
}

export async function inspectStep(capture: AnnotationCapture, notes: NoteDeliveries, key: string, sessionId: string | null, surface: string): Promise<InspectStep> {
  const state = await capture.next(key)
  const { result, ...rest } = state
  if (!result) return { ...rest, note: null, send: null, message: null }
  const action = sessionId ? result.action : 'save'
  const { note, send } = await notes.createAndAct({
    source: { url: result.url, title: result.title, capturedAt: now(), surface, representationHint: result.documentId, ...(state.app ? { app: state.app } : {}) },
    target: result.target,
    body: result.body
  }, action, sessionId, state.trusted)
  const text = message(action, note, send, sessionId)
  await capture.toast(key, text).catch(() => undefined)
  return { ...rest, note, send, message: text }
}
