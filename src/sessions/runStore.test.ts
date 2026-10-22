import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { now } from '../core/fs'
import { closeIndex } from '../core/index'
import { isActiveStatus, runEventPayloadSchemas, runRecordSchema, type RunEvent, type RunEventType } from './contracts'
import { appendEvent, executionEvents, loadRun, markInterruptedRuns, pendingDecisions, persistEvent, readEvents, runDir, saveRun, updateRun } from './runStore'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-runs-'))
const valid = (type: RunEventType, payload: unknown): boolean => runEventPayloadSchemas[type].safeParse(payload).success

function fixtureRun(root: string, status: string) {
  const run = runRecordSchema.parse({ id: 'run-1', sessionId: 'agent-1', projectId: null, mode: 'chat', harness: 'pi', sessionType: 'structured', nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: null, status, startedAt: 'start', endedAt: null })
  saveRun(root, run)
  return run
}

const fixtureEvent = (sequence: number, type: string, payload: unknown): RunEvent => ({ id: `e${sequence}`, runId: 'run-1', sessionId: 'agent-1', sequence, timestamp: `time-${sequence}`, type: type as RunEventType, payload })

test('execution prefix includes first terminal and excludes ignored evidence', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const ignored = { ...fixtureEvent(1, 'usage.updated', { outputTokens: 99 }), native: { hostIgnored: 'run_already_ended' } }
    const events = [fixtureEvent(0, 'started', {}), ignored, fixtureEvent(2, 'status.changed', { status }), fixtureEvent(3, 'message.completed', { text: 'late' })]
    expect(executionEvents(events).map((event) => event.sequence)).toEqual([0, 2])
  }
})

test('trajectory evidence event payloads are validated', () => {
  expect(valid('context.snapshot', { systemPrompt: 'app prompt', contextUpdate: 'changed context', tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }], contextUpdateTruncated: false })).toBe(true)
  expect(valid('context.snapshot', { systemPrompt: 'prompt', tools: [{ name: 'read' }] })).toBe(false)
  expect(valid('tool.started', { toolCallId: 't', name: 'read', input: '{}', inputTruncated: false })).toBe(true)
  expect(valid('tool.completed', { toolCallId: 't', name: 'read', ok: true, output: 'text', outputTruncated: true })).toBe(true)
  expect(valid('retry.started', { attempt: 1, maxAttempts: 3, delayMs: 250, error: 'temporary' })).toBe(true)
  expect(valid('retry.ended', { attempt: 1, success: true })).toBe(true)
  expect(valid('compaction.started', { reason: 'threshold' })).toBe(true)
  expect(valid('compaction.ended', { reason: 'threshold', aborted: false, willRetry: true, summary: 'kept recent messages' })).toBe(true)
  expect(valid('retry.ended', { attempt: 1, success: 'yes' })).toBe(false)
})

test('pending decisions are the requests nothing answered', () => {
  const events = [
    fixtureEvent(0, 'approval.requested', { approvalId: 'a1', target: 'shell', action: 'ls' }),
    fixtureEvent(1, 'question.requested', { questionId: 'q1', question: 'Which?', options: [], multiSelect: false, allowText: true }),
    fixtureEvent(2, 'approval.requested', { approvalId: 'a2', target: 'shell', action: 'pwd' }),
    fixtureEvent(3, 'approval.resolved', { approvalId: 'a1', decision: 'denied' }),
    // An answer to another kind of request with the same id settles nothing.
    fixtureEvent(4, 'question.answered', { questionId: 'a2', selected: [] })
  ]
  expect(pendingDecisions(events).map((decision) => [decision.kind, decision.id, decision.eventId])).toEqual([['question', 'q1', 'e1'], ['approval', 'a2', 'e2']])
  expect(valid('approval.requested', { approvalId: 'a3', target: 'shell', action: 'ls', automatic: 'scope' })).toBe(true)
  expect(valid('approval.resolved', { approvalId: 'a3', decision: 'approved', automatic: 'scope' })).toBe(true)
  expect(valid('approval.resolved', { approvalId: 'a3', decision: 'approved', automatic: 'whenever' })).toBe(false)
})

test('interruption is not overwritten by late tools, messages or completion', () => {
  const root = temp()
  fixtureRun(root, 'running')
  expect(persistEvent(root, fixtureEvent(0, 'status.changed', { status: 'interrupted', reason: 'App stopped' }))).toBe(true)
  const late: [number, string, unknown][] = [
    [1, 'tool.completed', { toolCallId: 't1', name: 'bash', ok: false }],
    [2, 'message.completed', { messageId: 'm1', role: 'assistant', text: 'Saved checkpoint' }],
    [3, 'completed', {}],
    [4, 'status.changed', { status: 'running' }]
  ]
  for (const [index, type, payload] of late) expect(persistEvent(root, fixtureEvent(index, type, payload))).toBe(false)
  updateRun(root, 'run-1', (run) => {
    run.status = 'completed'
    run.nativeSessionId = 'native-1'
  })
  const run = loadRun(root, 'run-1')
  expect([run.status, run.endedAt, run.nativeSessionId, run.terminalReason]).toEqual(['interrupted', 'time-0', 'native-1', 'App stopped'])
  const events = readEvents(root, 'run-1')
  expect(events).toHaveLength(5)
  expect((events[2].payload as { text: string }).text).toBe('Saved checkpoint')
  expect((events[3].native as { hostIgnored: string }).hostIgnored).toBe('run_already_ended')
  closeIndex(root)
})

test('recovery repairs legacy outcomes once without erasing evidence', () => {
  const root = temp()
  fixtureRun(root, 'completed')
  appendEvent(root, fixtureEvent(0, 'status.changed', { status: 'interrupted' }))
  appendEvent(root, fixtureEvent(1, 'message.completed', { role: 'assistant', messageId: 'm', text: 'Partial answer' }))
  appendEvent(root, fixtureEvent(2, 'completed', {}))
  markInterruptedRuns(root)
  const backup = join(runDir(root, 'run-1'), 'run.json.before-outcome-repair')
  const original = readFileSync(backup, 'utf8')
  expect(loadRun(root, 'run-1').status).toBe('interrupted')
  expect(readEvents(root, 'run-1')).toHaveLength(3)
  markInterruptedRuns(root)
  expect(readFileSync(backup, 'utf8')).toBe(original)
  expect(readEvents(root, 'run-1')).toHaveLength(3)
  closeIndex(root)
})

test('a run that never settled is marked interrupted at startup', () => {
  const root = temp()
  fixtureRun(root, 'running')
  appendEvent(root, fixtureEvent(0, 'started', {}))
  expect(markInterruptedRuns(root)).toEqual(['run-1'])
  expect(loadRun(root, 'run-1').status).toBe('interrupted')
  expect(readEvents(root, 'run-1').at(-1)).toMatchObject({ sequence: 1, type: 'status.changed' })
  expect(markInterruptedRuns(root)).toEqual([])
  closeIndex(root)
})

test('startup leaves a run alone while another live process owns it', () => {
  const root = temp()
  fixtureRun(root, 'running')
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
  try {
    writeFileSync(join(runDir(root, 'run-1'), 'owner.json'), JSON.stringify({ pid: owner.pid }))
    expect(markInterruptedRuns(root)).toEqual([])
    expect(loadRun(root, 'run-1').status).toBe('running')
  } finally {
    owner.kill()
    closeIndex(root)
  }
})

test('startup interrupts a run whose owner has exited, or that has no owner', async () => {
  const root = temp()
  fixtureRun(root, 'running')
  const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  await once(exited, 'exit')
  writeFileSync(join(runDir(root, 'run-1'), 'owner.json'), JSON.stringify({ pid: exited.pid }))
  expect(markInterruptedRuns(root)).toEqual(['run-1'])
  expect(loadRun(root, 'run-1').status).toBe('interrupted')
  closeIndex(root)

  const legacy = temp()
  fixtureRun(legacy, 'running')
  rmSync(join(runDir(legacy, 'run-1'), 'owner.json'))
  expect(markInterruptedRuns(legacy)).toEqual(['run-1'])
  expect(loadRun(legacy, 'run-1').status).toBe('interrupted')
  closeIndex(legacy)
})

test('normal completion and failure are terminal too', () => {
  const cases: [string, string, unknown][] = [['completed', 'completed', {}], ['failed', 'failed', { message: 'No quota', code: 'provider_error' }]]
  for (const [type, expected, payload] of cases) {
    const root = temp()
    fixtureRun(root, 'running')
    expect(persistEvent(root, fixtureEvent(0, type, payload))).toBe(true)
    expect(persistEvent(root, fixtureEvent(1, 'status.changed', { status: 'running' }))).toBe(false)
    expect(loadRun(root, 'run-1').status).toBe(expected)
    closeIndex(root)
  }
})

test('active run filter includes only work in progress', () => {
  expect(['queued', 'running', 'waiting_for_approval'].every(isActiveStatus)).toBe(true)
  expect(['completed', 'interrupted', 'failed'].some(isActiveStatus)).toBe(false)
})

test('validates payloads by type', () => {
  expect(valid('message.delta', { messageId: 'm', text: 'hi' })).toBe(true)
  expect(valid('message.delta', { text: 'hi' })).toBe(false)
  expect(valid('usage.updated', { inputTokens: 3, outputTokens: 1 })).toBe(true)
  expect(valid('usage.updated', { inputTokens: 3, cacheReadTokens: 9, reasoningTokens: 1, costUsd: 0.02, requests: 2, contextTokens: 12, contextWindow: 1000, model: 'm', provider: 'p' })).toBe(true)
  expect(valid('usage.updated', { inputTokens: 3, costUsd: '0.02' })).toBe(false)
  expect(valid('usage.updated', { provider: 4 })).toBe(false)
  expect(valid('usage.updated', { request: { index: 1, reasoningSummary: 'The provider summary.' } })).toBe(true)
  expect(valid('usage.updated', { request: { index: 1, reasoningSummary: 'x'.repeat(4_001) } })).toBe(false)
  expect(valid('approval.resolved', { approvalId: 'a', decision: 'denied' })).toBe(true)
  expect(valid('approval.resolved', { approvalId: 'a', decision: 'maybe' })).toBe(false)
  expect(valid('question.requested', { questionId: 'q', question: 'Which?', options: [{ label: 'A' }], multiSelect: false, allowText: true })).toBe(true)
  expect(valid('question.requested', { questionId: 'q', question: 'Which?', options: [{}], multiSelect: false, allowText: true })).toBe(false)
  expect(valid('question.answered', { questionId: 'q', selected: ['A'], text: 'also B' })).toBe(true)
  expect(valid('reaction.added', { emoji: '👍' })).toBe(true)
  expect(valid('reaction.added', { emoji: 'lol' })).toBe(false)
  expect(valid('agent.message', { direction: 'to', agentId: 'a', agentName: 'A', text: 'hi' })).toBe(true)
  expect(valid('status.changed', { status: 'waiting_for_input' })).toBe(true)
  expect(valid('status.changed', { status: 'done' })).toBe(false)
})

test('event log skips torn lines', () => {
  const root = temp()
  appendEvent(root, { id: 'e', runId: 'run-1', sessionId: 's', sequence: 0, timestamp: now(), type: 'started', payload: {} })
  appendFileSync(join(runDir(root, 'run-1'), 'events.jsonl'), '{"id":"torn')
  expect(readEvents(root, 'run-1')).toHaveLength(1)
})
