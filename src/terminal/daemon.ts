// The long-lived harness for one data root and state folder (ADR-0083, phase 3). `xagent --daemon`
// starts it when it is not running and prepares its terminal there, so a reply keeps running when the
// window closes; `xagent attach` reconnects a window to it. It serves the server protocol on a
// socket in the state folder that only this user can open, and one lock keeps it the only harness
// writing for that state folder.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { log, setLogSink } from '../core/bus'
import { HarnessError } from '../core/errors'
import type { InteractiveProfile } from '../core/interactiveProfile'
import { connectHarness, serveSocket, type HarnessClient } from '../server/socket'
import { REMOTE_CONTROL_ENV } from './client'
import { HARNESS_RUNTIME_ENV } from './tui/harnessRuntime'
import {
  createStandaloneHarness, ensureStandaloneDefaults, spawnFrontend, terminalSessionFolder,
  type StandaloneDependencies, type StandalonePaths
} from './standalone'
import type { DetachedTerminal, TerminalLaunch, TerminalRelaunch } from './terminals'

export interface DaemonFiles {
  socket: string
  lock: string
  log: string
}

export function daemonFiles(stateDir: string): DaemonFiles {
  return { socket: join(stateDir, 'harness.sock'), lock: join(stateDir, 'harness.lock'), log: join(stateDir, 'harness.log') }
}

interface LockRecord { pid: number; startedAt: string; socket: string }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The running daemon's lock record, or null when none is running (a stale lock is not one). */
export function daemonRecord(stateDir: string): LockRecord | null {
  const { lock } = daemonFiles(stateDir)
  if (!existsSync(lock)) return null
  try {
    const record = JSON.parse(readFileSync(lock, 'utf8')) as LockRecord
    return typeof record.pid === 'number' && alive(record.pid) ? record : null
  } catch {
    return null
  }
}

/** Takes the state folder's lock for this process, or refuses when another daemon holds it. */
export function acquireDaemonLock(stateDir: string): () => void {
  const files = daemonFiles(stateDir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(files.lock, 'wx', 0o600)
      const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString(), socket: files.socket }
      writeSync(descriptor, JSON.stringify(record))
      closeSync(descriptor)
      return () => {
        try {
          const current = JSON.parse(readFileSync(files.lock, 'utf8')) as LockRecord
          if (current.pid === process.pid) rmSync(files.lock, { force: true })
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const running = daemonRecord(stateDir)
      if (running) throw new HarnessError('daemon_running', `A harness is already running for this state folder (process ${running.pid}).`)
      // The process that held it is gone: the lock is stale.
      rmSync(files.lock, { force: true })
    }
  }
  throw new HarnessError('daemon_running', 'The harness lock could not be taken.')
}

/** Runs the long-lived harness in this process until it is stopped. */
export async function runDaemon(paths: StandalonePaths, profile: InteractiveProfile, dependencies: Pick<StandaloneDependencies, 'createHarness' | 'hostSecretStore'> = {}): Promise<number> {
  const files = daemonFiles(paths.stateDir)
  // A first run may come before anything has made the state folder.
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  const release = acquireDaemonLock(paths.stateDir)
  setLogSink((text) => {
    try {
      appendFileSync(files.log, `${new Date().toISOString()} [daemon] ${text}\n`)
    } catch {
      // Best effort.
    }
  })
  const harness = await createStandaloneHarness(paths, profile, dependencies)
  // Plugins run here for every window. One plugin's uncaught error is logged; it does not end every
  // session the harness holds, as it would end a single in-process terminal.
  const survive = (error: unknown): void => { log('uncaught error in the long-lived harness', error instanceof Error ? error.stack ?? error.message : String(error)) }
  process.on('uncaughtException', survive)
  process.on('unhandledRejection', survive)
  try {
    await harness.ready
    const variantScope = ensureStandaloneDefaults(harness, paths, profile)
    const startedAt = new Date().toISOString()
    let stopping: (() => void) | null = null
    const stopped = new Promise<void>((resolveStop) => { stopping = resolveStop })
    const server = await serveSocket(harness, files.socket, {
      'daemon.status': () => ({ pid: process.pid, startedAt, variantScope, live: harness.sessions.liveSessions(), detached: harness.terminals.detached() }),
      'daemon.stop': () => {
        setImmediate(() => stopping?.())
        return { stopping: true }
      }
    })
    process.once('SIGTERM', () => stopping?.())
    process.once('SIGINT', () => stopping?.())
    await stopped
    await server.close()
    return 0
  } finally {
    await Promise.race([harness.close(), new Promise((done) => setTimeout(done, 5000))])
    process.off('uncaughtException', survive)
    process.off('unhandledRejection', survive)
    release()
    setLogSink(null)
  }
}

/** The path flags that name these folders, for a daemon started in another process. */
function pathArguments(paths: StandalonePaths): string[] {
  return ['--data', paths.dataRoot, '--state', paths.stateDir, ...(paths.accountState ? ['--account-state', paths.accountState] : [])]
}

const cliPath = (): string => {
  // The bundled CLI is the file this code was bundled into; from source it is the package's `dist/cli.js`.
  const here = fileURLToPath(import.meta.url)
  return here.endsWith('cli.js') ? here : resolve(here, '..', '..', '..', 'dist', 'cli.js')
}

/** Connects to the daemon for these folders, starting it first when `start` is set and none runs. */
export async function connectDaemon(paths: StandalonePaths, options: { start: boolean; spawn?: typeof nodeSpawn; timeoutMs?: number } = { start: true }): Promise<HarnessClient> {
  const files = daemonFiles(paths.stateDir)
  const tryConnect = async (): Promise<HarnessClient | null> => {
    if (!daemonRecord(paths.stateDir) || !existsSync(files.socket)) return null
    return connectHarness(files.socket).catch(() => null)
  }
  const existing = await tryConnect()
  if (existing) return existing
  if (!options.start) throw new HarnessError('daemon_not_running', 'No harness is running for these folders. Start one with: xagent daemon start')
  const child = (options.spawn ?? nodeSpawn)(process.execPath, [cliPath(), 'daemon', 'run', ...pathArguments(paths)], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  while (Date.now() < deadline) {
    const client = await tryConnect()
    if (client) return client
    await new Promise((wait) => setTimeout(wait, 100))
  }
  throw new HarnessError('daemon_unavailable', `The harness did not start; see ${files.log}.`)
}

export interface DaemonTerminalOptions {
  paths: StandalonePaths
  profile: InteractiveProfile
  cwd: string
  spawn?: typeof nodeSpawn
  createSessionId?: () => string
  /** Reattach to this detached session instead of starting a new one. */
  attach?: DetachedTerminal
}

/** `xagent --daemon` and `xagent attach`: a terminal window on the long-lived harness. */
export async function runDaemonTerminal(options: DaemonTerminalOptions): Promise<number> {
  const { paths, profile } = options
  const client = await connectDaemon(paths, { start: !options.attach, ...(options.spawn ? { spawn: options.spawn } : {}) })
  const newSessionId = options.createSessionId ?? randomUUID
  let cwd = options.attach?.cwd ?? options.cwd
  let current = options.attach
    ? { sessionId: options.attach.sessionId, accountId: options.attach.accountId as string | null, nativeSessionId: null as string | null }
    : { sessionId: newSessionId(), accountId: null as string | null, nativeSessionId: null as string | null }
  let attach = Boolean(options.attach)
  try {
    const status = await client.call<{ variantScope: string }>('daemon.status')
    const variantScope = paths.variant ?? status.variantScope ?? profile.defaultVariantScope
    let variantVersion: string | null = null
    for (;;) {
      const sessionFolder = options.attach && attach ? options.attach.sessionFolder : terminalSessionFolder(paths.dataRoot, cwd)
      const launch = await client.call<TerminalLaunch>('terminal.prepare', {
        ...current, cwd, sessionFolder,
        variant: { scope: variantScope, ...(variantVersion ? { version: variantVersion } : {}) },
        ...(attach ? { attach: true } : {})
      }, 120_000)
      attach = false
      const env = { ...launch.env, [HARNESS_RUNTIME_ENV]: 'harness', ...(paths.remoteControl ? { [REMOTE_CONTROL_ENV]: '1' } : {}) }
      const code = await spawnFrontend({ ...launch, env }, cwd, options.spawn)
      const next = await client.call<TerminalRelaunch | null>('terminal.takeRelaunch', { sessionId: current.sessionId })
      if (!next) {
        const detached = await client.call<{ detached: boolean; activeRunId: string | null }>('terminal.detach', { sessionId: current.sessionId })
        if (detached.detached) process.stdout.write(`The reply is still running in the harness. Reattach with: xagent attach ${current.sessionId}\n`)
        return code
      }
      if (next.cwd) {
        process.stdout.write(`Opening ${next.cwd}.\n`)
        cwd = next.cwd
      } else if (next.variantVersion) {
        process.stdout.write(`Switching this conversation to variant version ${next.variantVersion.slice(0, 8)}.\n`)
        variantVersion = next.variantVersion
      } else process.stdout.write('Switching this session to another account.\n')
      await client.call('terminal.dispose', { sessionId: current.sessionId })
      current = { sessionId: newSessionId(), accountId: next.accountId, nativeSessionId: next.nativeSessionId }
    }
  } finally {
    client.close()
  }
}

/** `xagent attach [session id]`: reconnects a window to a reply that kept running. */
export async function runAttach(paths: StandalonePaths, profile: InteractiveProfile, sessionId: string | undefined, cwd: string): Promise<number> {
  const client = await connectDaemon(paths, { start: false })
  let detached: DetachedTerminal[]
  try {
    detached = (await client.call<{ sessions: DetachedTerminal[] }>('terminal.detached')).sessions
  } finally {
    client.close()
  }
  const chosen = sessionId ? detached.find((entry) => entry.sessionId === sessionId) : detached.length === 1 ? detached[0] : undefined
  if (!chosen) {
    if (!detached.length) process.stdout.write('No reply is running without a window.\n')
    else {
      process.stdout.write('Choose a session to reattach:\n')
      for (const entry of detached) process.stdout.write(`  xagent attach ${entry.sessionId}   ${entry.cwd}  (since ${entry.detachedAt})\n`)
    }
    return detached.length ? 2 : 1
  }
  return runDaemonTerminal({ paths, profile, cwd, attach: chosen })
}

/** `xagent daemon <start | stop | status | run>`. */
export async function runDaemonCommand(subcommand: string | undefined, paths: StandalonePaths, profile: InteractiveProfile): Promise<number> {
  switch (subcommand) {
    case 'run': return runDaemon(paths, profile)
    case 'start': {
      const client = await connectDaemon(paths, { start: true })
      const status = await client.call<{ pid: number }>('daemon.status')
      client.close()
      process.stdout.write(`The harness is running (process ${status.pid}).\n`)
      return 0
    }
    case 'status': {
      const record = daemonRecord(paths.stateDir)
      if (!record) {
        process.stdout.write('No harness is running for these folders.\n')
        return 1
      }
      const client = await connectDaemon(paths, { start: false })
      const status = await client.call<{ pid: number; startedAt: string; live: unknown[]; detached: DetachedTerminal[] }>('daemon.status')
      client.close()
      process.stdout.write(`The harness is running (process ${status.pid}, since ${status.startedAt}): ${status.live.length} live session(s), ${status.detached.length} reply(ies) without a window.\n`)
      return 0
    }
    case 'stop': {
      if (!daemonRecord(paths.stateDir)) {
        process.stdout.write('No harness is running for these folders.\n')
        return 0
      }
      const client = await connectDaemon(paths, { start: false })
      await client.call('daemon.stop').catch(() => undefined)
      await Promise.race([client.closed, new Promise((done) => setTimeout(done, 10_000))])
      process.stdout.write('The harness stopped.\n')
      return 0
    }
    default:
      process.stdout.write('Usage: xagent daemon <start | stop | status> [--data <dir>] [--state <dir>] [--account-state <dir>]\n')
      return 2
  }
}
