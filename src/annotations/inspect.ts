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

function message(action: 'save' | 'send', note: Note, send: SendResult | null, sessionId: string | null): string {
  if (!sessionId) return 'Annotation saved'
  if (note.delivery?.confirm) return action === 'send' ? 'Annotated — confirm sending it in the terminal' : 'Annotated — confirm it in the terminal before it is sent'
  if (action === 'save') return 'Annotated — the agent can read it'
  if (send?.state === 'sent') return 'Sent to the agent'
  if (send?.state === 'busy') return 'Annotated — it goes to the agent when it finishes'
  return 'Sending to the agent'
}

export async function inspectStep(capture: AnnotationCapture, notes: NoteDeliveries, key: string, sessionId: string | null, surface: string): Promise<InspectStep> {
  const state = await capture.next(key)
  const { result, ...rest } = state
  if (!result) return { ...rest, note: null, send: null, message: null }
  // Anything but a send is a save, whatever the page reports.
  const action = sessionId && result.action === 'send' ? 'send' : 'save'
  const { note, send } = await notes.createAndAct({
    source: { url: result.url, title: result.title, capturedAt: now(), surface, representationHint: result.documentId, ...(state.app ? { app: state.app } : {}) },
    target: result.target,
    body: result.body
  }, action, sessionId, state.trusted)
  const text = message(action, note, send, sessionId)
  await capture.toast(key, text).catch(() => undefined)
  return { ...rest, note, send, message: text }
}
