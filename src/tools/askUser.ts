// Asking the person a question and waiting for the answer: part of every session.
import type { ActiveRun, QuestionAnswer } from '../sessions/registry'
import type { ToolSpec } from './types'

export const ASK_USER = 'ask_user'
const MAX_OPTIONS = 6

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The answer as the model reads it. */
export function describeAnswer(answer: QuestionAnswer): string {
  const parts: string[] = []
  if (answer.selected.length) parts.push(`The user chose: ${answer.selected.join(', ')}.`)
  if (answer.text) parts.push(answer.selected.length ? `They added: ${answer.text}` : `The user answered: ${answer.text}`)
  return parts.join(' ') || 'The user did not answer.'
}

export function askUserTool(run: ActiveRun): ToolSpec {
  return {
    name: ASK_USER,
    label: 'Ask the user',
    description:
      'Ask the user a question and wait for the answer. Offer up to 6 short options when the choices are clear; ' +
      'set multiSelect when several can apply. The user can also type their own answer. Use it when you need a decision, not for small talk.',
    parameters: (Type) =>
      Type.Object({
        question: Type.String({ description: 'The question, in one sentence' }),
        options: Type.Optional(
          Type.Array(Type.Object({ label: Type.String({ description: 'A short choice' }), description: Type.Optional(Type.String({ description: 'One line about what it means' })) }), { maxItems: MAX_OPTIONS })
        ),
        multiSelect: Type.Optional(Type.Boolean()),
        allowText: Type.Optional(Type.Boolean({ description: 'Let the user type their own answer (default true)' }))
      }),
    execute: async (input) => {
      const question = text(input.question)
      if (!question) return 'The question is empty.'
      const options = (Array.isArray(input.options) ? input.options : [])
        .map((option) => ({ label: text((option as { label?: unknown }).label), description: text((option as { description?: unknown }).description) }))
        .filter((option) => option.label)
        .slice(0, MAX_OPTIONS)
        .map((option) => (option.description ? option : { label: option.label }))
      return describeAnswer(await run.requestAnswer({ question, options, multiSelect: options.length > 1 && input.multiSelect === true, allowText: options.length === 0 || input.allowText !== false }))
    }
  }
}
