// How a process finds, starts and connects to the long-lived harness of a state folder (ADR-0083,
// phase 3): the lock that makes it the one harness serving that folder, and the connection. Kept free of
// the terminal so a host that is not a terminal (an application's sidecar) can use it.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HarnessError } from '../core/errors'
import type { PluginDescriptor } from '../plugins/types'
import { PACKAGE_VERSION } from '../core/version'
import { connectHarness, type HarnessClient } from './socket'

export interface DaemonFiles {
  socket: string
  lock: string
  log: string
}

export function daemonFiles(stateDir: string): DaemonFiles {
  return { socket: join(stateDir, 'harness.sock'), lock: join(stateDir, 'harness.lock'), log: join(stateDir, 'harness.log') }
}

/**
 * `version` is absent in a lock written before the handshake, which always counts as a different
 * version. `config` identifies the launch options of a daemon a host started (page 11).
 */
export interface LockRecord {
  pid: number
  startedAt: string
  socket: string
  version?: string
  config?: string
  /** The folders this daemon serves; a window that names others cannot use it. */
  dataRoot?: string
  accountState?: string | null
  /** A hash of the `cli.js` the daemon runs, for a host that needs its own build. */
  build?: string
}

/** What a daemon records about itself beyond its version. */
export interface LockIdentity {
  config?: string
  dataRoot?: string
  accountState?: string | null
  build?: string
}

/** A hash of a file's contents, or undefined when it cannot be read. */
export function fileIdentity(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}

/** The identity of the bundle this code runs from, when it is the CLI (`cli.js`); undefined from source. */
export function runningBuild(): string | undefined {
  const here = fileURLToPath(import.meta.url)
  return here.endsWith('cli.js') ? fileIdentity(here) : undefined
}

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

/** The longest a Unix socket path may be: the platform's `sun_path` size, less the terminator. */
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107

/** Why the daemon cannot listen in this state folder, or null. A deep folder fails late and obscurely otherwise. */
export function socketPathProblem(stateDir: string): string | null {
  const { socket } = daemonFiles(stateDir)
  return Buffer.byteLength(socket) > SOCKET_PATH_LIMIT
    ? `The state folder path is too deep for the harness socket (${Buffer.byteLength(socket)} bytes; the limit is ${SOCKET_PATH_LIMIT}). Use a shorter folder with --state.`
    : null
}

/**
 * Takes the state folder's lock for this process, or refuses when another daemon holds it. The record
 * is written whole to a private file and linked into place, so no process ever sees a half-written lock
 * (and takes it for a stale one) while another starts.
 */
export function acquireDaemonLock(stateDir: string, version: string = PACKAGE_VERSION, identity: LockIdentity | string = {}): () => void {
  const files = daemonFiles(stateDir)
  // A bare string is the launch hash, as callers passed it before the lock held more.
  const extra: LockIdentity = typeof identity === 'string' ? { config: identity } : identity
  const record: LockRecord = {
    pid: process.pid, startedAt: new Date().toISOString(), socket: files.socket, version,
    ...(extra.config ? { config: extra.config } : {}),
    ...(extra.dataRoot ? { dataRoot: extra.dataRoot } : {}),
    ...(extra.accountState !== undefined ? { accountState: extra.accountState } : {}),
    ...(extra.build ? { build: extra.build } : {})
  }
  const mine = `${files.lock}.${process.pid}.tmp`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = openSync(mine, 'w', 0o600)
    try {
      writeSync(descriptor, JSON.stringify(record))
    } finally {
      closeSync(descriptor)
    }
    try {
      linkSync(mine, files.lock)
      rmSync(mine, { force: true })
      return () => {
        try {
          const current = JSON.parse(readFileSync(files.lock, 'utf8')) as LockRecord
          if (current.pid === process.pid) rmSync(files.lock, { force: true })
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      rmSync(mine, { force: true })
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const running = daemonRecord(stateDir)
      if (running) throw new HarnessError('daemon_running', `A harness is already running for this state folder (process ${running.pid}).`)
      // The process that held it is gone: the lock is stale.
      rmSync(files.lock, { force: true })
    }
  }
  throw new HarnessError('daemon_running', 'The harness lock could not be taken.')
}

/** What `daemon.status` reports. `version` and `windows` are absent from a daemon older than the handshake. */
export interface DaemonStatus {
  pid: number
  version?: string
  startedAt: string
  variantScope: string
  windows?: number
  /** Hosts connected now, by the name each registered under. */
  hosts?: string[]
  live: Array<{ activeRunId: string | null }>
  detached: Array<{ sessionId: string }>
}

export interface DaemonPaths {
  dataRoot: string
  stateDir: string
  accountState?: string | null
}

/** The launch options a host gives a daemon it starts: a JSON file, and the hash that tells launches apart. */
export interface DaemonConfigRef {
  file: string
  hash: string
}

/**
 * What a host that starts the daemon asks of it, as a JSON file (`xagent daemon run --host-config`).
 * The harness names no host; the values are the host's own. Anything a host does not set keeps the
 * standalone default.
 */
export interface DaemonLaunch {
  /** Let hosts connect and supply policy, names, tools, a broker and a refine host (page 10). */
  hosts?: boolean
  /** Credentials come from the connected host rather than the profile's store. */
  secrets?: 'host'
  productName?: string
  browser?: boolean
  browserExtension?: { port?: number }
  worktrees?: { branchPrefix?: string }
  builtins?: string[]
  plugins?: PluginDescriptor[]
  /** The catalog entries the host can sign in for; their client secrets come in `OAUTH_CLIENTS_ENV`. */
  oauthClients?: { ids: string[] }
}

/** Where a host leaves its launch options in the state folder: every `daemon run` there reads them. */
export const HOST_LAUNCH_FILE = 'host-launch.json'

/** Where a host passes the sign-in clients' secrets to the daemon it starts: a JSON map by catalog id. */
export const OAUTH_CLIENTS_ENV = 'XINGULAR_DAEMON_OAUTH_CLIENTS'

export function readDaemonLaunch(file: string): DaemonLaunch {
  return JSON.parse(readFileSync(file, 'utf8')) as DaemonLaunch
}

/** Identifies a launch, so a host can tell whether the daemon that runs is the one it asked for. */
export function daemonLaunchHash(launch: DaemonLaunch): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, canonical(entry)]))
    : value
  return createHash('sha256').update(JSON.stringify(canonical(launch))).digest('hex').slice(0, 16)
}

export interface ConnectDaemonOptions {
  /** Start the daemon when none runs. */
  start: boolean
  /** The version a running daemon must be; another version is replaced when it has nothing to lose. */
  version?: string
  /** Skip the version and config check, to reach a running daemon whatever it is (`attach`, `daemon stop`). */
  anyVersion?: boolean
  /** The launch options a host needs: a daemon started with others is replaced when idle, else refused. */
  config?: DaemonConfigRef
  /** The CLI that runs `daemon run`; by default the one this code was bundled into. */
  cli?: string
  /** A hash of the `cli.js` the daemon must run (`fileIdentity`); a daemon of another build is replaced when idle. */
  build?: string
  spawn?: typeof nodeSpawn
  /** The environment of a daemon this starts; by default this process's. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** The daemon is of another version or launch and cannot be replaced yet, because a window or a reply still uses it. */
export const DAEMON_VERSION_MISMATCH = 'daemon_version_mismatch'

/** How long a started daemon may take to open its socket: recovery reads the whole data root first. */
export const DAEMON_START_MS = 45_000

/** The path flags that name these folders, for a daemon started in another process. */
function pathArguments(paths: DaemonPaths): string[] {
  return ['--data', paths.dataRoot, '--state', paths.stateDir, ...(paths.accountState ? ['--account-state', paths.accountState] : [])]
}

const cliPath = (): string => {
  // The bundled CLI is the file this code was bundled into; from source it is the package's `dist/cli.js`.
  const here = fileURLToPath(import.meta.url)
  return here.endsWith('cli.js') ? here : resolve(here, '..', '..', '..', 'dist', 'cli.js')
}

/**
 * Stops a daemon of another version or launch when no window, host or reply depends on it. Returns
 * false (and leaves it running) when one does; a daemon without the handshake counts its live
 * sessions instead.
 */
async function replaceStaleDaemon(paths: DaemonPaths, stale: LockRecord): Promise<boolean> {
  const files = daemonFiles(paths.stateDir)
  const client = await connectHarness(files.socket).catch(() => null)
  if (!client) return false
  try {
    const status = await client.call<DaemonStatus>('daemon.status')
    const busy = (status.windows ?? status.live.length) > 0 || (status.hosts?.length ?? 0) > 0 || status.live.some((entry) => entry.activeRunId) || status.detached.length > 0
    if (busy) return false
    await client.call('daemon.stop').catch(() => undefined)
    await Promise.race([client.closed, new Promise((done) => setTimeout(done, 10_000))])
  } finally {
    client.close()
  }
  // The old process removes its lock as it exits; a lock still held by it after the wait means it did not.
  const deadline = Date.now() + 10_000
  while (daemonRecord(paths.stateDir)?.pid === stale.pid && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 50))
  return daemonRecord(paths.stateDir)?.pid !== stale.pid
}

/** The folder a path names, so `./a` and `a/` are the same. */
const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ? resolve(a) : null) === (b ? resolve(b) : null)

/** Connects to the daemon for these folders, starting it first when `start` is set and none runs. */
export async function connectDaemon(paths: DaemonPaths, options: ConnectDaemonOptions = { start: true }): Promise<HarnessClient> {
  const files = daemonFiles(paths.stateDir)
  const expected = options.version ?? PACKAGE_VERSION
  const tooDeep = socketPathProblem(paths.stateDir)
  if (tooDeep && options.start) throw new HarnessError('socket_path_too_long', tooDeep)
  const tryConnect = async (): Promise<HarnessClient | null> => {
    const record = daemonRecord(paths.stateDir)
    // No lock, or a daemon that has not opened its socket yet.
    if (!record || !existsSync(files.socket)) return null
    try {
      return await connectHarness(files.socket)
    } catch (error) {
      // A live process that holds the lock but whose socket refuses: the pid was reused after a crash or a
      // reboot. A daemon still starting is young, so it is left alone.
      const age = Date.now() - Date.parse(record.startedAt)
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' && Number.isFinite(age) && age > 30_000) {
        rmSync(files.lock, { force: true })
        rmSync(files.socket, { force: true })
      }
      return null
    }
  }
  // After an upgrade the old daemon keeps running; a new window must not silently talk to it. A host
  // that needs particular launch options or a build does not talk to a daemon started without them either.
  const record = daemonRecord(paths.stateDir)
  const differs = (found: LockRecord): string | null => {
    if (found.version !== expected) return found.version ? `version ${found.version}, not ${expected}` : `older than the version check, not ${expected}`
    if (options.config !== undefined && found.config !== options.config.hash) return 'started with other options'
    if (options.build !== undefined && found.build !== options.build) return 'a different build'
    if (found.dataRoot !== undefined && !same(found.dataRoot, paths.dataRoot)) return `serving another data folder (${found.dataRoot})`
    if (found.accountState !== undefined && !same(found.accountState, paths.accountState)) return 'serving other accounts'
    return null
  }
  if (record && !options.anyVersion) {
    const reason = differs(record)
    if (reason && !(await replaceStaleDaemon(paths, record))) {
      throw new HarnessError(DAEMON_VERSION_MISMATCH, `The running harness is ${reason}, and a window, host or reply still uses it. Close its windows, or run: xagent daemon stop`)
    }
  }
  const existing = await tryConnect()
  if (existing) return existing
  if (!options.start) throw new HarnessError('daemon_not_running', 'No harness is running for these folders. Start one with: xagent daemon start')
  // Its output goes to the log, where a person looks when it does not start.
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  const output = openSync(files.log, 'a', 0o600)
  let child: ReturnType<typeof nodeSpawn>
  try {
    child = (options.spawn ?? nodeSpawn)(process.execPath, [options.cli ?? cliPath(), 'daemon', 'run', ...pathArguments(paths), ...(options.config ? ['--host-config', options.config.file] : [])], { detached: true, stdio: ['ignore', output, output], cwd: paths.stateDir, env: options.env ?? process.env })
  } finally {
    closeSync(output)
  }
  let exited: string | null = null
  child.once?.('exit', (code, signal) => { exited = `exited (${code ?? signal})` })
  child.once?.('error', (error) => { exited = `could not start (${error.message})` })
  child.unref?.()
  const deadline = Date.now() + (options.timeoutMs ?? DAEMON_START_MS)
  while (Date.now() < deadline) {
    const client = await tryConnect()
    if (client) return client
    // The child is gone and no other daemon took its place: waiting longer cannot help.
    if (exited && !daemonRecord(paths.stateDir)) throw new HarnessError('daemon_unavailable', `The harness ${exited} before it was ready; see ${files.log}.`)
    await new Promise((wait) => setTimeout(wait, 100))
  }
  throw new HarnessError('daemon_unavailable', `The harness did not start; see ${files.log}.`)
}
