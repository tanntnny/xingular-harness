import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { git, gitText } from './git'
import { snapshotWorkingTree } from './snapshot'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function repo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'harness-snapshot-'))
  roots.push(root)
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  writeFileSync(join(root, 'tracked.txt'), 'one\n')
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  await git(root, ['add', '.'])
  await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  return root
}

test('captures tracked edits and untracked files without touching the tree, the index or HEAD', async () => {
  const root = await repo()
  writeFileSync(join(root, 'tracked.txt'), 'two\n')
  writeFileSync(join(root, 'new.txt'), 'fresh\n')
  writeFileSync(join(root, 'ignored.txt'), 'secret\n')
  mkdirSync(join(root, 'dir'))
  writeFileSync(join(root, 'dir', 'staged.txt'), 'staged\n')
  await git(root, ['add', 'dir/staged.txt'])
  const before = { status: await gitText(root, ['status', '--porcelain']), head: await gitText(root, ['rev-parse', 'HEAD']), index: readFileSync(join(root, '.git', 'index')) }

  const snapshot = await snapshotWorkingTree(join(root, 'dir'))
  expect(snapshot).toMatchObject({ kind: 'git-snapshot' })
  expect(await gitText(root, ['show', `${snapshot!.commit}:tracked.txt`])).toBe('two')
  expect(await gitText(root, ['show', `${snapshot!.commit}:new.txt`])).toBe('fresh')
  expect(await gitText(root, ['show', `${snapshot!.commit}:dir/staged.txt`])).toBe('staged')
  expect((await git(root, ['cat-file', '-e', `${snapshot!.commit}:ignored.txt`], { allowFail: true })).code).not.toBe(0)
  expect(await gitText(root, ['rev-parse', `${snapshot!.commit}^`])).toBe(before.head)

  expect(await gitText(root, ['status', '--porcelain'])).toBe(before.status)
  expect(await gitText(root, ['rev-parse', 'HEAD'])).toBe(before.head)
  expect(readFileSync(join(root, '.git', 'index')).equals(before.index)).toBe(true)
  expect(await gitText(root, ['stash', 'list'])).toBe('')
})

test('returns null outside a repository and on timeout', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'harness-plain-'))
  roots.push(plain)
  expect(await snapshotWorkingTree(plain)).toBeNull()
  const root = await repo()
  expect(await snapshotWorkingTree(root, { timeoutMs: 1 })).toBeNull()
})

test('a refinement replay starts from the snapshot in a clone that leaves the repository alone', async () => {
  const { prepareSnapshotWorkspace } = await import('../refine/host')
  const root = await repo()
  writeFileSync(join(root, 'tracked.txt'), 'two\n')
  writeFileSync(join(root, 'new.txt'), 'fresh\n')
  rmSync(join(root, '.gitignore'))
  const snapshot = (await snapshotWorkingTree(root))!
  // The person keeps working after the turn; the replay must not see it.
  writeFileSync(join(root, 'tracked.txt'), 'three\n')
  const worktrees = await gitText(root, ['worktree', 'list'])
  const refs = await gitText(root, ['for-each-ref'])

  const workspace = await prepareSnapshotWorkspace(snapshot)
  expect(readFileSync(join(workspace.cwd, 'tracked.txt'), 'utf8')).toBe('two\n')
  expect(readFileSync(join(workspace.cwd, 'new.txt'), 'utf8')).toBe('fresh\n')
  const status = await gitText(workspace.cwd, ['status', '--porcelain'])
  expect(status).toContain(' M tracked.txt')
  expect(status).toMatch(/(^|\n) ?D .gitignore/)
  expect(status).toContain('?? new.txt')
  expect(await gitText(root, ['worktree', 'list'])).toBe(worktrees)
  expect(await gitText(root, ['for-each-ref'])).toBe(refs)
  await workspace.cleanup!()
  expect(existsSync(workspace.cwd)).toBe(false)
})

test('sees a same-size edit made in the same second as the last index write', async () => {
  const root = await repo()
  for (let attempt = 0; attempt < 25; attempt++) {
    writeFileSync(join(root, 'tracked.txt'), `v${attempt}\n`)
    await git(root, ['add', 'tracked.txt'])
    writeFileSync(join(root, 'tracked.txt'), `w${attempt}\n`)
    const snapshot = await snapshotWorkingTree(root, { timeoutMs: 10_000 })
    expect(await gitText(root, ['show', `${snapshot!.commit}:tracked.txt`])).toBe(`w${attempt}`)
  }
})

test('leaves out untracked files over the size bound and says how many', async () => {
  const root = await repo()
  writeFileSync(join(root, 'small.txt'), 'kept\n')
  writeFileSync(join(root, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024, 1))
  const snapshot = await snapshotWorkingTree(root, { timeoutMs: 10_000 })
  expect(snapshot?.omitted).toBe(1)
  expect(await gitText(root, ['show', `${snapshot!.commit}:small.txt`])).toBe('kept')
  expect((await git(root, ['cat-file', '-e', `${snapshot!.commit}:huge.bin`], { allowFail: true })).code).not.toBe(0)
})
