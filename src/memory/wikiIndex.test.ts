import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { writeFile } from '../../tests/helpers'
import { writeJson } from '../core/fs'
import { all, closeIndex, dbPath, migrate, withIndex } from '../core/index'
import { runRecordSchema, type RunRecord } from '../sessions/contracts'
import { recordRun, runsSince, syncRuns } from '../sessions/runIndex'
import { ensure, rebuild, search } from './wikiIndex'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-index-'))
const page = (root: string, relative: string, text: string) => writeFile(join(root, 'wiki', relative), text)
const record = (fields: Partial<RunRecord> & { id: string }): RunRecord => runRecordSchema.parse({ projectId: null, mode: 'chat', harness: 'pi', sessionType: 'structured', sessionId: 'agent-1', nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: null, startedAt: new Date().toISOString(), endedAt: null, status: 'completed', ...fields })

test('rebuild indexes the whole wiki and boosts the current project', () => {
  const root = temp()
  page(root, 'library/a.md', '---\nid: tauri\ntitle: Use Tauri for the desktop shell\ntype: decision\n---\n\nRust host and React renderer.\n')
  page(root, 'projects/app/b.md', '---\nid: notes\ntitle: Meeting notes\ntype: summary\n---\n\nWe mentioned tauri once.\n')
  page(root, 'facts/m.md', '---\nid: shell\ntitle: Shell choice\nkind: decision\n---\n\nTauri stays.\n')
  expect(rebuild(root)).toBe(2)
  const first = search(root, 'tauri', 10, null)
  expect(first[0]).toBe('tauri')
  expect(first).toHaveLength(3)
  expect(search(root, 'rend', 10, null)).toEqual(['tauri'])
  // The current project's namespace ranks higher but nothing else is hidden.
  const boosted = search(root, 'tauri', 10, '/projects/app')
  expect(boosted.indexOf('notes')).toBeLessThanOrEqual(first.indexOf('notes'))
  expect(boosted).toHaveLength(3)
  // Rebuilding from files after deleting the index gives the same results.
  closeIndex(root)
  rmSync(dbPath(root))
  expect(ensure(root)).toBe(2)
  expect(search(root, 'tauri', 10, null)).toEqual(first)
  closeIndex(root)
})

test('runs are listed per account and agent and survive a rebuild', () => {
  const root = temp()
  const run = record({ id: 'run1', mode: 'code', harness: 'codex', sessionId: 's1', agentId: 'agent-7', accountId: 'acc1' })
  writeJson(join(root, 'runs/run1/run.json'), run)
  writeFileSync(join(root, 'runs/run1/events.jsonl'), '{"type":"usage.updated","payload":{"inputTokens":7,"outputTokens":3,"model":"gpt"}}\n')
  recordRun(root, run)
  expect(runsSince(root, { account: 'acc1' }, null)).toEqual(['run1'])
  expect(runsSince(root, { agent: 'agent-7' }, null)).toEqual(['run1'])
  rebuild(root)
  expect(runsSince(root, { account: 'acc1' }, null)).toEqual(['run1'])
  expect(runsSince(root, { agent: 'agent-7' }, null)).toEqual(['run1'])
  expect(runsSince(root, { agent: 'agent-8' }, null)).toEqual([])
  expect(withIndex(root, (database) => all<{ count: number }>(database, "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'usage'")[0].count)).toBe(0)
  closeIndex(root)
})

test('runs the index never saw are picked up from their files', () => {
  const root = temp()
  const run = (id: string, status: string) => record({ id, status, startedAt: `2026-10-01T10:00:0${id.length}.000Z`, accountId: 'acc1' })
  // The index file exists with one run before the others are noticed, so `ensure` does not rebuild.
  writeJson(join(root, 'runs/a/run.json'), run('a', 'running'))
  recordRun(root, run('a', 'running'))
  writeJson(join(root, 'runs/a/run.json'), run('a', 'completed'))
  writeJson(join(root, 'runs/bb/run.json'), run('bb', 'completed'))

  ensure(root)
  expect(runsSince(root, { session: 'agent-1' }, null)).toEqual(['a', 'bb'])
  expect(runsSince(root, { session: 'agent-1' }, '2026-10-01T10:00:02.000Z')).toEqual(['bb'])
  // Chat runs from before the agent column count for the agent whose conversation they ran in.
  expect(runsSince(root, { agent: 'agent-1' }, null)).toHaveLength(2)
  expect(runsSince(root, { account: 'acc1' }, null)).toEqual(['a', 'bb'])
  expect(runsSince(root, { account: 'other' }, null)).toEqual([])
  expect(withIndex(root, (database) => all<{ status: string }>(database, "SELECT status FROM runs WHERE id = 'a'")[0].status)).toBe('completed')
  // Nothing is rewritten once the tables match the files.
  expect(syncRuns(root)).toBe(0)
  closeIndex(root)
})

test('failed migration restores the backup', () => {
  const path = join(temp(), 'index.sqlite')
  const good = ["CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('before');"]
  migrate(path, good).close()
  expect(() => migrate(path, [good[0], 'CREATE TABLE extra (value TEXT); THIS IS NOT SQL;'])).toThrow('Index migration 2 failed')
  const database = new DatabaseSync(path)
  expect((database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('1')
  expect((database.prepare('SELECT value FROM kept').get() as { value: string }).value).toBe('before')
  expect(() => database.prepare('SELECT COUNT(*) FROM extra').get()).toThrow()
  database.close()
})
