// Sending a session's unsent annotations (PROP-0048), shared by the annotate page's `s` and
// `/annotate:submit`. Annotations a page script could have written wait for one confirmation that
// covers all of them; every outcome is told to the person, so a send never fails silently.
import type { MenuCall } from '../pluginMenu'
import type { Note } from '../../annotations/store'

type SendResult =
  | { state: 'sent'; ids: string[] }
  | { state: 'busy'; ids: string[] }
  | { state: 'host'; ids: string[] }
  | { state: 'empty'; ids: []; unconfirmed?: number }

export interface AnnotateSendUi {
  confirm(title: string, message: string): Promise<boolean>
}

const count = (n: number): string => `${n} annotation${n === 1 ? '' : 's'}`

/** Unsent annotations of `sessionId`, oldest first. */
export function unsent(notes: readonly Note[], sessionId: string | null): Note[] {
  return notes
    .filter((note) => note.status === 'open' && note.delivery?.state === 'pending' && note.delivery.sessionId === sessionId)
    .sort((left, right) => left.delivery!.queuedAt.localeCompare(right.delivery!.queuedAt))
}

/**
 * Sends every unsent annotation of this terminal's session, with `prompt` after them when given.
 * Returns what to tell the person.
 */
export async function sendUnsent(call: MenuCall, ui: AnnotateSendUi, options: { prompt?: string } = {}): Promise<string> {
  const listed = await call<{ notes: Note[]; sessionId: string }>('terminal.annotations.list')
  const waiting = unsent(listed.notes, listed.sessionId)
  if (!waiting.length) {
    return options.prompt
      ? 'No unsent annotations. Annotate something with /annotate: first, or send your request as a normal message.'
      : 'Nothing to send. Annotate something first.'
  }
  const unconfirmed = waiting.filter((note) => note.delivery?.confirm)
  if (unconfirmed.length) {
    const yes = await ui.confirm(`Send ${count(waiting.length)} to the agent?`, `${count(unconfirmed.length)} came from the app's own page scripts, which could have written them. Check that the comments are yours.`)
    if (!yes) return 'Nothing was sent.'
    await call('terminal.annotations.confirmAll')
  }
  const result = await call<SendResult>('terminal.annotations.send', options.prompt ? { prompt: options.prompt } : {})
  return describeSend(result, !!options.prompt)
}

export function describeSend(result: SendResult, withPrompt = false): string {
  if (result.state === 'sent') return `Sent ${count(result.ids.length)} to the agent.`
  if (result.state === 'busy' && withPrompt) return 'The agent is still working. Submit again when it finishes; your annotations stay unsent.'
  if (result.state === 'busy') return `The agent is working; ${count(result.ids.length)} go${result.ids.length === 1 ? 'es' : ''} out when it finishes.`
  if (result.state === 'host') return `${count(result.ids.length)} handed to the app to send.`
  return result.unconfirmed ? `${count(result.unconfirmed)} still wait for your confirmation.` : 'Nothing to send.'
}
