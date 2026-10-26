import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveWorkspaceRoot, resolveWorkspaceWritePath, resolveWritePath, verifyWorkspaceRoot } from './workspace'

const fixtures: string[] = []

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'harness-workspace-'))
  fixtures.push(path)
  return path
}

describe('workspace path resolution', () => {
  it('chooses the nearest Git ancestor for a nested repository cwd', () => {
    const base = temporaryDirectory()
    const outer = join(base, 'outer')
    const repository = join(outer, 'nested-repository')
    const cwd = join(repository, 'packages', 'service')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(repository, '.git'), { recursive: true })
    mkdirSync(cwd, { recursive: true })

    expect(resolveWorkspaceRoot(cwd)).toBe(realpathSync(repository))
  })

  it('rejects the filesystem root as an active workspace', () => {
    const root = realpathSync(parse(realpathSync(process.cwd())).root)

    expect(() => resolveWorkspaceRoot(root)).toThrow('filesystem root')
    expect(() => verifyWorkspaceRoot(root)).toThrow('filesystem root')
  })

  it('falls back to the canonical cwd when no Git marker exists', () => {
    const base = temporaryDirectory()
    const cwd = join(base, 'project', 'nested')
    mkdirSync(cwd, { recursive: true })

    expect(resolveWorkspaceRoot(cwd)).toBe(realpathSync(cwd))
  })

  it('recognizes a linked worktree .git file as the workspace marker', () => {
    const base = temporaryDirectory()
    const commonGit = join(base, 'main', '.git')
    const worktree = join(base, 'linked-worktree')
    const cwd = join(worktree, 'src', 'feature')
    const worktreeGit = join(commonGit, 'worktrees', 'linked-worktree')
    mkdirSync(worktreeGit, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGit}\n`)

    expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true)
    expect(resolveWorkspaceRoot(cwd)).toBe(realpathSync(worktree))
  })

  it('resolves existing relative and absolute targets inside the root', () => {
    const root = temporaryDirectory()
    const target = join(root, 'src', 'index.ts')
    mkdirSync(join(root, 'src'))
    writeFileSync(target, 'export {}\n')

    expect(resolveWorkspaceWritePath(root, 'src/index.ts')).toBe(realpathSync(target))
    expect(resolveWorkspaceWritePath(root, 'index.ts', join(root, 'src'))).toBe(realpathSync(target))
    expect(resolveWorkspaceWritePath(root, target)).toBe(realpathSync(target))
  })

  it('rejects absolute and relative targets outside the root', () => {
    const base = temporaryDirectory()
    const root = join(base, 'project')
    const outside = join(base, 'outside.txt')
    mkdirSync(root)
    writeFileSync(outside, 'outside\n')

    expect(() => resolveWorkspaceWritePath(root, outside)).toThrow('outside the active project workspace')
    expect(() => resolveWorkspaceWritePath(root, '../../outside.txt')).toThrow('outside the active project workspace')
  })

  it('resolves a nested output path that does not exist yet', () => {
    const root = temporaryDirectory()
    const target = join(root, 'artifacts', 'drafts', 'result.md')

    const canonicalTarget = join(realpathSync(root), 'artifacts', 'drafts', 'result.md')
    expect(resolveWorkspaceWritePath(root, 'artifacts/drafts/result.md')).toBe(canonicalTarget)
    expect(() => lstatSync(target)).toThrow()
  })

  it('expands home-relative paths before checking their workspace scope', () => {
    const root = temporaryDirectory()

    expect(resolveWritePath('~/outside.txt')).toBe(join(realpathSync(homedir()), 'outside.txt'))
    expect(() => resolveWorkspaceWritePath(root, '~/outside.txt')).toThrow('outside the active project workspace')
  })

  it.skipIf(process.platform === 'win32')('rejects symlink escapes for existing and future targets', () => {
    const base = temporaryDirectory()
    const root = join(base, 'project')
    const outside = join(base, 'outside')
    const link = join(root, 'external')
    const alias = join(base, 'project-alias')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'existing.txt'), 'outside\n')
    symlinkSync(outside, link, 'dir')
    symlinkSync(root, alias, 'dir')

    expect(resolveWorkspaceRoot(alias)).toBe(realpathSync(root))
    expect(() => resolveWorkspaceWritePath(root, join(link, 'existing.txt'))).toThrow('outside the active project workspace')
    expect(() => resolveWorkspaceWritePath(root, join(link, 'future', 'result.txt'))).toThrow('outside the active project workspace')
  })
})
