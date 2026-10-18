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
  for (const [choice, note] of Object.entries(answer.notes ?? {})) parts.push(`Their note for ${choice}: ${note}`)
  return parts.join(' ') || 'The user did not answer.'
}

export function askUserTool(run: Pick<ActiveRun, 'requestAnswers'>): ToolSpec {
  return {
    name: ASK_USER,
    label: 'Ask the user',
    description:
      'Ask the user one to five related questions in one request and wait until they answer the batch. Give each question a concise 2–3 word summary and aim to keep each question to 25 words or fewer. ' +
      'Offer up to 6 short options when the choices are clear; every option must include a helpful description of 25 words or fewer. Recommendations are visual only: they never preselect an answer, and submitted choices keep their original labels. Mark a recommended option with recommended: true instead of changing its label; mark at most one for a single-choice question, or several when multiSelect is true. Every question includes a free-text “Something else” answer. Set multiSelect when several can apply. Use it when you need a decision, not for small talk.',
    parameters: (Type) =>
      Type.Object({
        questions: Type.Array(Type.Object({
          summary: Type.String({ description: 'A concise 2–3 word summary label' }),
          question: Type.String({ description: 'A clear, standalone question; aim for 25 words or fewer' }),
          options: Type.Optional(
            Type.Array(Type.Object({
              label: Type.String({ description: 'A short choice; do not add a recommendation suffix to the label' }),
              description: Type.String({ description: 'Required. Briefly explain this choice in 25 words or fewer.' }),
              recommended: Type.Optional(Type.Boolean({ description: 'Whether to show this choice as a visual recommendation; it is not preselected, and answers use the original label' }))
            }), { maxItems: MAX_OPTIONS })
          ),
          multiSelect: Type.Optional(Type.Boolean())
        }), { minItems: 1, maxItems: 5 })
      }),
    execute: async (input) => {
      if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 5) return 'Ask between one and five questions.'
      const questions = input.questions.map((raw) => {
        const item = raw as Record<string, unknown>
        const summary = text(item.summary)
        const question = text(item.question)
        const options = (Array.isArray(item.options) ? item.options : [])
          .map((option) => {
            const choice = option as { label?: unknown; description?: unknown; recommended?: unknown }
            return {
              label: text(choice.label),
              description: text(choice.description),
              ...(choice.recommended === true ? { recommended: true } : {})
            }
          })
          .filter((option) => option.label)
          .slice(0, MAX_OPTIONS)
        const multiSelect = options.length > 1 && item.multiSelect === true
        return { summary, question, options, multiSelect, allowText: true }
      })
      if (questions.some((question) => !question.summary || question.summary.length > 100)) return 'Each question needs a short summary of no more than 100 characters.'
      if (questions.some((question) => !question.question)) return 'Every question needs a question sentence.'
      if (questions.some((question) => !question.multiSelect && question.options.filter((option) => option.recommended).length > 1)) return 'A single-choice question may recommend at most one option.'
      if (questions.some((question) => question.options.some((option) => !option.description))) return 'Every choice needs a short description. Aim for 25 words or fewer.'
      const answers = await run.requestAnswers(questions)
      return questions.map((question, index) => `${question.summary}: ${describeAnswer(answers[index])}`).join('\n')
    }
  }
}
