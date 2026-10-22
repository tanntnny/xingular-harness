import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { QuestionAnswer } from '../../sessions/registry'
import { createQuestionPicker, type QuestionPickerResult } from './questionPicker'

export interface TerminalQuestion {
  requestId: string
  question?: string
  summary?: string
  options: { label: string; description?: string; recommended?: boolean }[]
  multiSelect?: boolean
  allowText?: boolean
  batchId?: string
  batchIndex?: number
  batchCount?: number
}

/** Answers stay local until the complete group can be submitted to the registry. */
export async function answerTerminalQuestion(ui: ExtensionUIContext, request: TerminalQuestion, signal: AbortSignal): Promise<QuestionAnswer | undefined> {
  const choices = request.options
  const progress = request.batchId ? `${request.batchIndex} of ${request.batchCount} · ` : ''
  const title = `${progress}${request.summary ?? 'Question'}`
  const inputTitle = `${progress}${request.summary ? `${request.summary}: ` : ''}${request.question ?? 'Question'}`
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('Every question needs at least one choice.')
  if (!choices.some(choice => choice.recommended)) throw new Error('Every question needs at least one recommended choice.')
  let selected: string[] = []
  while (!signal.aborted) {
    let cancelPicker = () => {}
    const onAbort = () => cancelPicker()
    signal.addEventListener('abort', onAbort, { once: true })
    const picker = ui.custom<QuestionPickerResult>((tui, theme, _keybindings, done) => {
      cancelPicker = () => done({ type: 'cancel' })
      if (signal.aborted) cancelPicker()
      return createQuestionPicker(tui, theme, title, request.question, choices, request.multiSelect === true, request.allowText !== false, selected, done)
    })
    let result: QuestionPickerResult | undefined
    try {
      result = await picker
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    if (!result || result.type === 'cancel' || signal.aborted) return undefined
    selected = result.selected
    if (result.type === 'answer') return { selected }
    const text = await ui.input(inputTitle, undefined, { signal })
    if (signal.aborted) return undefined
    if (text !== undefined) return { selected, text }
  }
  return undefined
}
