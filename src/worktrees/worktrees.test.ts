import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { scriptHash, SETUP_SCRIPT } from './setup'
import { Worktrees } from './service'
import type { WorktreeRecord } from './types'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-wt-')))
  const repo = join(base, 'repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, '.gitignore'), '.env\nsecret/\nbig/\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'first')
  const worktrees = new Worktrees(join(base, 'state'), { keep: 2 })
  return { base, repo, worktrees }
}

test('creates a detached managed worktree and carries uncommitted and untracked work', async () => {
  const { repo, worktrees } = fixture()
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  writeFileSync(join(repo, 'new.txt'), 'fresh\n')
  const result = await worktrees.create({ repo })
  const { path } = result.worktree
  expect(result.worktree.branch).toBeNull()
  expect(result.worktree.kind).toBe('managed')
  expect(sh(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('changed\n')
  expect(readFileSync(join(path, 'new.txt'), 'utf8')).toBe('fresh\n')
  expect(result.carried.patched).toBe(true)
  expect(await worktrees.list(repo)).toHaveLength(1)
  expect(worktrees.pathOf(result.worktree.id)).toBe(path)
})

test.skipIf(process.platform === 'win32')('disables every configured custom clean, smudge, and process filter', async () => {
  const { base, repo, worktrees } = fixture()
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=spy\n')
  sh(repo, 'add', '.gitattributes')
  sh(repo, 'commit', '-q', '-m', 'attributes')
  const marker = join(base, 'filter-ran')
  const filter = join(base, 'filter.sh')
  writeFileSync(filter, `#!/bin/sh\nprintf x >> '${marker}'\ncat\n`)
  chmodSync(filter, 0o755)
  for (const operation of ['clean', 'smudge', 'process']) sh(repo, 'config', `filter.spy.${operation}`, filter)
  sh(repo, 'config', 'filter.spy.required', 'true')

  const { worktree } = await worktrees.create({ repo })
  expect(existsSync(marker)).toBe(false)
  writeFileSync(join(worktree.path, 'a.txt'), 'changed\n')
  await worktrees.remove(worktree.id, { force: true })
  expect(existsSync(marker)).toBe(false)
})

test('copies ignored files named in .worktreeinclude, never overwriting or following links', async () => {
  const { repo, worktrees } = fixture()
  writeFileSync(join(repo, '.worktreeinclude'), '.env\nsecret/\n')
  writeFileSync(join(repo, '.env'), 'KEY=1\n')
  mkdirSync(join(repo, 'secret'))
  writeFileSync(join(repo, 'secret', 'token'), 't\n')
  symlinkSync('/etc/hosts', join(repo, 'secret', 'link'))
  mkdirSync(join(repo, 'big'))
  writeFileSync(join(repo, 'big', 'blob'), 'not named\n')
  const { worktree, included } = await worktrees.create({ repo, carryChanges: false })
  expect(included.copied.sort()).toEqual(['.env', 'secret/token'])
  expect(included.skipped).toContainEqual({ path: 'secret/link', reason: 'symlink' })
  expect(existsSync(join(worktree.path, 'big', 'blob'))).toBe(false)
})

test('a named branch, unique names and invalid names', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo, name: 'feature', branch: 'feature', kind: 'permanent' })
  expect(worktree.branch).toBe('wt/feature')
  expect(sh(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wt/feature')
  await expect(worktrees.create({ repo, name: 'feature' })).rejects.toMatchObject({ code: 'worktree_exists' })
  await expect(worktrees.create({ repo, name: 'Bad Name' })).rejects.toMatchObject({ code: 'invalid_request' })
  const detached = (await worktrees.create({ repo })).worktree
  expect((await worktrees.branch(detached.id, 'later')).branch).toBe('wt/later')
})

test('the setup script runs only once its exact text is trusted', async () => {
  const { repo, worktrees } = fixture()
  mkdirSync(join(repo, '.xharness'))
  const script = 'echo ready > setup-ran.txt\n'
  writeFileSync(join(repo, SETUP_SCRIPT), script)
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'setup')
  const first = await worktrees.create({ repo })
  expect(first.setup.state).toBe('untrusted')
  expect(existsSync(join(first.worktree.path, 'setup-ran.txt'))).toBe(false)
  await worktrees.trustSetup(repo, scriptHash(script))
  const second = await worktrees.create({ repo })
  expect(second.setup.state).toBe('ran')
  expect(readFileSync(join(second.worktree.path, 'setup-ran.txt'), 'utf8')).toBe('ready\n')
})

test('removal keeps a snapshot of work, and restore brings it back', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  writeFileSync(join(worktree.path, 'a.txt'), 'edited in worktree\n')
  writeFileSync(join(worktree.path, 'made.txt'), 'new file\n')
  await expect(worktrees.remove(worktree.id)).rejects.toMatchObject({ code: 'worktree_has_work' })
  const { snapshot } = await worktrees.remove(worktree.id, { force: true })
  expect(snapshot).toBe(`refs/xharness/snapshots/${worktree.id}`)
  expect(existsSync(worktree.path)).toBe(false)
  expect(await worktrees.list(repo)).toHaveLength(0)
  const restored = await worktrees.restore(worktree.id)
  expect(restored.removed).toBeNull()
  expect(readFileSync(join(worktree.path, 'a.txt'), 'utf8')).toBe('edited in worktree\n')
  expect(readFileSync(join(worktree.path, 'made.txt'), 'utf8')).toBe('new file\n')
  expect(sh(worktree.path, 'diff', '--cached', '--name-only')).toBe('')
})

test('a clean worktree is removed without a snapshot', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  expect((await worktrees.remove(worktree.id)).snapshot).toBeNull()
})

test('ignored files require force and survive removal and restore in the bounded snapshot', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  mkdirSync(join(worktree.path, 'secret'))
  writeFileSync(join(worktree.path, '.env'), 'KEY=1\n')
  writeFileSync(join(worktree.path, 'secret', 'token'), 'private\n')

  await expect(worktrees.remove(worktree.id)).rejects.toMatchObject({ code: 'worktree_has_work' })
  expect(existsSync(worktree.path)).toBe(true)
  const removed = await worktrees.remove(worktree.id, { force: true })
  expect(removed.snapshot).toBe(`refs/xharness/snapshots/${worktree.id}`)
  expect(existsSync(worktree.path)).toBe(false)

  await worktrees.restore(worktree.id)
  expect(readFileSync(join(worktree.path, '.env'), 'utf8')).toBe('KEY=1\n')
  expect(readFileSync(join(worktree.path, 'secret', 'token'), 'utf8')).toBe('private\n')
})

test('an ignored file beyond the snapshot cap makes removal fail without deleting it', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  const tooLarge = 'x'.repeat(5 * 1024 * 1024 + 1)
  writeFileSync(join(worktree.path, '.env'), tooLarge)

  await expect(worktrees.remove(worktree.id, { force: true })).rejects.toMatchObject({ code: 'worktree_has_work' })
  expect(existsSync(worktree.path)).toBe(true)
  expect(readFileSync(join(worktree.path, '.env'), 'utf8')).toHaveLength(tooLarge.length)
  expect(worktrees.get(worktree.id).removed).toBeNull()
})

test('opaque IDs stay unknown while registered removed or missing worktrees fail closed', async () => {
  const { repo, worktrees } = fixture()
  expect(worktrees.pathOf('opaque-id')).toBeNull()

  const removed = (await worktrees.create({ repo })).worktree
  await worktrees.remove(removed.id)
  expect(() => worktrees.pathOf(removed.id)).toThrow(expect.objectContaining({ code: 'worktree_removed' }))

  const missing = (await worktrees.create({ repo })).worktree
  rmSync(missing.path, { recursive: true, force: true })
  expect(() => worktrees.pathOf(missing.id)).toThrow(expect.objectContaining({ code: 'worktree_missing' }))
})

test('leases lock a worktree to one session, and a lease of a gone process is recovered', async () => {
  const { base, repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  await worktrees.acquire(worktree.id, 'session-a')
  expect(sh(repo, 'worktree', 'list', '--porcelain')).toContain('locked')
  await worktrees.acquire(worktree.id, 'session-a')
  await worktrees.release(worktree.id, 'session-a')
  expect(worktrees.get(worktree.id).lease?.holder).toBe('session-a')
  expect(sh(repo, 'worktree', 'list', '--porcelain')).toContain('locked')
  await worktrees.release(worktree.id, 'session-a')
  expect(worktrees.get(worktree.id).lease).toBeNull()

  const registryFile = join(base, 'state', 'worktrees.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  registry.worktrees[0].lease = { holder: 'other', pid: 999_999_999, at: new Date().toISOString() }
  writeFileSync(registryFile, JSON.stringify(registry))
  // Opening the registry again releases it.
  expect(new Worktrees(join(base, 'state')).get(worktree.id).lease).toBeNull()
})

test('prune keeps the most recent managed worktrees and never a permanent or leased one', async () => {
  const { repo, worktrees } = fixture()
  const created: WorktreeRecord[] = []
  for (let index = 0; index < 4; index += 1) {
    created.push((await worktrees.create({ repo })).worktree)
    // The oldest one is in use by a live session.
    if (index === 0) await worktrees.acquire(created[0].id, 'live')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const permanent = (await worktrees.create({ repo, kind: 'permanent' })).worktree
  writeFileSync(join(created[1].path, 'work.txt'), 'unsaved\n')
  writeFileSync(join(created[2].path, '.env'), 'PRUNE=1\n')
  const result = await worktrees.prune({ keep: 1 })
  const removedIds = result.removed.map((entry) => entry.worktree.id).sort()
  expect(removedIds).toEqual([created[1].id, created[2].id].sort())
  expect(result.removed.find((entry) => entry.worktree.id === created[1].id)?.snapshot).toBeTruthy()
  expect(result.removed.find((entry) => entry.worktree.id === created[2].id)?.snapshot).toBeTruthy()
  const left = (await worktrees.list(repo)).map((record) => record.id).sort()
  expect(left).toEqual([created[0].id, created[3].id, permanent.id].sort())
  await worktrees.restore(created[2].id)
  expect(readFileSync(join(created[2].path, '.env'), 'utf8')).toBe('PRUNE=1\n')
})

test('handoff moves work between the worktree and the main checkout', async () => {
  const { repo, worktrees } = fixture()
  const { worktree } = await worktrees.create({ repo })
  writeFileSync(join(worktree.path, 'a.txt'), 'from worktree\n')
  writeFileSync(join(worktree.path, 'added.txt'), 'untracked\n')
  const toSource = await worktrees.handoff(worktree.id, 'toSource')
  expect(toSource.patched).toBe(true)
  expect(toSource.copied).toEqual(['added.txt'])
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('from worktree\n')
  expect(readFileSync(join(worktree.path, 'a.txt'), 'utf8')).toBe('one\n')
  expect(toSource.stash).toBeTruthy()

  // The main checkout now has changes, so handing more work to it is refused.
  writeFileSync(join(worktree.path, 'a.txt'), 'again\n')
  await expect(worktrees.handoff(worktree.id, 'toSource')).rejects.toMatchObject({ code: 'handoff_target_dirty' })

  sh(worktree.path, 'checkout', '--', 'a.txt')
  const toWorktree = await worktrees.handoff(worktree.id, 'toWorktree')
  expect(toWorktree.patched).toBe(true)
  expect(readFileSync(join(worktree.path, 'a.txt'), 'utf8')).toBe('from worktree\n')
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
})

test('adopts an existing linked worktree as permanent, and refuses the main checkout', async () => {
  const { base, repo, worktrees } = fixture()
  const outside = join(base, 'outside')
  sh(repo, 'worktree', 'add', '-q', '-b', 'old/thing', outside)
  const adopted = await worktrees.adopt(outside)
  expect(adopted).toMatchObject({ origin: 'adopted', kind: 'permanent', branch: 'old/thing', repoRoot: repo })
  expect((await worktrees.adopt(outside)).id).toBe(adopted.id)
  await expect(worktrees.adopt(repo)).rejects.toMatchObject({ code: 'not_a_worktree' })
  expect(await worktrees.repositoryOf(outside)).toBe(repo)
})

test('refuses a folder that is not a repository, and an empty repository', async () => {
  const { base, worktrees } = fixture()
  const plain = join(base, 'plain')
  mkdirSync(plain)
  await expect(worktrees.create({ repo: plain })).rejects.toMatchObject({ code: 'not_a_repository' })
  const empty = join(base, 'empty')
  mkdirSync(empty)
  sh(empty, 'init', '-q')
  await expect(worktrees.create({ repo: empty })).rejects.toMatchObject({ code: 'repository_empty' })
})
