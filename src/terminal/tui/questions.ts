import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { QuestionAnswer } from '../../sessions/registry'

export interface TerminalQuestion {
  requestId: string
  question?: string
  summary?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  allowText?: boolean
  batchId?: string
  batchIndex?: number
  batchCount?: number
}

/** Answers stay local until the complete group can be submitted to the registry. */
export async function answerTerminalQuestion(ui: ExtensionUIContext, request: TerminalQuestion, signal: AbortSignal): Promise<QuestionAnswer | undefined> {
  const choices = request.options ?? []
  const selected: string[] = []
  const progress = request.batchId ? `${request.batchIndex} of ${request.batchCount} · ` : ''
  const title = `${progress}${request.summary ? request.summary + ': ' : ''}${request.question ?? 'Question'}`
  if (!choices.length) {
    if (request.allowText === false) return { selected }
    const text = await ui.input(title, undefined, { signal })
    return text === undefined || signal.aborted ? undefined : { selected, text }
  }
  while (!signal.aborted) {
    const labels = choices.map((option, index) => `${index + 1}. ${selected.includes(option.label) ? '✓ ' : ''}${option.label}${option.description ? ' — ' + option.description : ''}`)
    const menu = [...labels, ...(request.allowText !== false ? ['Write an answer'] : []), ...(request.multiSelect ? ['Submit choices'] : [])]
    const choice = await ui.select(title, menu, { signal })
    if (choice === undefined || signal.aborted) return undefined
    if (choice === 'Submit choices') return { selected }
    if (choice === 'Write an answer') {
      const text = await ui.input(title, undefined, { signal })
      if (signal.aborted) return undefined
      if (text !== undefined) return { selected, text }
      continue
    }
    const index = labels.indexOf(choice)
    if (index < 0) throw new Error('Choose one of the displayed answers.')
    const label = choices[index]!.label
    if (selected.includes(label)) selected.splice(selected.indexOf(label), 1)
    else selected.push(label)
    if (!request.multiSelect) return { selected }
  }
  return undefined
}
