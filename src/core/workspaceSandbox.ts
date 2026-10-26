import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdtempSync, realpathSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BashOperations } from '@earendil-works/pi-coding-agent'

import { isWithinWorkspace, verifyWorkspaceRoot } from './workspace'

const MARKER_PREFIX = '__XINGULAR_WORKSPACE_SANDBOX_STARTED_'
const bashWriteScope = new AsyncLocalStorage<WorkspaceWriteScope>()

/** `read-only` (plan mode) permits no workspace writes, no network and no outside processes. */
export type WorkspaceWriteScope = 'workspace' | 'outside' | 'read-only'

export function runWithWorkspaceWriteScope<T>(scope: WorkspaceWriteScope, action: () => T): T {
  return bashWriteScope.run(scope, action)
}

export interface WorkspaceWriteScopeRequest {
  command: string
  cwd: string
  workspaceRoot: string
  reason: string
}

export interface WorkspaceBoundaryBypassRequest {
  command: string
  cwd: string
  workspaceRoot: string
}

export interface WorkspaceBashOptions {
  /** The explicit Full Permission switch can bypass the workspace boundary before the command runs. */
  bypassWorkspaceBoundary?: (request: WorkspaceBoundaryBypassRequest) => Promise<boolean>
  requestWorkspaceWriteScope?: (request: WorkspaceWriteScopeRequest) => Promise<boolean>
  /** Overrides the per-call scope; `undefined` falls back to it. */
  workspaceWriteScope?: () => WorkspaceWriteScope | undefined
  /** Exposed for platform-specific tests; production uses the current operating system. */
  platform?: NodeJS.Platform
}

export interface WorkspaceSandboxCommand {
  executable: string
  args: string[]
  marker: string
}

interface ProcessResult {
  exitCode: number | null
}

function systemExecutable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Keep looking only at known system locations.
    }
  }
  return null
}

function shellPath(): string {
  const shell = ['/bin/bash', '/usr/bin/bash'].find((candidate) => existsSync(candidate))
  if (!shell) throw new Error('The workspace write-boundary sandbox requires Bash, but no Bash executable was found.')
  return shell
}

function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
}

// Read-only commands need no mach services; denying them all keeps a command from acting through
// system daemons (preferences, Apple Events, Launch Services), which the file rules do not cover.
function macReadOnlyProfile(tempRoot: string): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${sbplString(tempRoot)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
    '(deny file-link)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)'
  ].join('')
}

function macSandboxProfile(writeRoots: readonly string[]): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow file-read*)',
    ...writeRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
    '(deny file-link)',
    '(allow process*)',
    '(allow network*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)'
  ].join('')
}

export function workspaceSandboxCommand(
  platform: NodeJS.Platform,
  workspaceRoot: string,
  cwd: string,
  command: string,
  additionalWriteRoots: readonly string[] = [],
  readOnlyTempRoot: string | null = null
): WorkspaceSandboxCommand {
  const shell = shellPath()
  const marker = `${MARKER_PREFIX}${randomUUID()}__`
  const wrappedCommand = `printf '%s\\n' '${marker}'\n${command}`
  if (readOnlyTempRoot !== null) return readOnlySandboxCommand(platform, realpathSync(readOnlyTempRoot), cwd, shell, wrappedCommand, marker)
  const writeRoots = [...new Set([workspaceRoot, ...additionalWriteRoots].map((root) => realpathSync(root)))].sort((left, right) => left.length - right.length)

  if (platform === 'darwin') {
    const executable = systemExecutable(['/usr/bin/sandbox-exec'])
    if (!executable) throw new Error('Workspace write-boundary sandbox unavailable: sandbox-exec was not found. Bash was not run.')
    return { executable, args: ['-p', macSandboxProfile(writeRoots), shell, '-c', wrappedCommand], marker }
  }

  if (platform === 'linux') {
    const executable = systemExecutable(['/usr/bin/bwrap', '/bin/bwrap'])
    if (!executable) throw new Error('Workspace write-boundary sandbox unavailable: install bubblewrap (bwrap). Bash was not run.')
    return {
      executable,
      marker,
      args: [
        '--die-with-parent', '--new-session', '--unshare-pid',
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        ...writeRoots.flatMap((root) => ['--bind', root, root]),
        '--chdir', cwd,
        shell, '-c', wrappedCommand
      ]
    }
  }

  throw new Error(`Workspace write-boundary sandbox unavailable on ${platform}. Bash was not run.`)
}

function readOnlySandboxCommand(platform: NodeJS.Platform, tempRoot: string, cwd: string, shell: string, wrappedCommand: string, marker: string): WorkspaceSandboxCommand {
  if (platform === 'darwin') {
    const executable = systemExecutable(['/usr/bin/sandbox-exec'])
    if (!executable) throw new Error('Read-only Bash sandbox unavailable: sandbox-exec was not found. Bash was not run.')
    return { executable, args: ['-p', macReadOnlyProfile(tempRoot), shell, '-c', wrappedCommand], marker }
  }

  if (platform === 'linux') {
    const executable = systemExecutable(['/usr/bin/bwrap', '/bin/bwrap'])
    if (!executable) throw new Error('Read-only Bash sandbox unavailable: install bubblewrap (bwrap). Bash was not run.')
    return {
      executable,
      marker,
      args: [
        '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--unshare-ipc',
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        // No session bus or other host sockets under /run.
        '--tmpfs', '/run',
        '--bind', tempRoot, tempRoot,
        '--chdir', cwd,
        shell, '-c', wrappedCommand
      ]
    }
  }

  throw new Error(`Read-only Bash sandbox unavailable on ${platform}. Bash was not run.`)
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to the direct child if it has already left its process group.
    }
  }
  child.kill('SIGKILL')
}

function runProcess(
  spec: WorkspaceSandboxCommand,
  cwd: string,
  options: Parameters<BashOperations['exec']>[2],
  marker: string | null
): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new Error('aborted'))

  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd,
      detached: process.platform !== 'win32',
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let pending = ''
    let started = marker === null
    let timedOut = false
    let settled = false
    let timeoutHandle: NodeJS.Timeout | undefined

    const deliver = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (!started && marker) {
        pending += text
        const markerAt = pending.indexOf(marker)
        if (markerAt === -1) {
          // Preserve only a short prefix in case the shell emitted a startup warning.
          if (pending.length > marker.length + 2048) {
            options.onData(Buffer.from(pending.slice(0, pending.length - marker.length - 2048)))
            pending = pending.slice(-(marker.length + 2048))
          }
          return
        }
        const before = pending.slice(0, markerAt)
        const after = pending.slice(markerAt + marker.length).replace(/^\r?\n/u, '')
        if (before) options.onData(Buffer.from(before))
        if (after) options.onData(Buffer.from(after))
        pending = ''
        started = true
        return
      }
      options.onData(chunk)
    }

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
      if (!started && pending) options.onData(Buffer.from(pending))
      if (options.signal?.aborted) reject(new Error('aborted'))
      else if (timedOut) reject(new Error(`timeout:${options.timeout}`))
      else resolve({ exitCode: code })
    }

    const onAbort = (): void => killProcess(child)
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        killProcess(child)
      }, options.timeout * 1000)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', deliver)
    child.stderr?.on('data', deliver)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', finish)
  })
}

function assertNoExternalHardlinks(workspaceRoot: string): void {
  const inodes = new Map<string, { internalLinks: number; totalLinks: number; samplePath: string }>()

  const visit = (directory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(`Workspace hard-link inspection failed at ${directory}; Bash was not run: ${error instanceof Error ? error.message : String(error)}`)
    }

    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      let stats: ReturnType<typeof lstatSync>
      try {
        stats = lstatSync(path)
      } catch (error) {
        throw new Error(`Workspace hard-link inspection failed at ${path}; Bash was not run: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        visit(path)
        continue
      }
      if (!stats.isFile()) continue

      const key = `${stats.dev}:${stats.ino}`
      const inode = inodes.get(key)
      if (inode) inode.internalLinks += 1
      else inodes.set(key, { internalLinks: 1, totalLinks: stats.nlink, samplePath: path })
    }
  }

  visit(workspaceRoot)
  for (const inode of inodes.values()) {
    if (inode.totalLinks > inode.internalLinks) {
      throw new Error(`Workspace write-boundary sandbox cannot safely run Bash because ${inode.samplePath} has a hard-link alias outside the workspace; remove the alias or replace the file with a copy.`)
    }
  }
}

export function createWorkspaceBashOperations(
  workspaceRoot: string | (() => string | null),
  options: WorkspaceBashOptions = {}
): BashOperations {
  return {
    async exec(command, cwd, execOptions) {
      const rootValue = typeof workspaceRoot === 'function' ? workspaceRoot() : workspaceRoot
      if (!rootValue) throw new Error('The active project workspace is not available. Bash was not run.')
      const root = verifyWorkspaceRoot(rootValue)
      const canonicalCwd = realpathSync(cwd)
      if (!isWithinWorkspace(root, canonicalCwd)) throw new Error('The Bash working directory is outside the active project workspace.')

      const scope = options.workspaceWriteScope?.() ?? bashWriteScope.getStore() ?? 'workspace'
      // Nothing widens a read-only scope: no Full Permission bypass, no outside request.
      if (scope === 'read-only') {
        const platform = options.platform ?? process.platform
        const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'harness-read-only-bash-')))
        try {
          const spec = workspaceSandboxCommand(platform, root, canonicalCwd, command, [], tempRoot)
          const env = { ...(execOptions.env ?? process.env), TMPDIR: tempRoot }
          const result = await runProcess(spec, canonicalCwd, { ...execOptions, env }, spec.marker)
          return { exitCode: result.exitCode }
        } finally {
          rmSync(tempRoot, { recursive: true, force: true })
        }
      }

      let bypass = false
      try {
        bypass = await options.bypassWorkspaceBoundary?.({ command, cwd: canonicalCwd, workspaceRoot: root }) ?? false
      } catch {
        bypass = false
      }
      if (bypass) {
        const result = await runProcess({ executable: shellPath(), args: ['-c', command], marker: '' }, canonicalCwd, execOptions, null)
        return { exitCode: result.exitCode }
      }

      if (scope === 'outside') {
        const reason = 'This command requests filesystem writes outside the active project workspace. It will not run until this one-call request is approved.'
        let approved = false
        try {
          approved = await options.requestWorkspaceWriteScope?.({ command, cwd: canonicalCwd, workspaceRoot: root, reason }) ?? false
        } catch {
          approved = false
        }
        if (!approved) throw new Error(`${reason} Bash was not run.`)
        execOptions.onData(Buffer.from('\n[Outside-workspace writes approved for this command; running once.]\n'))
        const result = await runProcess({ executable: shellPath(), args: ['-c', command], marker: '' }, canonicalCwd, execOptions, null)
        return { exitCode: result.exitCode }
      }

      assertNoExternalHardlinks(root)
      const platform = options.platform ?? process.platform
      const spec = workspaceSandboxCommand(platform, root, canonicalCwd, command)
      const result = await runProcess(spec, canonicalCwd, execOptions, spec.marker)
      return { exitCode: result.exitCode }
    }
  }
}
