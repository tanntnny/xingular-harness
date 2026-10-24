// Asking the person a question and waiting for the answer: part of every session.
import { QUESTION_SKETCH_MAX_LENGTH, QUESTION_SKETCH_PATTERN, questionSketchError } from '../sessions/contracts'
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
      'Ask the user one to five related questions in one request and wait until they answer the batch. Give each question a concise 1–2 word label and aim to keep each question to 25 words or fewer. ' +
      'Every question must offer 1–6 short choices, each with a helpful description of 25 words or fewer, and at least one choice must be marked recommended: true. Recommendations are visual only: they never preselect an answer, and submitted choices keep their original labels. Mark at most one recommended choice for a single-choice question, or several when multiSelect is true. Every question also includes a free-text “Something else” answer. Set multiSelect when several can apply. When a UI diagram helps compare choices, set uiSketch: true and give every choice a detailed, bounded ASCII wireframe. Use ASCII tables and panel borders to show the affected element with relevant neighboring UI, readable labels and spacing. Keep each panel’s outer `+` corners in fixed columns, include side edges at those same columns on every content row, and run horizontal borders corner to corner; if a title sits in a top border, leave at least two dashes on both sides. Keep framing consistent across alternatives and concentrate detail on what changes. Do not substitute a symbolic logo or one-line illustration. The preview supplies its outer border; draw internal borders only for actual UI panels. Use it when you need a decision, not for small talk.',
    parameters: (Type) =>
      Type.Object({
        questions: Type.Array(Type.Object({
          summary: Type.String({ description: 'A concise label of one or two words' }),
          question: Type.String({ description: 'A clear, standalone question; aim for 25 words or fewer' }),
          uiSketch: Type.Optional(Type.Literal(true, { description: 'Enable an ASCII sketch preview; when true, every choice must include a sketch.' })),
          options: Type.Array(Type.Object({
            label: Type.String({ description: 'A short choice; do not add a recommendation suffix to the label' }),
            description: Type.String({ description: 'Required. Briefly explain this choice in 25 words or fewer.' }),
            recommended: Type.Optional(Type.Boolean({ description: 'Whether to show this choice as a visual recommendation; at least one choice per question must be recommended, it is not preselected, and answers use the original label' })),
            sketch: Type.Optional(Type.String({ minLength: 1, maxLength: QUESTION_SKETCH_MAX_LENGTH, pattern: QUESTION_SKETCH_PATTERN, description: 'Literal ASCII UI wireframe: 1–24 LF-separated lines, at most 80 printable ASCII characters per line. Include the affected element and neighboring UI using structured table/panel borders with fixed, matching outer-edge columns on every row. Required for every choice when uiSketch is true.' }))
          }), {
            minItems: 1,
            maxItems: MAX_OPTIONS,
            contains: Type.Object({ recommended: Type.Literal(true) })
          }),
          multiSelect: Type.Optional(Type.Boolean())
        }), { minItems: 1, maxItems: 5 })
      }),
    execute: async (input) => {
      if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 5) return 'Ask between one and five questions.'
      let invalidSketchMode = false
      let invalidSketchValue = false
      const questions = input.questions.map((raw) => {
        const item = raw as Record<string, unknown>
        const summary = text(item.summary)
        const question = text(item.question)
        if (item.uiSketch !== undefined && item.uiSketch !== true) invalidSketchMode = true
        const options = (Array.isArray(item.options) ? item.options : [])
          .map((option) => {
            const choice = option as { label?: unknown; description?: unknown; recommended?: unknown; sketch?: unknown }
            if (choice.sketch !== undefined && typeof choice.sketch !== 'string') invalidSketchValue = true
            return {
              label: text(choice.label),
              description: text(choice.description),
              ...(choice.recommended === true ? { recommended: true } : {}),
              ...(typeof choice.sketch === 'string' ? { sketch: choice.sketch } : {})
            }
          })
          .filter((option) => option.label)
          .slice(0, MAX_OPTIONS)
        const multiSelect = options.length > 1 && item.multiSelect === true
        return { summary, question, options, ...(item.uiSketch === true ? { uiSketch: true as const } : {}), multiSelect, allowText: true }
      })
      if (questions.some((question) => !question.summary || question.summary.length > 100 || question.summary.split(/\s+/u).filter(Boolean).length > 2)) return 'Each question needs a concise 1–2 word summary label of no more than 100 characters.'
      if (questions.some((question) => !question.question)) return 'Every question needs a question sentence.'
      if (questions.some((question) => question.options.length === 0)) return 'Every question needs at least one choice.'
      if (questions.some((question) => !question.options.some((option) => option.recommended))) return 'Every question needs at least one recommended choice.'
      if (questions.some((question) => !question.multiSelect && question.options.filter((option) => option.recommended).length > 1)) return 'A single-choice question may recommend at most one option.'
      if (questions.some((question) => question.options.some((option) => !option.description))) return 'Every choice needs a short description. Aim for 25 words or fewer.'
      if (invalidSketchMode) return 'Set uiSketch to true to enable question sketches.'
      if (invalidSketchValue) return 'Each choice sketch must be text.'
      const sketchError = questions.map((question) => questionSketchError(question.uiSketch, question.options)).find(Boolean)
      if (sketchError) return sketchError
      const answers = await run.requestAnswers(questions)
      return questions.map((question, index) => `${question.summary}: ${describeAnswer(answers[index])}`).join('\n')
    }
  }
}
