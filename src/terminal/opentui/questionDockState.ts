import type { QuestionAnswer } from '../../sessions/registry'
import type { TerminalDecision } from '../tui/runtime'

export type QuestionDockQuestion = Omit<TerminalDecision, 'options'> & {
  type: 'question'
  options: NonNullable<TerminalDecision['options']>
}
type QuestionOption = QuestionDockQuestion['options'][number]

export type QuestionDockFocus = 'options' | 'note' | 'answer' | 'action' | 'composer'

export interface QuestionDockOptionView extends QuestionOption {
  selected: boolean
  focused: boolean
  note: string
  noteOpen: boolean
  noteFocused: boolean
}

export interface QuestionDockView {
  question: string
  summary: string
  activeIndex: number
  count: number
  options: QuestionDockOptionView[]
  selected: readonly string[]
  text: string
  multiSelect: boolean
  allowText: boolean
  optionIndex: number
  focus: QuestionDockFocus
  collapsed: boolean
  actionLabel: string
}

export type QuestionDockAnswers = { questionId: string; answer: QuestionAnswer }[]

interface AnswerDraft {
  selected: string[]
  text: string
  notes: Record<string, string>
  openNotes: string[]
  skipped: boolean
}

const emptyAnswer = (): AnswerDraft => ({ selected: [], text: '', notes: {}, openNotes: [], skipped: false })

function orderedOptions(options: readonly QuestionOption[]): QuestionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => Number(right.option.recommended === true) - Number(left.option.recommended === true) || left.index - right.index)
    .map(({ option }) => option)
}

export class QuestionDockState {
  readonly result: Promise<QuestionDockAnswers | undefined>
  private readonly drafts: AnswerDraft[]
  private activeIndex = 0
  private optionIndex = 0
  private focus: QuestionDockFocus
  private noteLabel?: string
  private collapsed = false
  private settled = false
  private resolveResult!: (answers: QuestionDockAnswers | undefined) => void

  constructor(readonly questions: readonly QuestionDockQuestion[]) {
    if (questions.length === 0) throw new Error('A question dock needs at least one question.')
    if (questions.some(question => !Array.isArray(question.options) || question.options.length === 0)) throw new Error('Every question needs at least one choice.')
    if (questions.some(question => !question.options.some(option => option.recommended))) throw new Error('Every question needs at least one recommended choice.')
    this.drafts = questions.map(() => emptyAnswer())
    this.focus = this.firstFocus()
    this.result = new Promise(resolve => { this.resolveResult = resolve })
  }

  get view(): QuestionDockView {
    const question = this.questions[this.activeIndex]!
    const draft = this.drafts[this.activeIndex]!
    const options = orderedOptions(question.options)
    const allOtherQuestionsAnswered = this.drafts.every((answer, index) => index === this.activeIndex || this.isAnswered(index, answer))
    const action = this.hasAnswer(this.activeIndex, draft) ? 'Continue' : 'Skip'
    return {
      question: question.question ?? 'Question',
      summary: question.summary ?? 'Question',
      activeIndex: this.activeIndex,
      count: this.questions.length,
      options: options.map((option, index) => {
        const selected = draft.selected.includes(option.label)
        return {
          ...option,
          selected,
          focused: this.focus === 'options' && index === this.optionIndex,
          note: draft.notes[option.label] ?? '',
          noteOpen: selected && draft.openNotes.includes(option.label),
          noteFocused: this.focus === 'note' && this.noteLabel === option.label
        }
      }),
      selected: draft.selected,
      text: draft.text,
      multiSelect: question.multiSelect === true,
      allowText: question.allowText !== false,
      optionIndex: this.optionIndex,
      focus: this.focus,
      collapsed: this.collapsed,
      actionLabel: `${action}${allOtherQuestionsAnswered ? ' and Submit' : ''}`
    }
  }

  moveQuestion(direction: -1 | 1): void {
    this.activeIndex = Math.min(this.questions.length - 1, Math.max(0, this.activeIndex + direction))
    this.optionIndex = Math.min(this.optionIndex, Math.max(0, orderedOptions(this.current.options).length - 1))
    if (this.focus === 'note') {
      this.noteLabel = undefined
      this.focus = this.firstFocus()
    }
    if (this.focus === 'answer' && this.current.allowText === false) this.focus = this.firstFocus()
  }

  moveOption(direction: -1 | 1): void {
    const count = orderedOptions(this.current.options).length
    if (count === 0) return
    this.optionIndex = Math.min(count - 1, Math.max(0, this.optionIndex + direction))
  }

  focusOption(index: number): boolean {
    const count = orderedOptions(this.current.options).length
    if (!Number.isInteger(index) || index < 0 || index >= count) return false
    this.optionIndex = index
    this.focus = 'options'
    this.noteLabel = undefined
    return true
  }

  activateOption(index: number): boolean {
    if (!this.focusOption(index)) return false
    this.toggleOption(index)
    return true
  }

  toggleOption(index = this.optionIndex): void {
    const question = this.current
    const option = orderedOptions(question.options)[index]
    if (!option) return
    const answer = this.currentDraft
    if (question.multiSelect) {
      if (answer.selected.includes(option.label)) {
        answer.selected = answer.selected.filter(label => label !== option.label)
        delete answer.notes[option.label]
        answer.openNotes = answer.openNotes.filter(label => label !== option.label)
        if (this.focus === 'note' && this.noteLabel === option.label) {
          this.focus = 'options'
          this.noteLabel = undefined
        }
      } else {
        answer.selected = [...answer.selected, option.label]
      }
    } else if (answer.selected.includes(option.label)) {
      answer.selected = []
      delete answer.notes[option.label]
      answer.openNotes = answer.openNotes.filter(label => label !== option.label)
      if (this.focus === 'note' && this.noteLabel === option.label) {
        this.focus = 'options'
        this.noteLabel = undefined
      }
    } else {
      answer.selected = [option.label]
      answer.notes = {}
      answer.openNotes = []
      this.noteLabel = undefined
    }
    answer.skipped = false
  }

  focusNote(label: string): boolean {
    const options = orderedOptions(this.current.options)
    const index = options.findIndex(option => option.label === label)
    if (index < 0 || !this.currentDraft.selected.includes(label)) return false
    const draft = this.currentDraft
    if (!draft.openNotes.includes(label)) draft.openNotes.push(label)
    this.optionIndex = index
    this.noteLabel = label
    this.focus = 'note'
    return true
  }

  setNote(label: string, text: string): void {
    if (!this.currentDraft.selected.includes(label) || !this.currentDraft.openNotes.includes(label)) return
    this.currentDraft.notes[label] = text
    this.currentDraft.skipped = false
  }

  setText(text: string): void {
    if (this.current.allowText === false) return
    const answer = this.currentDraft
    answer.text = text
    answer.skipped = false
  }

  focusNext(reverse = false): void {
    if (this.collapsed) {
      this.reopen()
      return
    }

    const options = orderedOptions(this.current.options)
    const selectedLabels = options.filter(option => this.currentDraft.selected.includes(option.label)).map(option => option.label)
    const nextFocus = (): 'answer' | 'action' => this.current.allowText === false ? 'action' : 'answer'

    if (!reverse) {
      if (this.focus === 'options') {
        const option = options[this.optionIndex]
        if (option && this.currentDraft.selected.includes(option.label)) {
          this.focusNote(option.label)
          return
        }
        this.focus = nextFocus()
        return
      }
      if (this.focus === 'note') {
        const currentIndex = selectedLabels.indexOf(this.noteLabel ?? '')
        const nextLabel = selectedLabels[currentIndex + 1]
        if (nextLabel) {
          this.focusNote(nextLabel)
          return
        }
        this.noteLabel = undefined
        this.focus = nextFocus()
        return
      }
      if (this.focus === 'answer') this.focus = 'action'
      else if (this.focus === 'action') this.focus = 'composer'
      else this.focus = this.firstFocus()
      return
    }

    if (this.focus === 'note') {
      this.optionIndex = options.findIndex(option => option.label === this.noteLabel)
      this.noteLabel = undefined
      this.focus = 'options'
    } else if (this.focus === 'answer') {
      const previous = selectedLabels.at(-1)
      if (previous) this.focusNote(previous)
      else this.focus = 'options'
    } else if (this.focus === 'action') {
      const previous = this.current.allowText !== false ? undefined : selectedLabels.at(-1)
      if (previous) this.focusNote(previous)
      else this.focus = this.current.allowText === false ? 'options' : 'answer'
    } else if (this.focus === 'composer') this.focus = 'action'
    else this.focus = 'composer'
  }

  setFocus(focus: QuestionDockFocus): void {
    this.focus = focus
    if (focus !== 'note') this.noteLabel = undefined
  }

  collapse(): void {
    this.collapsed = true
    this.focus = 'composer'
    this.noteLabel = undefined
  }

  reopen(): void {
    this.collapsed = false
    this.focus = this.firstFocus()
    this.noteLabel = undefined
  }

  activateAction(): void {
    if (this.settled) return
    const answer = this.currentDraft
    if (!this.hasAnswer(this.activeIndex, answer)) {
      answer.selected = []
      answer.text = ''
      answer.skipped = true
    }
    const next = this.nextUnanswered()
    if (next !== undefined) {
      this.activeIndex = next
      this.optionIndex = 0
      this.focus = this.firstFocus()
      this.noteLabel = undefined
      return
    }
    this.settled = true
    this.resolveResult(this.answers())
  }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    this.resolveResult(undefined)
  }

  private get current(): QuestionDockQuestion {
    return this.questions[this.activeIndex]!
  }

  private get currentDraft(): AnswerDraft {
    return this.drafts[this.activeIndex]!
  }

  private firstFocus(): QuestionDockFocus {
    return 'options'
  }

  private hasAnswer(index: number, answer: AnswerDraft): boolean {
    return answer.selected.length > 0 || (this.questions[index]?.allowText !== false && Boolean(answer.text.trim()))
  }

  private isAnswered(index: number, answer: AnswerDraft): boolean {
    return answer.skipped || this.hasAnswer(index, answer)
  }

  private nextUnanswered(): number | undefined {
    for (let offset = 1; offset <= this.questions.length; offset += 1) {
      const index = (this.activeIndex + offset) % this.questions.length
      if (!this.isAnswered(index, this.drafts[index]!)) return index
    }
  }

  private answers(): QuestionDockAnswers {
    return this.questions.map((question, index) => {
      const draft = this.drafts[index]!
      const skipped = draft.skipped || !this.isAnswered(index, draft)
      const text = skipped ? '' : draft.text.trim()
      const notes: Record<string, string> = {}
      if (!skipped) {
        for (const label of draft.selected) {
          const note = draft.notes[label]?.trim()
          if (note) notes[label] = note
        }
      }
      return {
        questionId: question.requestId,
        answer: {
          selected: skipped ? [] : [...draft.selected],
          ...(text ? { text } : {}),
          ...(Object.keys(notes).length ? { notes } : {})
        }
      }
    })
  }
}
