import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { closeIndex } from '../core/index'
import { appendEvent, saveRun } from '../sessions/runStore'
import { runRecordSchema } from '../sessions/contracts'
import { summarize, periodRange } from './analytics'
import { indexRunUsage } from './ledger'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => {
  closeIndex(root)
  rmSync(root, { recursive: true, force: true })
}))

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'usage-analytics-'))
  roots.push(root)
  return root
}

function addRun(root: string, id: string, at: string, options: { account?: string; project?: string; session?: string; model?: string; cost?: number | null } = {}): void {
  const account = options.account ?? 'account-a'
  const project = options.project ?? 'project-a'
  const session = options.session ?? 'session-a'
  const model = options.model ?? 'model-a'
  saveRun(root, runRecordSchema.parse({
    id, projectId: project, mode: 'chat', harness: 'pi', sessionType: 'structured', sessionId: session,
    nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: null,
    startedAt: at, endedAt: at, status: 'completed', accountId: account
  }))
  appendEvent(root, {
    id: `event-${id}`, runId: id, sessionId: session, sequence: 1, timestamp: at, type: 'usage.updated',
    payload: {
      ...(options.cost === null ? {} : { costUsd: options.cost ?? 0.5 }),
      ...(options.cost === null ? {} : { costSource: 'harness' }),
      model, provider: 'provider-a', requests: 1,
      request: {
        index: 1, model, provider: 'provider-a', inputTokens: 1_000, cacheReadTokens: 200, cacheWriteTokens: 100,
        outputTokens: 400, ...(options.cost === null ? {} : { costUsd: options.cost ?? 0.5, costSource: 'harness' })
      }
    }
  })
  indexRunUsage(root, id)
}

test('one period, one scope, exact totals', async () => {
  const root = fixture()
  addRun(root, 'run-a', '2026-03-09T10:00:00.000Z', { cost: 0.5 })
  addRun(root, 'run-b', '2026-03-10T10:00:00.000Z', { model: 'model-b', cost: 0.25 })
  const summary = await summarize({
    root,
    filter: { session: null, account: 'account-a', project: null },
    period: '7d',
    timezoneOffsetMinutes: 0,
    now: new Date('2026-03-10T12:00:00.000Z'),
    accountLabel: () => 'Work'
  })
  expect(summary.scope).toBe('account')
  expect(summary.totals.requests).toBe(2)
  expect(summary.totals.inputTokens).toBe(2_000)
  expect(summary.totals.costUsd).toBeCloseTo(0.75)
  expect(summary.totals.cacheHitPercent).toBeCloseTo((400 / 2_600) * 100, 1)
  expect(summary.byModel.map((row) => row.label).sort()).toEqual(['provider-a/model-a', 'provider-a/model-b'])
  expect(summary.byModel.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(2_000)
  expect(summary.byAccount[0]!.label).toBe('Work')
})

test('a period excludes older requests and groups by local day', async () => {
  const root = fixture()
  addRun(root, 'run-old', '2026-02-01T10:00:00.000Z')
  addRun(root, 'run-a', '2026-03-09T10:00:00.000Z')
  addRun(root, 'run-b', '2026-03-10T10:00:00.000Z')
  const summary = await summarize({
    root,
    filter: { session: null, account: null, project: 'project-a' },
    period: 'today',
    timezoneOffsetMinutes: 0,
    now: new Date('2026-03-10T12:00:00.000Z')
  })
  expect(summary.totals.requests).toBe(1)
  expect(summary.byDay.map((day) => day.day)).toEqual(['2026-03-10'])
})

test('a timezone shifts the local day boundary', async () => {
  const root = fixture()
  addRun(root, 'run-a', '2026-03-09T23:30:00.000Z')
  const utc = await summarize({ root, filter: { session: null, account: null, project: null }, period: 'all', timezoneOffsetMinutes: 0, now: new Date('2026-03-10T12:00:00.000Z') })
  const tokyo = await summarize({ root, filter: { session: null, account: null, project: null }, period: 'all', timezoneOffsetMinutes: 540, now: new Date('2026-03-10T12:00:00.000Z') })
  expect(utc.byDay[0]!.day).toBe('2026-03-09')
  expect(tokyo.byDay[0]!.day).toBe('2026-03-10')
})

test('the period range starts at local midnight', () => {
  const range = periodRange('today', 120, new Date('2026-03-10T12:00:00.000Z'))
  expect(range.from).toBe('2026-03-09T22:00:00.000Z')
  expect(range.to).toBe('2026-03-10T12:00:00.000Z')
})

test('an unpriced request is estimated at list rates and counted', async () => {
  const root = fixture()
  addRun(root, 'run-a', '2026-03-09T10:00:00.000Z', { cost: null })
  const summary = await summarize({
    root,
    filter: { session: null, account: null, project: null },
    period: 'all',
    timezoneOffsetMinutes: 0,
    now: new Date('2026-03-10T12:00:00.000Z'),
    rates: async () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  })
  // 1,000 input at $1/M + 400 output at $2/M.
  expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.0018, 6)
  expect(summary.totals.costUsd).toBeCloseTo(0.0018, 6)
  expect(summary.totals.unpricedRequests).toBe(1)
  expect(summary.byModel[0]!.estimatedCostUsd).toBeCloseTo(0.0018, 6)
})

test('without rates an unpriced request stays unknown', async () => {
  const root = fixture()
  addRun(root, 'run-a', '2026-03-09T10:00:00.000Z', { cost: null })
  const summary = await summarize({ root, filter: { session: null, account: null, project: null }, period: 'all', timezoneOffsetMinutes: 0, now: new Date('2026-03-10T12:00:00.000Z') })
  expect(summary.totals.costUsd).toBeNull()
  expect(summary.totals.unpricedRequests).toBe(1)
})
