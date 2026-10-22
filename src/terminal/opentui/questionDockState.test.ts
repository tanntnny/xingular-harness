import { describe, expect, it } from 'vitest'

import { QuestionDockState, type QuestionDockQuestion } from './questionDockState'

function question(requestId: string, overrides: Partial<QuestionDockQuestion> = {}): QuestionDockQuestion {
  return {
    type: 'question',
    requestId,
    question: `Question ${requestId}?`,
    summary: `Question ${requestId}`,
    options: [{ label: 'Default choice', description: 'Default choice description.', recommended: true }],
    allowText: true,
    ...overrides
  }
}

describe('QuestionDockState', () => {
  it('shows recommendations first without preselecting, and stages a single answer until submit', async () => {
    const state = new QuestionDockState([question('q1', {
      options: [
        { label: 'Plan A', description: 'Original A' },
        { label: 'Plan B', description: 'Original B', recommended: true }
      ]
    })])

    expect(state.view.options.map(option => option.label)).toEqual(['Plan B', 'Plan A'])
    expect(state.view.options.some(option => option.selected)).toBe(false)
    expect(state.view.actionLabel).toBe('Skip and Submit')

    state.toggleOption(0)
    expect(state.view.actionLabel).toBe('Continue and Submit')
    state.activateAction()

    await expect(state.result).resolves.toEqual([{ questionId: 'q1', answer: { selected: ['Plan B'] } }])
  })

  it('supports pointer focus and activation without submitting an answer', () => {
    const state = new QuestionDockState([question('q1', {
      options: [{ label: 'A', recommended: true }, { label: 'B' }], allowText: false
    })])

    expect(state.focusOption(1)).toBe(true)
    expect(state.view).toMatchObject({ optionIndex: 1, focus: 'options' })
    expect(state.activateOption(1)).toBe(true)
    expect(state.view).toMatchObject({ selected: ['B'], focus: 'options' })
    expect(state.activateOption(2)).toBe(false)
  })

  it('opens a note for each selected choice in Tab order and submits notes by label', async () => {
    const state = new QuestionDockState([question('q1', {
      options: [{ label: 'A', recommended: true }, { label: 'B' }], multiSelect: true
    })])

    state.focusOption(0)
    state.activateOption(0)
    state.focusOption(1)
    state.activateOption(1)
    state.focusOption(0)
    state.focusNext()
    expect(state.view.focus).toBe('note')
    expect(state.view.options[0]).toMatchObject({ label: 'A', noteOpen: true, noteFocused: true })
    state.setNote('A', '  details for A  ')
    state.focusNext()
    expect(state.view.options[1]).toMatchObject({ label: 'B', noteOpen: true, noteFocused: true })
    state.setNote('B', 'details for B')
    state.activateAction()

    await expect(state.result).resolves.toEqual([{
      questionId: 'q1', answer: { selected: ['A', 'B'], notes: { A: 'details for A', B: 'details for B' } }
    }])
  })

  it('clears a choice note when that choice is deselected', async () => {
    const state = new QuestionDockState([question('q1', { options: [{ label: 'A', recommended: true }] })])

    state.activateOption(0)
    state.focusNext()
    state.setNote('A', 'remove with the choice')
    state.toggleOption(0)
    expect(state.view.options[0]).toMatchObject({ selected: false, note: '', noteOpen: false })
    state.activateAction()

    await expect(state.result).resolves.toEqual([{ questionId: 'q1', answer: { selected: [] } }])
  })

  it('keeps drafts while navigating a batch and returns answers in request order', async () => {
    const state = new QuestionDockState([
      question('q1', {
        batchId: 'batch', batchIndex: 1, batchCount: 2,
        options: [{ label: 'A', recommended: true }, { label: 'B' }], allowText: false
      }),
      question('q2', { batchId: 'batch', batchIndex: 2, batchCount: 2, options: [{ label: 'Custom reason', description: 'Provide a different reason.', recommended: true }] })
    ])

    state.toggleOption(1)
    state.moveQuestion(1)
    state.setText('  Add a note  ')
    expect(state.view.actionLabel).toBe('Continue and Submit')
    state.activateAction()

    await expect(state.result).resolves.toEqual([
      { questionId: 'q1', answer: { selected: ['B'] } },
      { questionId: 'q2', answer: { selected: [], text: 'Add a note' } }
    ])
  })

  it('skips an unanswered question and advances to the next unanswered item', async () => {
    const state = new QuestionDockState([
      question('q1', { allowText: false }),
      question('q2', { allowText: false, options: [{ label: 'A', recommended: true }] })
    ])

    expect(state.view.focus).toBe('options')
    expect(state.view.actionLabel).toBe('Skip')
    state.activateAction()
    expect(state.view.activeIndex).toBe(1)
    state.toggleOption(0)
    state.activateAction()

    await expect(state.result).resolves.toEqual([
      { questionId: 'q1', answer: { selected: [] } },
      { questionId: 'q2', answer: { selected: ['A'] } }
    ])
  })

  it('moves focus from Something else to choices when the next question disallows text', () => {
    const state = new QuestionDockState([
      question('q1', { options: [{ label: 'A', recommended: true }] }),
      question('q2', { allowText: false, options: [{ label: 'B', recommended: true }] })
    ])

    state.focusNext()
    expect(state.view.focus).toBe('answer')
    state.moveQuestion(1)
    expect(state.view.focus).toBe('options')
  })

  it('cycles focus through the answer form and composer, and supports collapse/reopen', () => {
    const state = new QuestionDockState([question('q1', { options: [{ label: 'A', recommended: true }] })])

    expect(state.view.focus).toBe('options')
    state.focusNext()
    expect(state.view.focus).toBe('answer')
    state.focusNext()
    expect(state.view.focus).toBe('action')
    state.focusNext()
    expect(state.view.focus).toBe('composer')
    state.collapse()
    expect(state.view.collapsed).toBe(true)
    state.focusNext()
    expect(state.view.collapsed).toBe(false)
    expect(state.view.focus).toBe('options')
  })

  it('requires every question to have a choice and a recommended choice', () => {
    expect(() => new QuestionDockState([question('q1', { options: [] })]))
      .toThrow('Every question needs at least one choice.')
    expect(() => new QuestionDockState([question('q1', { options: [{ label: 'A' }] })]))
      .toThrow('Every question needs at least one recommended choice.')
  })

  it('cancels without submitting a partial batch', async () => {
    const state = new QuestionDockState([question('q1')])
    state.setText('draft only')
    state.cancel()

    await expect(state.result).resolves.toBeUndefined()
  })
})
