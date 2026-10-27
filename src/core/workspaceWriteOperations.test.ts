import { accessSync, chmodSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEditTool, createWriteTool } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveWritePath, resolveWorkspaceRoot } from './workspace'
import { atomicWriteLaunch, withWorkspaceWriteAuthorization, workspaceEditOperations, workspaceWriteOperations, type WorkspaceWriteAuthorization } from './workspaceWriteOperations'

const fixtures: string[] = []
const sandboxExecutables = process.platform === 'darwin'
  ? ['/usr/bin/sandbox-exec']
  : process.platform === 'linux'
    ? ['/usr/bin/bwrap', '/bin/bwrap']
    : []
const sandboxAvailable = sandboxExecutables.some((candidate) => {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
})

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

function workspaceFixture(): { base: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-workspace-write-')))
  fixtures.push(base)
  const folder = join(base, 'workspace')
  mkdirSync(folder)
  return { base, root: resolveWorkspaceRoot(folder) }
}

function authorized(root: string, cwd: string, path: string, outside = false): WorkspaceWriteAuthorization {
  return { workspaceRoot: root, cwd, path, outside, authorized: true }
}

async function execute(tool: unknown, toolCallId: string, input: unknown, cwd: string): Promise<unknown> {
  const native = tool as { execute: (id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown) => Promise<unknown> }
  return native.execute(toolCallId, input, undefined, undefined, { cwd })
}

describe('workspace-contained native write operations', () => {
  it('replaces an in-workspace hard link without changing its outside alias', async () => {
    if (!sandboxAvailable) return
    const { base, root } = workspaceFixture()
    const outside = join(base, 'outside.txt')
    const target = join(root, 'alias.txt')
    writeFileSync(outside, 'outside original')
    linkSync(outside, target)
    const authorizations = new Map([['write-hardlink', authorized(root, root, target)]])
    const tool = withWorkspaceWriteAuthorization(createWriteTool(root, { operations: workspaceWriteOperations }), authorizations)

    await execute(tool, 'write-hardlink', { path: target, content: 'workspace replacement' }, root)

    expect(readFileSync(target, 'utf8')).toBe('workspace replacement')
    expect(readFileSync(outside, 'utf8')).toBe('outside original')
    expect(statSync(target).ino).not.toBe(statSync(outside).ino)
  })

  it('revalidates the canonical target after a parent directory is replaced by a symlink', async () => {
    if (!sandboxAvailable) return
    const { base, root } = workspaceFixture()
    const parent = join(root, 'parent')
    const target = join(parent, 'target.txt')
    const outsideDirectory = join(base, 'outside')
    const outside = join(outsideDirectory, 'target.txt')
    mkdirSync(parent)
    mkdirSync(outsideDirectory)
    writeFileSync(target, 'workspace original')
    writeFileSync(outside, 'outside original')
    const authorizations = new Map([['write-swap', authorized(root, root, target)]])
    const tool = withWorkspaceWriteAuthorization(createWriteTool(root, { operations: workspaceWriteOperations }), authorizations)

    rmSync(parent, { recursive: true })
    symlinkSync(outsideDirectory, parent, 'dir')
    await expect(execute(tool, 'write-swap', { path: target, content: 'must not escape' }, root)).rejects.toThrow('target changed')
    expect(readFileSync(outside, 'utf8')).toBe('outside original')
  })

  it('preserves the existing file mode during atomic replacement', async () => {
    if (!sandboxAvailable) return
    const { root } = workspaceFixture()
    const target = join(root, 'mode.txt')
    writeFileSync(target, 'old', { mode: 0o640 })
    chmodSync(target, 0o640)
    const authorizations = new Map([['write-mode', authorized(root, root, target)]])
    const tool = withWorkspaceWriteAuthorization(createWriteTool(root, { operations: workspaceWriteOperations }), authorizations)

    await execute(tool, 'write-mode', { path: target, content: 'new' }, root)

    expect(statSync(target).mode & 0o777).toBe(0o640)
  })

  it('allows an explicitly authorized outside target only through the scoped helper', async () => {
    if (!sandboxAvailable) return
    const { base, root } = workspaceFixture()
    const target = join(base, 'approved.txt')
    const authorizations = new Map([['write-outside', authorized(root, root, target, true)]])
    const tool = withWorkspaceWriteAuthorization(createWriteTool(root, { operations: workspaceWriteOperations }), authorizations)

    await execute(tool, 'write-outside', { path: target, content: 'approved' }, root)

    expect(readFileSync(target, 'utf8')).toBe('approved')
  })

  it('blocks edit writeback when the source changes after the edit read', async () => {
    if (!sandboxAvailable) return
    const { root } = workspaceFixture()
    const target = join(root, 'edit.txt')
    writeFileSync(target, 'original text')
    const authorizations = new Map([['edit-race', authorized(root, root, target)]])
    const operations = {
      ...workspaceEditOperations,
      readFile: async (path: string) => {
        const original = await workspaceEditOperations.readFile(path)
        writeFileSync(path, 'concurrent change')
        return original
      }
    }
    const tool = withWorkspaceWriteAuthorization(createEditTool(root, { operations }), authorizations)

    await expect(execute(tool, 'edit-race', { path: target, edits: [{ oldText: 'original', newText: 'replacement' }] }, root))
      .rejects.toThrow('file changed after the edit tool read it')
    expect(readFileSync(target, 'utf8')).toBe('concurrent change')
  })

  it('rejects a native file mutation without its policy authorization', async () => {
    const { root } = workspaceFixture()
    const target = join(root, 'blocked.txt')
    const authorizations = new Map([['write-blocked', { ...authorized(root, root, target), authorized: false }]])
    const tool = withWorkspaceWriteAuthorization(createWriteTool(root, { operations: workspaceWriteOperations }), authorizations)

    await expect(execute(tool, 'write-blocked', { path: target, content: 'blocked' }, root)).rejects.toThrow('no current workspace authorization')
    expect(existsSync(target)).toBe(false)
  })

  it('resolves the authorization against the canonical write target', () => {
    const { root } = workspaceFixture()
    const target = join(root, 'target.txt')
    expect(resolveWritePath(target, root)).toBe(target)
  })
})

describe('atomic write helper on Windows', () => {
  it('starts Node directly, without a shell or sandbox, and still replaces the file atomically', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-windows-write-')))
    try {
      const target = join(base, 'nested', 'file.txt')
      const launch = atomicWriteLaunch('win32', base, [])
      expect(launch.executable).toBe(process.execPath)
      expect(launch.args[0]).toBe('-e')
      expect(launch.env.PATH).toBeUndefined()

      const result = spawnSync(launch.executable, launch.args, { input: JSON.stringify({ path: target, content: 'written' }), env: { ...launch.env, PATH: process.env.PATH } })
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(readFileSync(target, 'utf8')).toBe('written')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
