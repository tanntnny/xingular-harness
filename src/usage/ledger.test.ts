import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { closeIndex, all, withIndex } from '../core/index'
import { appendEvent, saveRun } from '../sessions/runStore'
import { runRecordSchema, type RunRecord } from '../sessions/contracts'
import { indexedRuns, indexRunUsage, syncUsage } from './ledger'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => {
  closeIndex(root)
  rmSync(root, { recursive: true, force: true })
}))

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'usage-ledger-'))
  roots.push(directory)
  return directory
}

function record(id: string, sessionId = 'session-a', accountId = 'account-a'): RunRecord {
  return runRecordSchema.parse({
    id, projectId: 'project-a', mode: 'chat', harness: 'pi', sessionType: 'structured', sessionId,
    nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: null,
    startedAt: '2026-03-09T10:00:00.000Z', endedAt: '2026-03-09T10:01:00.000Z', status: 'completed', accountId
  })
}

function usage(directory: string, runId: string, sequence: number, at: string, index: number, overrides: Record<string, unknown> = {}): void {
  appendEvent(directory, {
    id: `event-${runId}-${sequence}`,
    runId,
    sessionId: 'session-a',
    sequence,
    timestamp: at,
    type: 'usage.updated',
    payload: {
      inputTokens: 100 * index, outputTokens: 50 * index, cacheReadTokens: 20 * index, cacheWriteTokens: 5 * index,
      costUsd: 0.02 * index, costSource: 'harness', requests: index, model: 'model-a', provider: 'provider-a',
      contextTokens: 120, contextWindow: 200_000,
      request: {
        index, model: 'model-a', provider: 'provider-a', inputTokens: 100 * index, outputTokens: 50 * index,
        cacheReadTokens: 20 * index, cacheWriteTokens: 5 * index, costUsd: 0.02 * index, costSource: 'harness',
        durationMs: 1_000, ttftMs: 200
      },
      ...overrides
    }
  })
}

test('indexes one row per request and marks the run', () => {
  const directory = root()
  saveRun(directory, record('run-a'))
  usage(directory, 'run-a', 1, '2026-03-09T10:00:10.000Z', 1)
  usage(directory, 'run-a', 2, '2026-03-09T10:00:20.000Z', 2)
  expect(indexRunUsage(directory, 'run-a')).toBe(true)
  expect(indexedRuns(directory)).toEqual(['run-a'])
  const rows = withIndex(directory, (database) => all<{ request_index: number; cost_usd: number; account_id: string; project_id: string }>(database, 'SELECT request_index, cost_usd, account_id, project_id FROM usage_requests ORDER BY request_index'))
  expect(rows.map((row) => row.request_index)).toEqual([1, 2])
  expect(rows[1]!.cost_usd).toBeCloseTo(0.04)
  expect(rows[0]!.account_id).toBe('account-a')
  expect(rows[0]!.project_id).toBe('project-a')
})

test('re-indexing replaces the run rows instead of doubling them', () => {
  const directory = root()
  saveRun(directory, record('run-a'))
  usage(directory, 'run-a', 1, '2026-03-09T10:00:10.000Z', 1)
  indexRunUsage(directory, 'run-a')
  indexRunUsage(directory, 'run-a')
  const count = withIndex(directory, (database) => all<{ n: number }>(database, 'SELECT COUNT(*) AS n FROM usage_requests')[0]!.n)
  expect(count).toBe(1)
})

test('a cumulative-only update counts once, from its latest totals', () => {
  const directory = root()
  saveRun(directory, record('run-b'))
  appendEvent(directory, {
    id: 'event-b-1', runId: 'run-b', sessionId: 'session-a', sequence: 1, timestamp: '2026-03-09T10:00:10.000Z',
    type: 'usage.updated', payload: { inputTokens: 10, outputTokens: 5, requests: 1 }
  })
  appendEvent(directory, {
    id: 'event-b-2', runId: 'run-b', sessionId: 'session-a', sequence: 2, timestamp: '2026-03-09T10:00:20.000Z',
    type: 'usage.updated', payload: { inputTokens: 30, outputTokens: 15, requests: 2 }
  })
  indexRunUsage(directory, 'run-b')
  const rows = withIndex(directory, (database) => all<{ input_tokens: number; requests: number }>(database, 'SELECT input_tokens, requests FROM usage_requests'))
  expect(rows).toEqual([{ input_tokens: 30, requests: 2 }])
})

test('sync indexes only runs the ledger has not seen', () => {
  const directory = root()
  saveRun(directory, record('run-a'))
  saveRun(directory, record('run-b'))
  usage(directory, 'run-a', 1, '2026-03-09T10:00:10.000Z', 1)
  usage(directory, 'run-b', 1, '2026-03-09T10:02:10.000Z', 1)
  expect(syncUsage(directory)).toBe(2)
  expect(syncUsage(directory)).toBe(0)
  expect(indexedRuns(directory).sort()).toEqual(['run-a', 'run-b'])
})
