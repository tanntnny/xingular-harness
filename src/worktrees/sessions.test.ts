import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { PiEvent } from '../sessions/runner'
import { loadRun } from '../sessions/runStore'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

test('unknown worktree IDs stay opaque and registered removed IDs fail closed', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wt-run-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo, env })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repo, env })

  const seen: string[] = []
  const harness = createHarness({
    dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore(),
    sessionFactory: async ({ params }) => {
      seen.push(params.cwd)
      let listener: (event: PiEvent) => void = () => undefined
      return {
        sessionId: `native-${params.runId}`,
        subscribe: (fn: (event: PiEvent) => void) => { listener = fn; return () => undefined },
        prompt: async () => { listener({ type: 'agent_end', messages: [] } as unknown as PiEvent) },
        sendCustomMessage: async () => undefined,
        abort: async () => undefined,
        dispose: () => undefined
      }
    }
  })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')

  await harness.sessions.run({
    run: { id: 'opaque-run', sessionId: 's-1', worktreeId: 'unknown-id' }, cwd: repo, sessionDir: join(base, 'sessions'), text: 'opaque',
    caller: {}, tools: { allow: ['read'] }
  })
  expect(seen).toEqual([repo])
  expect(loadRun(harness.env.root, 'opaque-run')).toMatchObject({ worktreeId: 'unknown-id', workingDirectory: repo })

  const { worktree } = await harness.worktrees.create({ repo })
  await harness.worktrees.remove(worktree.id)
  await expect(harness.sessions.run({
    run: { id: 'removed-run', sessionId: 's-2', worktreeId: worktree.id }, cwd: repo, sessionDir: join(base, 'sessions'), text: 'must not fall back',
    caller: {}, tools: { allow: ['read'] }
  })).rejects.toMatchObject({ code: 'worktree_removed' })
  expect(seen).toEqual([repo])
})

test('overlapping runs in one session share a worktree lease until both settle', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wt-run-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo, env })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repo, env })

  const finishes = new Map<string, () => void>()
  const seen: string[] = []
  const harness = createHarness({
    dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore(),
    sessionFactory: async ({ params }) => {
      seen.push(params.cwd)
      let listener: (event: PiEvent) => void = () => undefined
      return {
        sessionId: `native-${params.runId}`,
        subscribe: (fn: (event: PiEvent) => void) => { listener = fn; return () => undefined },
        prompt: () => new Promise<void>((resolve) => { finishes.set(params.runId, () => { listener({ type: 'agent_end', messages: [] } as unknown as PiEvent); resolve() }) }),
        sendCustomMessage: async () => undefined,
        abort: async () => undefined,
        dispose: () => undefined
      }
    }
  })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const { worktree } = await harness.worktrees.create({ repo })

  await harness.sessions.run({
    run: { id: 'wt-run', sessionId: 's-1', worktreeId: worktree.id }, cwd: repo, sessionDir: join(base, 'sessions'), text: 'hi',
    caller: {}, tools: { allow: ['read'] }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seen).toEqual([worktree.path])
  expect(loadRun(harness.env.root, 'wt-run').worktreeId).toBe(worktree.id)
  expect(harness.worktrees.get(worktree.id).lease?.holder).toBe('s-1')

  await harness.sessions.run({
    run: { id: 'wt-run-2', sessionId: 's-1', worktreeId: worktree.id }, cwd: repo, sessionDir: join(base, 'sessions'), text: 'hi again',
    caller: {}, tools: { allow: ['read'] }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(seen).toEqual([worktree.path, worktree.path])

  finishes.get('wt-run')!()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(harness.worktrees.get(worktree.id).lease?.holder).toBe('s-1')

  finishes.get('wt-run-2')!()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(harness.worktrees.get(worktree.id).lease).toBeNull()
})
