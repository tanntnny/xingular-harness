import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { closeIndex } from '../core/index'
import { runRecordSchema, type RunRecord } from './contracts'
import { recordRun, runsForSession, runsSince } from './runIndex'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => {
  closeIndex(root)
  rmSync(root, { recursive: true, force: true })
}))

const record = (id: string, startedAt: string, agentId: string | null): RunRecord => runRecordSchema.parse({
  id,
  projectId: null,
  mode: 'chat',
  harness: 'pi',
  sessionType: 'structured',
  sessionId: 'agent-a',
  nativeSessionId: null,
  workingDirectory: null,
  worktreeId: null,
  goal: null,
  startedAt,
  endedAt: null,
  status: 'completed',
  accountId: 'account-a',
  agentId
})

test('indexes and filters runs with positional SQLite parameters', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-run-index-'))
  roots.push(root)
  recordRun(root, record('legacy-chat', '2026-10-01T10:00:00.000Z', null))
  recordRun(root, record('current-chat', '2026-10-02T10:00:00.000Z', 'agent-a'))
  recordRun(root, { ...record('other-chat', '2026-10-03T10:00:00.000Z', 'agent-b'), sessionId: 'agent-b', accountId: 'account-b' })

  expect(runsForSession(root, 'agent-a', 10)).toEqual(['current-chat', 'legacy-chat'])
  expect(runsSince(root, { agent: 'agent-a', account: 'account-a' }, '2026-10-01T00:00:00.000Z')).toEqual(['legacy-chat', 'current-chat'])
  expect(runsSince(root, { session: 'agent-b' }, '2026-10-01T00:00:00.000Z')).toEqual(['other-chat'])
})
