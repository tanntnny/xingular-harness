import { accessSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveWorkspaceRoot } from './workspace'
import { createWorkspaceBashOperations } from './workspaceSandbox'

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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-workspace-sandbox-')))
  fixtures.push(base)
  const folder = join(base, 'workspace')
  mkdirSync(folder)
  return { base, root: resolveWorkspaceRoot(folder) }
}

describe('workspace Bash sandbox', () => {
  it.skipIf(!sandboxAvailable)('keeps workspace writes scoped and only runs an explicitly approved outside request once', async () => {
    const { base, root } = workspaceFixture()
    const outside = join(base, 'outside.txt')
    const partial = join(root, 'partial.txt')
    const output: Buffer[] = []
    const requests: unknown[] = []
    const operations = createWorkspaceBashOperations(root, {
      requestWorkspaceWriteScope: async (request) => {
        requests.push(request)
        return false
      }
    })

    const blocked = await operations.exec(`printf x >> '${partial}'; printf outside > '${outside}'`, root, {
      onData: (chunk) => output.push(chunk),
      timeout: 5
    })

    expect(blocked.exitCode).not.toBe(0)
    expect(readFileSync(partial, 'utf8')).toBe('x')
    expect(existsSync(outside)).toBe(false)
    expect(requests).toHaveLength(0)

    const spoofedOutput: Buffer[] = []
    const spoofed = await operations.exec(`printf 'Operation not permitted\\n'`, root, {
      onData: (chunk) => spoofedOutput.push(chunk),
      timeout: 5
    })
    expect(spoofed.exitCode).toBe(0)
    expect(Buffer.concat(spoofedOutput).toString()).toContain('Operation not permitted')
    expect(requests).toHaveLength(0)

    const readFile = join(base, 'readable.txt')
    writeFileSync(readFile, 'broad reads remain available')
    const readOutput: Buffer[] = []
    const read = await createWorkspaceBashOperations(root).exec(`cat '${readFile}'`, root, {
      onData: (chunk) => readOutput.push(chunk),
      timeout: 5
    })
    expect(read.exitCode).toBe(0)
    expect(Buffer.concat(readOutput).toString()).toContain('broad reads remain available')

    const deniedTarget = join(base, 'denied-outside.txt')
    await expect(createWorkspaceBashOperations(root, {
      workspaceWriteScope: () => 'outside',
      requestWorkspaceWriteScope: async (request) => {
        requests.push(request)
        return false
      }
    }).exec(`printf outside > '${deniedTarget}'`, root, { onData: () => {} })).rejects.toThrow('Bash was not run')
    expect(existsSync(deniedTarget)).toBe(false)
    expect(requests).toHaveLength(1)

    const approvedOutside = join(base, 'approved-outside.txt')
    const approvedSideEffect = join(root, 'approved-side-effect.txt')
    const approvedRequests: unknown[] = []
    const approved = await createWorkspaceBashOperations(root, {
      workspaceWriteScope: () => 'outside',
      requestWorkspaceWriteScope: async (request) => {
        approvedRequests.push(request)
        expect(existsSync(approvedOutside)).toBe(false)
        expect(existsSync(approvedSideEffect)).toBe(false)
        return true
      }
    }).exec(`printf x >> '${approvedSideEffect}'; printf outside > '${approvedOutside}'`, root, {
      onData: () => {},
      timeout: 5
    })
    expect(approved.exitCode).toBe(0)
    expect(readFileSync(approvedOutside, 'utf8')).toBe('outside')
    expect(readFileSync(approvedSideEffect, 'utf8')).toBe('x')
    expect(approvedRequests).toHaveLength(1)
  })

  it('blocks Bash when a workspace file has a hard-link alias outside the workspace', async () => {
    const { base, root } = workspaceFixture()
    const outside = join(base, 'outside-link-target.txt')
    const alias = join(root, 'alias.txt')
    writeFileSync(outside, 'unchanged')
    linkSync(outside, alias)

    await expect(createWorkspaceBashOperations(root).exec(`printf modified > '${alias}'`, root, { onData: () => {} }))
      .rejects.toThrow('hard-link alias outside the workspace')
    expect(readFileSync(outside, 'utf8')).toBe('unchanged')
  })

  it.skipIf(!sandboxAvailable)('prevents sandboxed Bash from creating a cross-boundary hard link', async () => {
    const { base, root } = workspaceFixture()
    const outside = join(base, 'outside-link-target.txt')
    const alias = join(root, 'alias.txt')
    writeFileSync(outside, 'unchanged')
    const requests: unknown[] = []

    const result = await createWorkspaceBashOperations(root, {
      requestWorkspaceWriteScope: async (request) => {
        requests.push(request)
        return true
      }
    }).exec(`ln '${outside}' '${alias}' && printf modified > '${alias}'`, root, {
      onData: () => {},
      timeout: 5
    })

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(alias)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('unchanged')
    expect(requests).toHaveLength(0)
  })

  it.skipIf(!sandboxAvailable || process.platform !== 'darwin')('blocks workspace-local hard-link creation in the macOS sandbox', async () => {
    const { root } = workspaceFixture()
    const source = join(root, 'source.txt')
    const alias = join(root, 'alias.txt')
    writeFileSync(source, 'workspace data')

    const result = await createWorkspaceBashOperations(root).exec(`ln '${source}' '${alias}'`, root, {
      onData: () => {},
      timeout: 5
    })

    expect(result.exitCode).not.toBe(0)
    expect(existsSync(alias)).toBe(false)
  })

  it.skipIf(!['darwin', 'linux'].includes(process.platform))('does not select a sandbox launcher from the command PATH', async () => {
    const { root } = workspaceFixture()
    const fakeBin = join(root, 'fake-bin')
    const marker = join(root, 'fake-launcher-ran')
    mkdirSync(fakeBin)
    const launcher = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap'
    writeFileSync(join(fakeBin, launcher), `#!/bin/sh\nprintf used > '${marker}'\nexit 0\n`, { mode: 0o755 })
    const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` }
    const operations = createWorkspaceBashOperations(root)

    if (sandboxAvailable) {
      const output: Buffer[] = []
      const result = await operations.exec('printf safe', root, {
        env,
        onData: (chunk) => output.push(chunk),
        timeout: 5
      })
      expect(result.exitCode).toBe(0)
      expect(Buffer.concat(output).toString()).toContain('safe')
    } else {
      await expect(operations.exec('printf unsafe', root, { env, onData: () => {} })).rejects.toThrow('sandbox unavailable')
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('uses explicit Full Permission before applying the workspace sandbox', async () => {
    const { base, root } = workspaceFixture()
    const target = join(base, 'full-permission.txt')
    const bypassRequests: unknown[] = []
    const escapeRequests: unknown[] = []
    const operations = createWorkspaceBashOperations(root, {
      platform: 'win32',
      bypassWorkspaceBoundary: async (request) => {
        bypassRequests.push(request)
        return true
      },
      requestWorkspaceWriteScope: async (request) => {
        escapeRequests.push(request)
        return false
      }
    })

    const result = await operations.exec(`printf outside > '${target}'`, root, { onData: () => {} })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('outside')
    expect(bypassRequests).toHaveLength(1)
    expect(escapeRequests).toHaveLength(0)
  })

  it.skipIf(!sandboxAvailable)('runs read-only Bash with reads, a discarded temp folder, and no writes or network', async () => {
    const { base, root } = workspaceFixture()
    writeFileSync(join(root, 'notes.txt'), 'readable')
    const target = join(root, 'created.txt')
    const outside = join(base, 'outside.txt')
    const callbacks: string[] = []
    const operations = createWorkspaceBashOperations(root, {
      workspaceWriteScope: () => 'read-only',
      bypassWorkspaceBoundary: async () => {
        callbacks.push('bypass')
        return true
      },
      requestWorkspaceWriteScope: async () => {
        callbacks.push('outside')
        return true
      }
    })
    const run = async (command: string) => {
      const output: Buffer[] = []
      const result = await operations.exec(command, root, { onData: (chunk) => output.push(chunk), timeout: 10 })
      return { exitCode: result.exitCode, text: Buffer.concat(output).toString() }
    }

    const read = await run(`cat notes.txt && ls`)
    expect(read.exitCode).toBe(0)
    expect(read.text).toContain('readable')

    for (const command of [`printf x > '${target}'`, `touch '${outside}'`, 'mkdir made', 'rm notes.txt', `ln -s notes.txt link`]) {
      expect((await run(command)).exitCode, command).not.toBe(0)
    }
    expect(existsSync(target)).toBe(false)
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(join(root, 'made'))).toBe(false)
    expect(existsSync(join(root, 'notes.txt'))).toBe(true)

    const temp = await run(`printf scratch > "$TMPDIR/x" && cat "$TMPDIR/x" && printf '\n%s' "$TMPDIR"`)
    expect(temp.exitCode).toBe(0)
    expect(temp.text).toContain('scratch')
    const tempRoot = temp.text.trim().split('\n').at(-1)!
    expect(existsSync(tempRoot)).toBe(false)

    const server = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      expect((await run(`exec 3<>/dev/tcp/127.0.0.1/${port}`)).exitCode).not.toBe(0)
    } finally {
      server.close()
    }
    expect(callbacks).toEqual([])
  })

  it('fails closed for read-only Bash without a sandbox and never asks to widen it', async () => {
    const { root } = workspaceFixture()
    const target = join(root, 'must-not-exist.txt')
    const callbacks: string[] = []
    const operations = createWorkspaceBashOperations(root, {
      platform: 'win32',
      workspaceWriteScope: () => 'read-only',
      bypassWorkspaceBoundary: async () => {
        callbacks.push('bypass')
        return true
      }
    })

    await expect(operations.exec(`printf unsafe > '${target}'`, root, { onData: () => {} })).rejects.toThrow('Read-only Bash sandbox unavailable')
    expect(existsSync(target)).toBe(false)
    expect(callbacks).toEqual([])
  })

  it('fails closed when the platform has no supported workspace sandbox', async () => {
    const { root } = workspaceFixture()
    const target = join(root, 'must-not-exist.txt')
    const operations = createWorkspaceBashOperations(root, { platform: 'win32' })

    await expect(operations.exec(`printf unsafe > '${target}'`, root, { onData: () => {} })).rejects.toThrow('Bash was not run')
    expect(existsSync(target)).toBe(false)
  })
})
