import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { closeIndex } from '../core/index'
import type { RunEvent, RunRecord } from '../sessions/contracts'
import { appendEvent, saveRun } from '../sessions/runStore'
import { listTerminalTrajectoryRuns, readTerminalTrajectory } from './trajectory'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) closeIndex(root)
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'harness-terminal-trajectory-'))
  roots.push(root)
  const run = (id: string, sessionId: string, nativeSessionId: string | null): RunRecord => ({
    id, sessionId, nativeSessionId, mode: 'code', goal: id,
    resumedFromRunId: null, parentRunId: null, relation: null, terminalReason: null,
    projectId: null, harness: 'pi', sessionType: 'terminal', workingDirectory: '/project',
    worktreeId: null, attachmentCount: 0, startedAt: `2026-10-18T00:00:0${id.slice(-1)}Z`,
    endedAt: null, status: 'running', exitCode: null, handoffId: null,
    accountId: 'account-1', agentId: null, trigger: null
  })
  return { root, run }
}

const event = (runId: string, sessionId: string, sequence: number): RunEvent => ({
  id: `${runId}-event-${sequence}`, runId, sessionId, sequence,
  timestamp: `2026-10-18T00:00:0${sequence}Z`, type: 'started', payload: {}
})

it('lists newest runs only for the current terminal session and native conversation', () => {
  const { root, run } = setup()
  for (const item of [
    run('run-1', 'terminal-1', '/history/one.jsonl'),
    run('run-2', 'terminal-1', '/history/two.jsonl'),
    run('run-3', 'terminal-2', '/history/one.jsonl')
  ]) saveRun(root, item)

  expect(listTerminalTrajectoryRuns(root, 'terminal-1', '/history/one.jsonl').map(item => item.id)).toEqual(['run-1'])
  expect(listTerminalTrajectoryRuns(root, 'terminal-1', null)).toEqual([])
})

it('reads a selected run and only returns events after the requested sequence', () => {
  const { root, run } = setup()
  saveRun(root, run('run-1', 'terminal-1', '/history/current.jsonl'))
  appendEvent(root, event('run-1', 'terminal-1', 0))
  appendEvent(root, event('run-1', 'terminal-1', 1))

  expect(readTerminalTrajectory(root, 'terminal-1', '/history/current.jsonl', 'run-1', 0)).toMatchObject({
    run: { id: 'run-1', goal: 'run-1' },
    events: [{ sequence: 1 }]
  })
})

it('does not reveal runs from a different terminal or native conversation', () => {
  const { root, run } = setup()
  saveRun(root, run('run-1', 'terminal-1', '/history/one.jsonl'))

  expect(() => readTerminalTrajectory(root, 'terminal-2', '/history/one.jsonl', 'run-1')).toThrow('Run was not found')
  expect(() => readTerminalTrajectory(root, 'terminal-1', '/history/two.jsonl', 'run-1')).toThrow('Run was not found')
  expect(() => readTerminalTrajectory(root, 'terminal-1', '/history/one.jsonl', 'run-1', -1)).toThrow('Run was not found')
})
