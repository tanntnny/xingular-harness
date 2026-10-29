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

  it('previews the hovered or focused choice sketch as literal multiline text', () => {
    const state = new QuestionDockState([question('q1', {
      uiSketch: true,
      options: [
        { label: 'Plan A', sketch: '+--+\n| A| \n+--+', recommended: true },
        { label: 'Plan B', sketch: '+--+\n| B|\n+--+' }
      ]
    })])

    expect(state.view.sketchPreview).toEqual({ label: 'Plan A', sketch: '+--+\n| A| \n+--+' })
    expect(state.focusOption(1)).toBe(true)
    expect(state.view.sketchPreview).toEqual({ label: 'Plan B', sketch: '+--+\n| B|\n+--+' })
    expect(state.view.options.some(option => option.selected)).toBe(false)
  })

  it('opens notes explicitly and submits them by selected choice label', async () => {
    const state = new QuestionDockState([question('q1', {
      options: [{ label: 'A', recommended: true }, { label: 'B' }], multiSelect: true
    })])

    state.activateOption(0)
    state.activateOption(1)
    state.focusOption(0)
    state.focusNext()
    expect(state.view.focus).toBe('answer')
    expect(state.view.options.every(option => !option.noteOpen)).toBe(true)

    state.focusOption(0)
    expect(state.openFocusedNote()).toBe(true)
    expect(state.view.options[0]).toMatchObject({ label: 'A', noteOpen: true, noteFocused: true })
    state.setNote('A', '  details for A  ')
    state.focusNext()
    expect(state.view.focus).toBe('answer')

    state.focusOption(1)
    expect(state.openFocusedNote()).toBe(true)
    expect(state.view.options[1]).toMatchObject({ label: 'B', noteOpen: true, noteFocused: true })
    state.setNote('B', 'details for B')
    state.activateAction()

    await expect(state.result).resolves.toEqual([{
      questionId: 'q1', answer: { selected: ['A', 'B'], notes: { A: 'details for A', B: 'details for B' } }
    }])
  })

  it('keeps the drafts and shows why an answer was refused until a retry succeeds', async () => {
    const state = new QuestionDockState([question('q1', {
      options: [{ label: 'A', recommended: true }, { label: 'B' }]
    })])

    state.activateOption(0)
    state.focusOption(0)
    state.openFocusedNote()
    state.setNote('A', 'keep this note')
    state.activateAction()
    const first = await state.result
    expect(first).toEqual([{ questionId: 'q1', answer: { selected: ['A'], notes: { A: 'keep this note' } } }])

    state.fail('Question "Question q1": an answer was refused.')
    expect(state.view).toMatchObject({ error: 'Question "Question q1": an answer was refused.', submitting: false, selected: ['A'] })
    expect(state.view.options[0]).toMatchObject({ selected: true, note: 'keep this note' })

    state.setSubmitting(true)
    state.activateAction()
    expect(state.view.submitting).toBe(true)
    state.setSubmitting(false)
    state.activateAction()

    await expect(state.result).resolves.toEqual(first)
  })

  it('clears a refusal once the answer it describes changes', () => {
    const state = new QuestionDockState([question('q1')])
    state.fail('Question "Question q1" takes one choice, but 2 were selected.')
    expect(state.view.error).toBeDefined()
    state.toggleOption(0)
    expect(state.view.error).toBeUndefined()
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

  it('cycles focus through the question without a chat-composer or collapse state', () => {
    const state = new QuestionDockState([question('q1', { options: [{ label: 'A', recommended: true }] })])

    expect(state.view.focus).toBe('options')
    state.focusNext()
    expect(state.view.focus).toBe('answer')
    state.focusNext()
    expect(state.view.focus).toBe('action')
    state.focusNext()
    expect(state.view.focus).toBe('options')
    expect(state.view).not.toHaveProperty('collapsed')
  })

  it('shows short labels as tabs and keeps drafts when directly switching tabs', () => {
    const fallback = question('q2', {
      question: 'Which rollout method should we use?', batchId: 'batch', batchIndex: 2, batchCount: 2
    })
    delete fallback.summary
    const state = new QuestionDockState([
      question('q1', { summary: 'Workspace deployment review', batchId: 'batch', batchIndex: 1, batchCount: 2 }),
      fallback
    ])

    expect(state.view.tabs).toEqual([
      { label: 'Workspace deployment', index: 0, active: true },
      { label: 'Which rollout', index: 1, active: false }
    ])
    state.toggleOption(0)
    expect(state.selectQuestion(1)).toBe(true)
    expect(state.view).toMatchObject({ activeIndex: 1, summary: 'Which rollout', tabs: [{ active: false }, { active: true }] })
    expect(state.selectQuestion(2)).toBe(false)
    expect(state.selectQuestion(0)).toBe(true)
    expect(state.view.selected).toEqual(['Default choice'])
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
