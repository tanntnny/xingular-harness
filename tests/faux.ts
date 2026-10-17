// A model that says what a test tells it to, so a real Pi session can run a real agent loop
// with no provider and no request leaving the machine. Pi ships it for this.
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import type { Harness } from '../src/harness'

export interface Faux {
  /** The model's id as a session names it. */
  model: string
  /** What the model answers, one entry per request, in order. */
  script(responses: unknown[]): void
  /** A reply made of text. */
  says(text: string): unknown
  /** A reply that calls tools. */
  calls(...calls: [name: string, args: Record<string, string | number | boolean>][]): unknown
  /** How many requests the model was sent. */
  requests(): number
  /** The text of the tool results in the last request the model was sent, by tool call order. */
  lastToolResults(): string[]
  /** The text of the user messages in the last request the model was sent, in order. */
  lastUserTexts(): string[]
}

/** Gives every account of this harness a scripted model. */
export async function fauxModel(harness: Harness): Promise<Faux> {
  const pi = await import('@earendil-works/pi-coding-agent')
  const ai = await import('@earendil-works/pi-ai')
  const faux = ai.fauxProvider()
  const none = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => undefined }
  const runtime = await pi.ModelRuntime.create({ credentials: none as never, modelsPath: null, refreshOnCreate: false })
  runtime.registerNativeProvider(faux.provider)
  harness.accounts.runtime = async () => runtime as ModelRuntime
  const model = faux.getModel()
  let seen: { role: string; content: unknown }[] = []
  return {
    model: `${model.provider}/${model.id}`,
    script: (responses) =>
      faux.setResponses(
        responses.map((response) => (context: { messages: { role: string; content: unknown }[] }) => {
          seen = context.messages
          return typeof response === 'function' ? response(context) : response
        }) as never
      ),
    says: (text) => ai.fauxAssistantMessage(text),
    calls: (...calls) => ai.fauxAssistantMessage(calls.map(([name, args]) => ai.fauxToolCall(name, args)), { stopReason: 'toolUse' }),
    requests: () => faux.state.callCount,
    lastToolResults: () => seen.filter((message) => message.role === 'toolResult').map((message) => (Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : String(message.content))),
    lastUserTexts: () => seen.filter((message) => message.role === 'user').map((message) => (Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : String(message.content)))
  }
}
