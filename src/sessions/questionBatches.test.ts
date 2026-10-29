import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { closeIndex } from '../core/index'
import { questionAnswerProblem, runEventPayloadSchemas, runRecordSchema, type RunEvent } from './contracts'
import { RunRegistry } from './registry'
import { readEvents, saveRun } from './runStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) closeIndex(root)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-question-batch-'))
  roots.push(root)
  saveRun(root, runRecordSchema.parse({
    id: 'run-1',
    sessionId: 'session-1',
    projectId: null,
    mode: 'chat',
    harness: 'pi',
    sessionType: 'structured',
    nativeSessionId: null,
    workingDirectory: null,
    worktreeId: null,
    goal: null,
    status: 'running',
    startedAt: 'start',
    endedAt: null
  }))
  const registry = new RunRegistry({ root: () => root })
  const run = registry.start('session-1', 'run-1')
  return { root, registry, run }
}

test('question batches validate all answers before resolving and retain choice notes', async () => {
  const { root, registry, run } = fixture()
  expect(() => run.requestAnswers([])).toThrow(/between one and five/)
  expect(() => run.requestAnswers(Array.from({ length: 6 }, () => ({ question: 'Q', options: [], multiSelect: false, allowText: true })))).toThrow(/between one and five/)

  const result = run.requestAnswers([
    { summary: 'Project scope', question: 'What should change?', options: [{ label: 'UI', recommended: true }, { label: 'API', recommended: true }], multiSelect: true, allowText: true },
    { summary: 'Target date', question: 'When should it ship?', options: [{ label: 'Soon', recommended: true }, { label: 'Later' }], multiSelect: false, allowText: false }
  ])
  let settled = false
  void result.then(() => { settled = true })

  const requested = readEvents(root, 'run-1').filter((event) => event.type === 'question.requested')
  expect(requested).toHaveLength(2)
  const [first, second] = requested.map((event) => event.payload as { questionId: string; summary: string; batchId: string; batchIndex: number; batchCount: number; options: { label: string; recommended?: boolean }[] })
  expect(first).toMatchObject({ summary: 'Project scope', batchIndex: 1, batchCount: 2, options: [{ label: 'UI', recommended: true }, { label: 'API', recommended: true }] })
  expect(second).toMatchObject({ summary: 'Target date', batchId: first.batchId, batchIndex: 2, batchCount: 2 })
  expect(() => registry.answerQuestion('run-1', first.questionId, { selected: ['UI'] })).toThrow(/together/)

  expect(() => registry.answerQuestions('run-1', first.batchId, [
    { questionId: first.questionId, answer: { selected: ['UI'] } },
    { questionId: second.questionId, answer: { selected: ['Later'], notes: { Soon: 'wrong choice' } } }
  ])).toThrow(/which is not selected/)
  await Promise.resolve()
  expect(settled).toBe(false)

  registry.answerQuestions('run-1', first.batchId, [
    { questionId: second.questionId, answer: { selected: ['Soon'] } },
    { questionId: first.questionId, answer: { selected: ['UI'], notes: { UI: 'Keep keyboard navigation.' } } }
  ])
  await expect(result).resolves.toEqual([
    { selected: ['UI'], notes: { UI: 'Keep keyboard navigation.' } },
    { selected: ['Soon'] }
  ])

  const answered = readEvents(root, 'run-1').filter((event) => event.type === 'question.answered')
  expect(answered).toHaveLength(2)
  expect(answered.find((event) => (event.payload as { questionId: string }).questionId === first.questionId)?.payload).toMatchObject({
    batchId: first.batchId,
    batchIndex: 1,
    batchCount: 2,
    notes: { UI: 'Keep keyboard navigation.' }
  })
})

test('choices and recommendation limits are checked before any question in a batch is emitted', () => {
  const { root, run } = fixture()
  const base = { question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }], multiSelect: false, allowText: true }
  expect(() => run.requestAnswer({ ...base, options: [] })).toThrow(/at least one choice/)
  expect(() => run.requestAnswer({ ...base, options: [{ label: 'A' }] })).toThrow(/at least one recommended choice/)
  expect(() => run.requestAnswers([
    { ...base, options: [{ label: 'A', recommended: true }] },
    { ...base, options: [{ label: 'B', recommended: true }, { label: 'C', recommended: true }] }
  ])).toThrow(/single-choice question can recommend at most one/)
  expect(() => run.requestAnswer({ ...base, options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] })).toThrow(/single-choice question can recommend at most one/)
  expect(readEvents(root, 'run-1').filter((event) => event.type === 'question.requested')).toHaveLength(0)
})

test('legacy single questions remain valid alongside batch event metadata', () => {
  const { root, registry, run } = fixture()
  const answer = run.requestAnswer({ question: 'Continue?', options: [{ label: 'Yes', recommended: true }], multiSelect: false, allowText: false })
  const request = readEvents(root, 'run-1').find((event) => event.type === 'question.requested')!
  expect(runEventPayloadSchemas['question.requested'].safeParse(request.payload).success).toBe(true)
  expect(runEventPayloadSchemas['question.requested'].safeParse({ ...(request.payload as object), options: [{ label: 'Yes', recommended: true }] }).success).toBe(true)
  expect(runEventPayloadSchemas['question.requested'].safeParse({ ...(request.payload as object), batchId: 'partial' }).success).toBe(false)
  registry.answerQuestion('run-1', (request.payload as { questionId: string }).questionId, { selected: ['Yes'] })
  return expect(answer).resolves.toEqual({ selected: ['Yes'] })
})

test('question sketches are validated, persisted literally, and excluded from answer payloads', async () => {
  const { root, registry, run } = fixture()
  const sketch = Array.from({ length: 24 }, (_, row) => `| Context row ${row} |`.padEnd(80, ' ')).join('\n')
  const result = run.requestAnswer({
    question: 'Which layout?',
    uiSketch: true,
    options: [{ label: 'Plan A', recommended: true, sketch }],
    multiSelect: false,
    allowText: true
  })
  const requested = readEvents(root, 'run-1').find((event) => event.type === 'question.requested')!
  const payload = requested.payload as { questionId: string; uiSketch: true; options: { label: string; sketch: string }[] }
  expect(payload).toMatchObject({ uiSketch: true, options: [{ label: 'Plan A', sketch }] })
  expect(runEventPayloadSchemas['question.requested'].safeParse(payload).success).toBe(true)
  expect(runEventPayloadSchemas['question.requested'].safeParse({ ...payload, uiSketch: undefined }).success).toBe(false)
  expect(runEventPayloadSchemas['question.requested'].safeParse({ ...payload, options: [{ ...payload.options[0], sketch: 'x'.repeat(81) }] }).success).toBe(false)

  registry.answerQuestion('run-1', payload.questionId, { selected: ['Plan A'] })
  await expect(result).resolves.toEqual({ selected: ['Plan A'] })
  const answered = readEvents(root, 'run-1').find((event) => event.type === 'question.answered')!
  expect(answered.payload).toMatchObject({ selected: ['Plan A'] })
  expect(answered.payload).not.toHaveProperty('uiSketch')
  expect(answered.payload).not.toHaveProperty('options')
})

test('invalid sketch mode, missing choice sketches, and unsupported text fail before emitting', () => {
  const { root, run } = fixture()
  const base = { question: 'Which?', options: [{ label: 'Plan A', recommended: true }], multiSelect: false, allowText: true }
  expect(() => run.requestAnswer({ ...base, uiSketch: true })).toThrow(/sketch for every choice/)
  expect(() => run.requestAnswer({ ...base, options: [{ ...base.options[0]!, sketch: 'diagram' }] })).toThrow(/uiSketch: true/)
  expect(() => run.requestAnswer({ ...base, uiSketch: true, options: [{ ...base.options[0]!, sketch: 'café' }] })).toThrow(/printable ASCII/)
  expect(() => run.requestAnswer({ ...base, uiSketch: true, options: [{ ...base.options[0]!, sketch: 'x'.repeat(81) }] })).toThrow(/80 printable ASCII/)
  expect(readEvents(root, 'run-1').filter((event) => event.type === 'question.requested')).toHaveLength(0)
})

test('answer batch method rejects duplicate and foreign question ids without settling the batch', async () => {
  const { root, registry, run } = fixture()
  const result = run.requestAnswers([
    { summary: 'First', question: 'First?', options: [{ label: 'Choice A', recommended: true }], multiSelect: false, allowText: true },
    { summary: 'Second', question: 'Second?', options: [{ label: 'Choice B', recommended: true }], multiSelect: false, allowText: true }
  ])
  const requested = readEvents(root, 'run-1').filter((event) => event.type === 'question.requested')
  const [first, second] = requested.map((event) => event.payload as { questionId: string; batchId: string })
  const answers = [{ questionId: first.questionId, answer: { selected: [], text: 'a' } }, { questionId: second.questionId, answer: { selected: [], text: 'b' } }]
  expect(() => registry.answerQuestions('run-1', 'other-batch', answers)).toThrow(/batch/)
  expect(() => registry.answerQuestions('run-1', first.batchId, [answers[0], answers[0]])).toThrow(/batch/)
  expect(() => registry.answerQuestions('another-run', first.batchId, answers)).toThrow(/batch/)
  const events: RunEvent[] = readEvents(root, 'run-1')
  expect(events.filter((event) => event.type === 'question.answered')).toHaveLength(0)
  registry.answerQuestions('run-1', first.batchId, answers)
  await expect(result).resolves.toHaveLength(2)
})

test('an answer is checked with a reason that names the question and the field', () => {
  const question = {
    summary: 'Sections',
    options: [{ label: 'Run setup' }, { label: 'Skills' }, { label: 'Usage activity' }],
    multiSelect: true,
    allowText: true
  }
  expect(questionAnswerProblem(question, { selected: ['Run setup'], notes: { 'Run setup': 'keep it' } })).toBeNull()
  expect(questionAnswerProblem(question, { selected: ['Run setup'], text: 'also this' })).toBeNull()
  expect(questionAnswerProblem(question, { selected: ['Run setup'], notes: { 'Usage activity': 'not selected' } }))
    .toEqual({ field: 'notes', message: 'Question "Sections": a note is attached to "Usage activity", which is not selected.' })
  expect(questionAnswerProblem(question, { selected: ['Run setup', 'Run setup'] }))
    .toEqual({ field: 'selection', message: 'Question "Sections" lists the same choice more than once.' })
  expect(questionAnswerProblem(question, { selected: ['Nope'] }))
    .toEqual({ field: 'selection', message: 'Question "Sections" does not offer "Nope".' })
  expect(questionAnswerProblem({ ...question, allowText: false }, { selected: ['Run setup'], text: 'typed' }))
    .toEqual({ field: 'text', message: 'Question "Sections" does not take a typed answer; choose one of its options.' })
  expect(questionAnswerProblem({ summary: 'Timing', options: [{ label: 'Latest run' }, { label: 'Both' }] }, { selected: ['Both', 'Latest run'] }))
    .toEqual({ field: 'selection', message: 'Question "Timing" takes one choice, but 2 were selected.' })
  expect(questionAnswerProblem(question, { selected: ['Run setup'], notes: { 'Run setup': 'x'.repeat(10_001) } }))
    .toEqual({ field: 'notes', message: 'Question "Sections": the note for "Run setup" is longer than 10,000 characters.' })
})

test('the reported five-question batch accepts choices, text and notes', async () => {
  const { root, registry, run } = fixture()
  const labels = [
    ['Compact strip', 'Expandable card', 'Button only'],
    ['Context page', 'Separate page', 'Side panel'],
    ['Run setup', 'Skills', 'Plugins', 'Tools and connectors', 'Usage activity', 'Context usage'],
    ['Latest run', 'Upcoming setup', 'Both', 'Nothing'],
    ['Current and history', 'Current only']
  ]
  const summaries = ['Chat layout', 'Detail layout', 'Sections', 'Timing', 'History']
  const questions = summaries.map((summary, index) => ({
    summary,
    question: `Question ${index + 1}?`,
    options: labels[index]!.map((label, position) => ({ label, recommended: position === 0 })),
    multiSelect: index === 2,
    allowText: true
  }))
  const result = run.requestAnswers(questions)
  const requested = readEvents(root, 'run-1').filter((event) => event.type === 'question.requested')
  const batchId = (requested[0]!.payload as { batchId: string }).batchId
  const ids = requested.map((event) => (event.payload as { questionId: string }).questionId)
  const answers: Array<{ questionId: string; answer: { selected: string[]; text?: string; notes?: Record<string, string> } }> = [
    { questionId: ids[0]!, answer: { selected: ['Compact strip'], text: 'Keep the transcript quiet.' } },
    { questionId: ids[1]!, answer: { selected: ['Context page'], notes: { 'Context page': 'Beside token usage.' } } },
    { questionId: ids[2]!, answer: { selected: ['Run setup', 'Skills', 'Plugins'], notes: { Skills: 'Show active ones.' } } },
    { questionId: ids[3]!, answer: { selected: ['Latest run'], text: 'Label it completed or stopped.' } },
    { questionId: ids[4]!, answer: { selected: ['Current and history'] } }
  ]
  const questionById = new Map(requested.map((event, index) => [(event.payload as { questionId: string }).questionId, questions[index]!]))
  for (const { questionId, answer } of answers) {
    expect(questionAnswerProblem(questionById.get(questionId)!, answer)).toBeNull()
  }
  registry.answerQuestions('run-1', batchId, answers)
  await expect(result).resolves.toHaveLength(5)
  const recorded = readEvents(root, 'run-1').filter((event) => event.type === 'question.answered')
  expect(recorded.find((event) => (event.payload as { notes?: Record<string, string> }).notes)?.payload).toMatchObject({ notes: { 'Context page': 'Beside token usage.' } })
})
