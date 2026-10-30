import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, realpathSync, statSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { isWithinWorkspace, resolveWritePath, verifyWorkspaceRoot } from './workspace'
import { workspaceSandboxCommand } from './workspaceSandbox'

export interface WorkspaceWriteAuthorization {
  workspaceRoot: string
  cwd: string
  path: string
  outside: boolean
  authorized: boolean
  expectedContentHash?: string
  signal?: AbortSignal
}

const writeAuthorization = new AsyncLocalStorage<WorkspaceWriteAuthorization>()

const atomicWriteScript = `
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const target = input.path
const parent = path.dirname(target)
fs.mkdirSync(parent, { recursive: true })
let mode = 0o666
let preserveMode = false
try {
  const existing = fs.lstatSync(target)
  if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('The write target is not a regular file.')
  fs.accessSync(target, fs.constants.W_OK)
  if (input.expectedContentHash) {
    const current = fs.readFileSync(target)
    if (crypto.createHash('sha256').update(current).digest('hex') !== input.expectedContentHash) {
      throw new Error('The file changed after the edit tool read it; retry against the current contents.')
    }
  }
  mode = existing.mode & 0o7777
  preserveMode = true
} catch (error) {
  if (error && error.code !== 'ENOENT') throw error
}
const temporary = path.join(parent, '.' + path.basename(target) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp')
let descriptor
try {
  descriptor = fs.openSync(temporary, 'wx', mode)
  fs.writeFileSync(descriptor, input.content, 'utf8')
  if (preserveMode) fs.fchmodSync(descriptor, mode)
  fs.fsyncSync(descriptor)
  fs.closeSync(descriptor)
  descriptor = undefined
  fs.renameSync(temporary, target)
  try {
    const directory = fs.openSync(parent, 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } catch {}
} catch (error) {
  if (descriptor !== undefined) fs.closeSync(descriptor)
  try { fs.unlinkSync(temporary) } catch {}
  throw error
}
`

export interface AtomicWriteLaunch {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * How the atomic write helper starts. macOS and Linux run it inside the write-boundary sandbox.
 * Windows has none, so Node runs the helper directly; the target was still canonicalized and
 * authorized, and the rename replaces the directory entry rather than writing through an alias.
 */
export function atomicWriteLaunch(platform: NodeJS.Platform, root: string, additionalRoots: readonly string[]): AtomicWriteLaunch {
  if (platform === 'win32') {
    // Node needs SystemRoot to start on Windows; keep only what the helper requires.
    const env: NodeJS.ProcessEnv = {}
    for (const name of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    return { executable: process.execPath, args: ['-e', atomicWriteScript], env }
  }
  const command = `exec ${shellQuote(process.execPath)} -e ${shellQuote(atomicWriteScript)}`
  const spec = workspaceSandboxCommand(platform, root, root, command, additionalRoots)
  return {
    executable: spec.executable,
    args: spec.args,
    env: { PATH: '/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function nearestExistingDirectory(path: string): string {
  let current = dirname(path)
  while (true) {
    try {
      const canonical = realpathSync(current)
      if (!statSync(canonical).isDirectory()) throw new Error(`Write scope is not a directory: ${canonical}`)
      return canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`Could not find a writable parent for ${path}.`)
      current = parent
    }
  }
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

async function runAtomicWrite(authorization: WorkspaceWriteAuthorization, path: string, content: string): Promise<void> {
  const root = verifyWorkspaceRoot(authorization.workspaceRoot)
  const canonicalPath = resolveWritePath(path, authorization.cwd)
  if (canonicalPath !== authorization.path) throw new Error('The write target changed after workspace approval; the write was blocked.')
  const outside = !isWithinWorkspace(root, canonicalPath)
  if (outside !== authorization.outside || (outside && !authorization.authorized)) {
    throw new Error('The write authorization no longer matches the active workspace target.')
  }

  const additionalRoots = outside ? [nearestExistingDirectory(canonicalPath)] : []
  const launch = atomicWriteLaunch(process.platform, root, additionalRoots)

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: root,
      detached: process.platform !== 'win32',
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const output: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const timeout = setTimeout(() => {
      killProcess(child)
      finish(new Error('Workspace-contained atomic write timed out.'))
    }, 30_000)

    const capture = (chunk: Buffer): void => {
      if (outputBytes >= 8_192) return
      const remaining = 8_192 - outputBytes
      output.push(chunk.subarray(0, remaining))
      outputBytes += Math.min(chunk.length, remaining)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      authorization.signal?.removeEventListener('abort', abort)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const abort = (): void => {
      killProcess(child)
      finish(new Error('Workspace-contained atomic write was aborted.'))
    }

    authorization.signal?.addEventListener('abort', abort, { once: true })
    if (authorization.signal?.aborted) {
      abort()
      return
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) {
        finish()
        return
      }
      const detail = Buffer.concat(output).toString('utf8').trim()
      finish(new Error(`Workspace-contained atomic write failed${detail ? `: ${detail.slice(-2000)}` : ` with exit code ${code ?? 'unknown'}`}.`))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify({
      path: canonicalPath,
      content,
      ...(authorization.expectedContentHash ? { expectedContentHash: authorization.expectedContentHash } : {})
    }))
  })
}

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  const authorization = writeAuthorization.getStore()
  if (!authorization?.authorized) throw new Error('The file write has no current workspace authorization.')
  await runAtomicWrite(authorization, path, content)
}

export const workspaceWriteOperations = {
  mkdir: async (_directory: string): Promise<void> => {},
  writeFile: writeWorkspaceFile
}

export const workspaceEditOperations = {
  access: async (path: string): Promise<void> => access(path, fsConstants.R_OK | fsConstants.W_OK),
  readFile: async (path: string): Promise<Buffer> => {
    const content = await readFile(path)
    const authorization = writeAuthorization.getStore()
    if (authorization && resolve(path) === authorization.path) {
      authorization.expectedContentHash = createHash('sha256').update(content).digest('hex')
    }
    return content
  },
  writeFile: writeWorkspaceFile
}

/** Binds one policy-approved path and abort signal to Pi's native write/edit operation. */
export function withWorkspaceWriteAuthorization<T>(tool: T, authorizations: Map<string, WorkspaceWriteAuthorization>): T {
  const native = tool as unknown as { execute: (...args: unknown[]) => unknown }
  const execute = native.execute.bind(tool)
  return {
    ...tool as object,
    execute: (...args: unknown[]) => {
      const toolCallId = String(args[0] ?? '')
      const authorization = authorizations.get(toolCallId)
      authorizations.delete(toolCallId)
      if (!authorization?.authorized) throw new Error('The file write has no current workspace authorization.')
      const signal = args[2]
      if (signal && typeof signal === 'object' && 'aborted' in signal) authorization.signal = signal as AbortSignal
      return writeAuthorization.run(authorization, () => execute(...args))
    }
  } as T
}

interface PromptMetadata {
  promptSnippet?: string
  promptGuidelines?: string[]
}

/** The part of Pi's tool factories the workspace file tools use. Structural, so this module needs no Pi import. */
export interface FileToolFactories<W, E> {
  createWriteTool(cwd: string, options: { operations: typeof workspaceWriteOperations }): W
  createWriteToolDefinition(cwd: string, options: { operations: typeof workspaceWriteOperations }): PromptMetadata
  createEditTool(cwd: string, options: { operations: typeof workspaceEditOperations }): E
  createEditToolDefinition(cwd: string, options: { operations: typeof workspaceEditOperations }): PromptMetadata
}

/**
 * Pi's `createWriteTool` and `createEditTool` drop the definition's prompt line and guidelines, and Pi
 * lists only tools with a prompt line in the system prompt. Without them the model is told it has
 * only `read` and `bash`, and edits files through shell scripts. Pi's `createBashTool` restores them
 * the same way.
 */
function withPromptMetadata<T>(tool: T, definition: PromptMetadata): T {
  return Object.assign(tool as object, {
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines
  }) as T
}

/** Pi's native `write` and `edit`, routed through the workspace operations and per-call authorization. */
export function createWorkspaceFileTools<W, E>(pi: FileToolFactories<W, E>, cwd: string, authorizations: Map<string, WorkspaceWriteAuthorization>): { write: W; edit: E } {
  const writeOptions = { operations: workspaceWriteOperations }
  const editOptions = { operations: workspaceEditOperations }
  return {
    write: withWorkspaceWriteAuthorization(withPromptMetadata(pi.createWriteTool(cwd, writeOptions), pi.createWriteToolDefinition(cwd, writeOptions)), authorizations),
    edit: withWorkspaceWriteAuthorization(withPromptMetadata(pi.createEditTool(cwd, editOptions), pi.createEditToolDefinition(cwd, editOptions)), authorizations)
  }
}
