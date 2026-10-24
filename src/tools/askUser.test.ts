import { Type } from 'typebox'
import { expect, test } from 'vitest'

import type { ActiveRun, QuestionInput } from '../sessions/registry'
import { askUserTool, describeAnswer } from './askUser'

test('ask_user requests one to five summarized questions and returns answers in order', async () => {
  let requested: QuestionInput[] = []
  const tool = askUserTool({
    requestAnswers: async (questions: QuestionInput[]) => {
      requested = questions
      return [
        { selected: ['Keyboard'], notes: { Keyboard: 'Keep it accessible.' } },
        { selected: [], text: 'Next week' }
      ]
    }
  } as unknown as ActiveRun)

  const response = await tool.execute({ questions: [
    { summary: 'Navigation style', question: 'Which navigation?', options: [{ label: 'Keyboard', description: 'Move through controls with keys.', recommended: true }, { label: 'Pointer', description: 'Select controls with a mouse or trackpad.', recommended: true }], multiSelect: true },
    { summary: 'Delivery timing', question: 'When?', options: [{ label: 'Today', description: 'Start immediately.' }, { label: 'Next week', description: 'Start after the current week.', recommended: true }], allowText: true }
  ] })

  expect(requested).toMatchObject([
    { summary: 'Navigation style', question: 'Which navigation?', options: [{ label: 'Keyboard', recommended: true }, { label: 'Pointer', recommended: true }], multiSelect: true, allowText: true },
    { summary: 'Delivery timing', question: 'When?', multiSelect: false, allowText: true }
  ])
  expect(response).toContain('Navigation style: The user chose: Keyboard. Their note for Keyboard: Keep it accessible.')
  expect(response).toContain('Delivery timing: The user answered: Next week')
})

test('ask_user requires choices and at least one recommendation while leaving each marker optional', () => {
  const tool = askUserTool({ requestAnswers: async () => [] } as unknown as ActiveRun)
  const schema = tool.parameters(Type) as any
  const question = schema.properties.questions.items
  const options = question.properties.options
  const option = options.items
  expect(question.required).toContain('summary')
  expect(question.properties.summary.description).toContain('one or two words')
  expect(question.required).toContain('options')
  expect(options).toMatchObject({ minItems: 1, maxItems: 6 })
  expect(options.contains.properties.recommended.const).toBe(true)
  expect(option.properties.recommended).toMatchObject({ type: 'boolean' })
  expect(option.required).not.toContain('recommended')
})

test('ask_user preserves bounded ASCII sketches and exposes their schema bounds', async () => {
  let requested: QuestionInput[] = []
  const tool = askUserTool({
    requestAnswers: async (questions: QuestionInput[]) => {
      requested = questions
      return [{ selected: ['Plan A'] }]
    }
  } as unknown as ActiveRun)
  const sketch = '+--+\n| A| \n+--+'
  const result = await tool.execute({ questions: [{
    summary: 'Plan choice', question: 'Which plan?', uiSketch: true,
    options: [
      { label: 'Plan A', description: 'Choose the first plan.', recommended: true, sketch },
      { label: 'Plan B', description: 'Choose the other plan.', sketch: '+--+\n| B|\n+--+' }
    ]
  }] })

  expect(requested[0]).toMatchObject({ uiSketch: true, options: [{ label: 'Plan A', sketch }, { label: 'Plan B', sketch: '+--+\n| B|\n+--+' }] })
  expect(result).toBe('Plan choice: The user chose: Plan A.')
  const question = (tool.parameters(Type) as any).properties.questions.items
  const option = question.properties.options.items
  expect(question.properties.uiSketch).toMatchObject({ const: true })
  expect(question.required).not.toContain('uiSketch')
  expect(option.properties.sketch).toMatchObject({ maxLength: 1943, pattern: expect.any(String) })
  expect(option.properties.sketch.description).toContain('fixed, matching outer-edge columns')
  expect(option.required).not.toContain('sketch')
})

test('ask_user rejects partial, unenabled, and out-of-bounds sketches', async () => {
  let requested = false
  const tool = askUserTool({ requestAnswers: async () => { requested = true; return [] } } as unknown as ActiveRun)
  const choice = { label: 'Plan A', description: 'Choose this plan.', recommended: true }
  const base = { summary: 'Plan choice', question: 'Which plan?' }
  await expect(tool.execute({ questions: [{ ...base, uiSketch: true, options: [choice] }] }))
    .resolves.toBe('Sketch mode requires a sketch for every choice.')
  await expect(tool.execute({ questions: [{ ...base, uiSketch: false, options: [choice] }] }))
    .resolves.toBe('Set uiSketch to true to enable question sketches.')
  await expect(tool.execute({ questions: [{ ...base, options: [{ ...choice, sketch: 'diagram' }] }] }))
    .resolves.toBe('Choice sketches require uiSketch: true.')
  await expect(tool.execute({ questions: [{ ...base, uiSketch: true, options: [{ ...choice, sketch: 'x'.repeat(81) }] }] }))
    .resolves.toContain('1–24 lines')
  expect(requested).toBe(false)
})

test('ask_user rejects empty questions and summaries', async () => {
  const tool = askUserTool({ requestAnswers: async () => [] } as unknown as ActiveRun)
  await expect(tool.execute({ questions: [] })).resolves.toBe('Ask between one and five questions.')
  await expect(tool.execute({ questions: [{ summary: '', question: 'Pick one' }] })).resolves.toBe('Each question needs a concise 1–2 word summary label of no more than 100 characters.')
})

test('ask_user enforces one- or two-word labels', async () => {
  let requested = false
  const tool = askUserTool({ requestAnswers: async () => { requested = true; return [] } } as unknown as ActiveRun)
  await expect(tool.execute({ questions: [{
    summary: 'Workspace deployment review',
    question: 'Which rollout?',
    options: [{ label: 'Gradual', description: 'Roll out in stages.', recommended: true }]
  }] })).resolves.toBe('Each question needs a concise 1–2 word summary label of no more than 100 characters.')
  expect(requested).toBe(false)
})

test('ask_user rejects questions without a choice or a recommended choice', async () => {
  let requested = false
  const tool = askUserTool({ requestAnswers: async () => { requested = true; return [] } } as unknown as ActiveRun)
  const base = { summary: 'Plan choice', question: 'Which plan?' }
  await expect(tool.execute({ questions: [{ ...base, options: [] }] })).resolves.toBe('Every question needs at least one choice.')
  await expect(tool.execute({ questions: [{ ...base, options: [{ label: 'Plan A', description: 'First plan.' }] }] }))
    .resolves.toBe('Every question needs at least one recommended choice.')
  expect(requested).toBe(false)
})

test('ask_user rejects multiple recommendations on a single-choice question', async () => {
  let requested = false
  const tool = askUserTool({ requestAnswers: async () => { requested = true; return [] } } as unknown as ActiveRun)
  await expect(tool.execute({ questions: [{
    summary: 'Plan choice',
    question: 'Which plan?',
    options: [{ label: 'Plan A', description: 'First plan.', recommended: true }, { label: 'Plan B', description: 'Second plan.', recommended: true }]
  }] })).resolves.toBe('A single-choice question may recommend at most one option.')
  expect(requested).toBe(false)
})

test('ask_user requires a description for every choice', async () => {
  let requested = false
  const tool = askUserTool({ requestAnswers: async () => { requested = true; return [] } } as unknown as ActiveRun)
  await expect(tool.execute({ questions: [{ summary: 'Plan choice', question: 'Which plan?', options: [{ label: 'Plan A', recommended: true }] }] }))
    .resolves.toBe('Every choice needs a short description. Aim for 25 words or fewer.')
  expect(requested).toBe(false)
})

test('ask_user treats 25 words as guidance for questions and choice descriptions', async () => {
  let requested: QuestionInput[] = []
  const tool = askUserTool({
    requestAnswers: async (questions: QuestionInput[]) => {
      requested = questions
      return [{ selected: ['Detailed'], notes: {} }]
    }
  } as unknown as ActiveRun)
  const longQuestion = 'Which option should we choose after we consider the current project goals, delivery timing, team capacity, risks, dependencies, expected maintenance, and the needs of the people who will use the result every day?'
  const longDescription = 'Choose this when the team wants a complete explanation with context, tradeoffs, implementation notes, assumptions, risks, and enough detail to share the decision with other reviewers.'
  const response = await tool.execute({ questions: [{
    summary: 'Reply detail',
    question: longQuestion,
    options: [{ label: 'Detailed', description: longDescription, recommended: true }]
  }] })

  expect(requested[0]).toMatchObject({ question: longQuestion, options: [{ label: 'Detailed', description: longDescription }] })
  expect(response).toContain('Reply detail: The user chose: Detailed.')
  expect(tool.description).toContain('concise 1–2 word label')
  expect(tool.description).toContain('aim to keep each question to 25 words or fewer')
  expect(tool.description).toContain('Every question must offer 1–6 short choices')
  expect(tool.description).toContain('at least one choice must be marked recommended: true')
  expect(tool.description).toContain('each with a helpful description of 25 words or fewer')
  expect(tool.description).toContain('recommended: true')
  expect(tool.description).toContain('outer `+` corners in fixed columns')
  expect(tool.description).toContain('same columns on every content row')
})

test('describeAnswer includes choice-specific notes', () => {
  expect(describeAnswer({ selected: ['A'], notes: { A: 'Keep this requirement.' } })).toBe('The user chose: A. Their note for A: Keep this requirement.')
})
