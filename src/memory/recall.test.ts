import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { writeFile } from '../../tests/helpers'
import { createEnv, type HarnessEnv } from '../core/env'
import { newId, writeJson } from '../core/fs'
import { closeIndex } from '../core/index'
import { runRecordSchema, type RunRecord } from '../sessions/contracts'
import { parseEvent } from '../sessions/runStore'
import type { CallerContext } from './caller'
import { passages, read, readTool, search, searchTool, sync } from './recall'

const run = (id: string, mode: string, session: string, project: string | null, goal: string): RunRecord =>
  runRecordSchema.parse({ id, projectId: project, mode, harness: 'pi', sessionType: 'structured', sessionId: session, nativeSessionId: null, workingDirectory: null, worktreeId: null, goal, startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:01:00.000Z', status: 'completed' })

const event = (runId: string, type: string, payload: unknown) => ({ id: newId(), runId, sessionId: 's', sequence: 1, timestamp: '2026-10-01T10:00:30.000Z', type, payload })

function save(root: string, record: RunRecord, events: unknown[]): void {
  writeJson(join(root, 'runs', record.id, 'run.json'), record)
  writeFile(join(root, 'runs', record.id, 'events.jsonl'), `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))

function setup(): HarnessEnv {
  const root = mkdtempSync(join(tmpdir(), 'harness-recall-'))
  roots.push(root)
  writeJson(join(root, 'projects.json'), [
    { id: 'p1', name: 'App', slug: 'app', rootPath: '/tmp/app', autoMaintenance: true, createdAt: 't' },
    { id: 'p2', name: 'Site', slug: 'site', rootPath: '/tmp/site', autoMaintenance: true, createdAt: 't' }
  ])
  save(root, run('chat-1', 'chat', 'agent-a', null, 'Which package manager do we use?'), [
    event('chat-1', 'tool.started', { toolCallId: 't1', name: 'read', summary: 'package.json' }),
    event('chat-1', 'message.completed', { messageId: 'm1', role: 'assistant', text: 'We use pnpm for every workspace.' })
  ])
  save(root, run('chat-2', 'chat', 'agent-b', null, 'Plan the launch'), [event('chat-2', 'message.completed', { messageId: 'm1', role: 'assistant', text: 'The launch is on Friday; pnpm build first.' })])
  save(root, run('code-1', 'code', 'pane-1', 'p1', 'Fix the pnpm lockfile'), [event('code-1', 'message.completed', { messageId: 'm1', role: 'assistant', text: 'Regenerated the lockfile.' })])
  save(root, run('code-2', 'code', 'pane-2', 'p2', 'Deploy the site with pnpm'), [])
  return createEnv(root, { directory: { agentName: (id) => (id === 'agent-a' ? 'Nora' : id === 'agent-b' ? 'Kai' : null), sessionAgent: () => null } })
}

const agent = (id: string): CallerContext => ({ agentId: id, actor: 'Chat' })

test('a run becomes its request, messages and tool summaries', () => {
  const record = run('r', 'chat', 'a', null, '[App coordination event e1 / review — not a user message]')
  const events = [event('r', 'tool.started', { toolCallId: 't1', name: 'grep', summary: 'TODO' }), event('r', 'message.completed', { messageId: 'm1', role: 'assistant', text: ' Done. ' }), event('r', 'message.delta', { messageId: 'm1', text: 'x' })].flatMap((entry) => parseEvent(entry) ?? [])
  const found = passages(record, events)
  expect(found.map((passage) => passage.role)).toEqual(['event', 'tool', 'assistant'])
  expect(found[1].text).toBe('grep: TODO')
  expect(found[2].text).toBe('Done.')
})

test('sync indexes missing runs once and reindexes changed ones', () => {
  const { root } = setup()
  expect(sync(root)).toBe(4)
  expect(sync(root)).toBe(0)
  save(root, { ...run('code-2', 'code', 'pane-2', 'p2', 'Deploy the site with pnpm'), status: 'failed' }, [event('code-2', 'message.completed', { messageId: 'm1', role: 'assistant', text: 'Wrangler failed pnpm.' })])
  expect(sync(root)).toBe(1)
  expect(read(root, 'code-2')).toHaveLength(2)
  expect(search(root, 'pnpm', {}, 30)).toHaveLength(5)
})

test('an agent recalls its own chats by default and everything on request', () => {
  const env = setup()
  sync(env.root)
  const mine = searchTool(env, agent('agent-a'), { query: 'pnpm package manager' })
  expect(mine).toContain('run chat-1')
  expect(mine).toContain('chat with Nora')
  expect(mine).not.toContain('chat-2')
  expect(mine).not.toContain('code-1')
  const all = searchTool(env, agent('agent-a'), { query: 'pnpm', scope: 'all' })
  expect(all).toContain('chat-2')
  expect(all).toContain('code-1')
  expect(all).toContain('Harness session in App')
  const project = searchTool(env, agent('agent-a'), { query: 'pnpm', project: 'site' })
  expect(project).toContain('code-2')
  expect(project).not.toContain('code-1')
  expect(searchTool(env, agent('agent-a'), { query: 'zebra' })).toContain('scope "all"')
  expect(searchTool(env, agent('agent-a'), { query: 'pnpm', since: '2027-01-01' })).toContain('Nothing')
  const transcript = readTool(env, agent('agent-a'), { run: 'chat-2' })
  expect(transcript).toContain('user: Plan the launch')
  expect(transcript).toContain('assistant: The launch is on Friday')
  // The run a caller is in is not offered back to it.
  expect(searchTool(env, { ...agent('agent-a'), runId: 'chat-1' }, { query: 'pnpm' })).not.toContain('run chat-1')
})

test('a session recalls only session runs of its project', () => {
  const env = setup()
  sync(env.root)
  const session: CallerContext = { sessionId: 'pane-9', projectId: 'p1', actor: 'Code' }
  const hits = searchTool(env, session, { query: 'pnpm', scope: 'all' })
  expect(hits).toContain('code-1')
  for (const other of ['chat-1', 'chat-2', 'code-2']) expect(hits).not.toContain(other)
  expect(readTool(env, session, { run: 'code-1' })).toContain('Run code-1')
  expect(() => readTool(env, session, { run: 'chat-1' })).toThrow()
  expect(() => readTool(env, session, { run: 'code-2' })).toThrow()
  // Without a project, a session sees only its own runs.
  const loose: CallerContext = { sessionId: 'pane-1', actor: 'Code' }
  expect(searchTool(env, loose, { query: 'pnpm' })).toContain('code-1')
  expect(() => readTool(env, loose, { run: 'code-2' })).toThrow()
})
