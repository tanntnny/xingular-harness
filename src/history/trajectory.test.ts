import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createEnv } from '../core/env'
import { closeIndex } from '../core/index'
import { writeJson } from '../core/fs'
import { runRecordSchema, type RunEvent, type RunRecord } from '../sessions/contracts'
import { appendEvent, saveRun } from '../sessions/runStore'
import { HARNESS_TOOLS } from '../tools/definitions'
import type { CallerContext } from '../core/caller'
import { dispatch } from '../tools/dispatch'
import { readTool, searchTool } from './trajectory'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'harness-trajectory-'))
  roots.push(root)
  writeJson(join(root, 'projects.json'), [
    { id: 'p1', name: 'App', slug: 'app', rootPath: '/tmp/app', autoMaintenance: true, createdAt: 't' },
    { id: 'p2', name: 'Site', slug: 'site', rootPath: '/tmp/site', autoMaintenance: true, createdAt: 't' }
  ])
  const env = createEnv(root, {
    directory: {
      agentName: (id) => ({ 'agent-a': 'Nora', 'agent-b': 'Kai', 'agent-hidden': 'Hidden' })[id] ?? null,
      sessionAgent: (id) => id === 'hidden-session' ? 'agent-hidden' : null
    }
  })
  return { root, env }
}

function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return runRecordSchema.parse({
    id,
    projectId: null,
    mode: 'chat',
    harness: 'pi',
    sessionType: 'structured',
    sessionId: `session-${id}`,
    goal: `Goal for ${id}`,
    startedAt: '2026-10-18T10:00:00.000Z',
    endedAt: null,
    status: 'running',
    agentId: 'agent-a',
    ...overrides
  })
}

function event(runId: string, sequence: number, type: RunEvent['type'], payload: unknown, native?: unknown): RunEvent {
  return {
    id: `${runId}-event-${sequence}`,
    runId,
    sessionId: `session-${runId}`,
    sequence,
    timestamp: `2026-10-18T10:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    payload,
    ...(native === undefined ? {} : { native })
  } as RunEvent
}

function save(root: string, record: RunRecord, events: RunEvent[] = []): void {
  saveRun(root, record)
  for (const entry of events) appendEvent(root, entry)
}

const agent: CallerContext = { agentId: 'agent-a', actor: 'Chat' }

test('trajectory search filters runs and paginates deterministically, including active runs', () => {
  const { root, env } = setup()
  save(root, run('z-run', { projectId: 'p2', agentId: 'agent-b' }))
  save(root, run('b-run', { projectId: 'p2', agentId: 'agent-b' }))
  save(root, run('a-run', { projectId: 'p1', agentId: 'agent-a', startedAt: '2026-10-17T10:00:00.000Z', status: 'completed', endedAt: '2026-10-17T10:01:00.000Z' }))

  const first = JSON.parse(searchTool(env, agent, { project: 'site', agent: 'Kai', limit: 1 }))
  expect(first.runs.map((item: { id: string }) => item.id)).toEqual(['z-run'])
  expect(first.runs[0]).toMatchObject({ agentId: 'agent-b', agentName: 'Kai', project: { id: 'p2', name: 'Site', slug: 'site' }, status: 'running' })
  expect(first.hasMore).toBe(true)

  const second = JSON.parse(searchTool(env, agent, { project: 'p2', agent: 'agent-b', limit: 1, cursor: first.nextCursor }))
  expect(second.runs.map((item: { id: string }) => item.id)).toEqual(['b-run'])
  expect(second.hasMore).toBe(false)

  const bounded = JSON.parse(searchTool(env, agent, { since: '2026-10-18', until: '2026-10-18', status: 'running' }))
  expect(bounded.runs.map((item: { id: string }) => item.id)).toEqual(['z-run', 'b-run'])
})

test('trajectory summaries expose stop metadata and null for legacy and active runs', () => {
  const { root, env } = setup()
  save(root, run('interrupted', { status: 'interrupted', terminalReason: 'Work budget reached', terminalCode: 'slice_budget' }))
  save(root, run('legacy', { status: 'interrupted', terminalReason: 'old reason' }))
  save(root, run('active'))
  const results = JSON.parse(searchTool(env, agent, {})).runs
  expect(results.find((item: { id: string }) => item.id === 'interrupted')).toMatchObject({ terminalReason: 'Work budget reached', terminalCode: 'slice_budget' })
  expect(results.find((item: { id: string }) => item.id === 'legacy')).toMatchObject({ terminalReason: 'old reason', terminalCode: null })
  expect(results.find((item: { id: string }) => item.id === 'active')).toMatchObject({ terminalReason: null, terminalCode: null })
  expect(JSON.parse(readTool(env, agent, { run: 'interrupted' })).run).toMatchObject({ terminalReason: 'Work budget reached', terminalCode: 'slice_budget' })
})

test('trajectory search and read keep host-excluded agents hidden', () => {
  const { root, env } = setup()
  save(root, run('hidden-agent-run', { agentId: 'agent-hidden' }))
  save(root, run('hidden-session-run', { agentId: null, sessionId: 'hidden-session' }))
  save(root, run('visible-run'))
  const caller = { ...agent, recallExcludeAgents: ['agent-hidden'] }

  const results = JSON.parse(searchTool(env, caller, {}))
  expect(results.runs.map((item: { id: string }) => item.id)).toEqual(['visible-run'])
  expect(() => readTool(env, caller, { run: 'hidden-agent-run' })).toThrow()
  expect(() => readTool(env, caller, { run: 'hidden-session-run' })).toThrow()
})

test('trajectory_read resolves current and returns bounded event pages without native data', () => {
  const { root, env } = setup()
  const longInput = 'x'.repeat(20_000)
  save(root, run('active-run'), [
    event('active-run', 0, 'context.snapshot', { systemPrompt: 'Be useful', tools: [] }, { privateNative: true }),
    event('active-run', 1, 'tool.started', { toolCallId: 't1', name: 'read', input: longInput }),
    event('active-run', 2, 'tool.completed', { toolCallId: 't1', name: 'read', output: 'file contents' })
  ])
  const caller = { ...agent, runId: 'active-run' }

  const initial = JSON.parse(readTool(env, caller, { run: 'current', limit: 1 }))
  expect(initial.events[0]).toMatchObject({ sequence: 0, type: 'context.snapshot', payload: { systemPrompt: 'Be useful', tools: [] } })
  expect(JSON.stringify(initial)).not.toContain('privateNative')

  const first = JSON.parse(readTool(env, caller, { run: 'current', afterSequence: 0, limit: 1 }))
  expect(first).toMatchObject({ active: true, run: { id: 'active-run', status: 'running' }, hasMore: true, nextAfterSequence: 1 })
  expect(first.events[0]).toMatchObject({ sequence: 1, type: 'tool.started', truncatedFields: ['payload.input'] })
  expect(JSON.stringify(first)).not.toContain('privateNative')
  expect(first.events[0].payload.input.length).toBeLessThan(longInput.length)

  const second = JSON.parse(readTool(env, caller, { run: 'active-run', afterSequence: first.nextAfterSequence, limit: 1 }))
  expect(second.events[0]).toMatchObject({ sequence: 2, type: 'tool.completed', payload: { output: 'file contents' } })
  expect(second.hasMore).toBe(false)
})

test('trajectory_read follows execution events through the first outcome only', () => {
  const { root, env } = setup()
  save(root, run('settled-run', { status: 'completed', endedAt: '2026-10-18T10:01:00.000Z' }), [
    event('settled-run', 0, 'started', {}),
    event('settled-run', 1, 'completed', {}),
    event('settled-run', 2, 'tool.started', { toolCallId: 'late', name: 'ignored' }, { hostIgnored: 'run_already_ended' })
  ])

  const result = JSON.parse(readTool(env, agent, { run: 'settled-run' }))
  expect(result.active).toBe(false)
  expect(result.events.map((item: { sequence: number }) => item.sequence)).toEqual([0, 1])
  expect(JSON.stringify(result)).not.toContain('ignored')
})

test('trajectory_read keeps account identifiers and credential fields out of event payloads', () => {
  const { root, env } = setup()
  save(root, run('safe-run'), [
    event('safe-run', 0, 'account.status', { accountId: 'private-account-id', category: 'quota', message: 'Limit reached for sk-abcdefghijklmnopqrstuvwxyz012345' }),
    event('safe-run', 1, 'tool.started', { toolCallId: 't1', name: 'login', input: '{"username":"ada","password":"private-password"}' }),
    event('safe-run', 2, 'usage.updated', { inputTokens: 10, request: { index: 1, reasoningSummary: 'private reasoning summary' } })
  ])

  const result = JSON.parse(readTool(env, agent, { run: 'safe-run' }))
  expect(result.events[0].omittedFields).toContain('payload.accountId')
  expect(JSON.stringify(result)).not.toContain('private-account-id')
  expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  expect(JSON.stringify(result)).not.toContain('private-password')
  expect(result.events[1].payload.input).not.toContain('password')
  expect(result.events[2].omittedFields).toContain('payload.request.reasoningSummary')
  expect(JSON.stringify(result)).not.toContain('private reasoning summary')
})

test('trajectory calls reject malformed filters and missing current runs', () => {
  const { env } = setup()
  expect(() => searchTool(env, agent, { status: 'unknown' })).toThrow()
  expect(() => searchTool(env, agent, { since: 'not-a-date' })).toThrow()
  expect(() => searchTool(env, agent, { cursor: 'not-a-cursor' })).toThrow()
  expect(() => readTool(env, agent, { run: 'current' })).toThrow()
  expect(() => readTool(env, agent, { run: 'missing' })).toThrow()
})

test('the model tool registry exposes both trajectory calls through Wiki dispatch', () => {
  const { root, env } = setup()
  save(root, run('registered-run'))
  const calls = HARNESS_TOOLS.map((tool) => tool.call)
  expect(calls).toContain('trajectory.search')
  expect(calls).toContain('trajectory.read')
  expect(JSON.parse(dispatch(env, agent, 'trajectory.search', {})).runs[0].id).toBe('registered-run')
  expect(JSON.parse(dispatch(env, agent, 'trajectory.read', { run: 'registered-run' })).run.id).toBe('registered-run')
})
