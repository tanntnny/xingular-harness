import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { closeIndex } from '../core/index'
import { runEventPayloadSchemas, runRecordSchema, type RunEvent } from './contracts'
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
  ])).toThrow(/selected choices/)
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
