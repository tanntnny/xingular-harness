// The long-lived harness for one data root and state folder (ADR-0083, phase 3). `xagent --daemon`
// starts it when it is not running and prepares its terminal there, so a reply keeps running when the
// window closes; `xagent attach` reconnects a window to it. It serves the server protocol on a
// socket in the state folder that only this user can open, and one lock keeps it the only harness
// writing for that state folder.
import type { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'

import { log, setLogSink } from '../core/bus'
import { PACKAGE_VERSION } from '../core/version'
import type { InteractiveProfile } from '../core/interactiveProfile'
import type { Harness, HarnessOptions } from '../harness'
import { HostHub } from '../server/hostHub'
import { HarnessError } from '../core/errors'
import { acquireDaemonLock, connectDaemon, daemonFiles, daemonLaunchHash, daemonRecord, DAEMON_VERSION_MISMATCH, OAUTH_CLIENTS_ENV, readDaemonLaunch, socketPathProblem, type DaemonLaunch, type DaemonStatus } from '../server/daemonClient'
import { serveSocket } from '../server/socket'
import { REMOTE_CONTROL_ENV } from './client'
import { HARNESS_RUNTIME_ENV } from './tui/harnessRuntime'
import {
  createStandaloneHarness, ensureStandaloneDefaults, spawnFrontend, terminalSessionFolder,
  type StandaloneDependencies, type StandalonePaths
} from './standalone'
import type { DetachedTerminal, TerminalLaunch, TerminalRelaunch } from './terminals'

/** How long the harness stays up with nothing to serve before it exits (no windows, live sessions, replies or clients). */
export const DAEMON_IDLE_MS = 30 * 60_000

/**
 * The sign-in clients a host's launch lists, with their secrets from the environment the host started
 * the daemon in. The secret never touches the launch file, and is removed from the environment before
 * any tool the daemon runs could read it.
 */
function oauthClientsFrom(ids: string[]): HarnessOptions['oauthClients'] {
  let clients: Record<string, { clientId: string; clientSecret: string }> = {}
  try {
    clients = JSON.parse(process.env[OAUTH_CLIENTS_ENV] ?? '{}')
  } catch {
    // No usable clients: the connectors that need one are not offered.
  }
  delete process.env[OAUTH_CLIENTS_ENV]
  return { ids: () => ids, get: async (catalogId) => (ids.includes(catalogId) ? clients[catalogId] ?? null : null) }
}

export interface DaemonOptions {
  /** A host's launch options. */
  launch?: DaemonLaunch
  /** Exit after this long idle; `null` never exits on its own. */
  idleMs?: number | null
  /** How often idleness is checked. */
  checkMs?: number
}

/** Runs the long-lived harness in this process until it is stopped. */
export async function runDaemon(paths: StandalonePaths, profile: InteractiveProfile, dependencies: Pick<StandaloneDependencies, 'createHarness' | 'hostSecretStore'> = {}, options: DaemonOptions = {}): Promise<number> {
  const files = daemonFiles(paths.stateDir)
  // A first run may come before anything has made the state folder.
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
  const launch = options.launch
  const tooDeep = socketPathProblem(paths.stateDir)
  if (tooDeep) throw new HarnessError('socket_path_too_long', tooDeep)
  const release = acquireDaemonLock(paths.stateDir, undefined, launch ? daemonLaunchHash(launch) : undefined)
  setLogSink((text) => {
    try {
      appendFileSync(files.log, `${new Date().toISOString()} [daemon] ${text}\n`)
    } catch {
      // Best effort.
    }
  })
  // Hosts connect to this harness over its socket; the hub routes what each supplies to the sessions
  // that host started (page 10).
  let started: Harness | null = null
  const hub = new HostHub({
    root: () => started?.env.root ?? paths.dataRoot,
    extraTools: (session) => started && started.world.browserConfig().backend === 'brave' ? started.world.browserToolsForSession(session) : [],
    install: {
      tools: (provider) => started?.sessions.provide(provider),
      broker: (tools) => started?.apps.expose(tools),
      refine: (host) => { if (started) started.refineHost = host }
    }
  })
  const extra: Partial<HarnessOptions> = launch ? {
    ...(launch.productName ? { productName: launch.productName } : {}),
    ...(launch.browser !== undefined ? { browser: launch.browser } : {}),
    ...(launch.browserExtension ? { browserExtension: launch.browserExtension } : {}),
    ...(launch.worktrees ? { worktrees: launch.worktrees } : {}),
    ...(launch.builtins ? { builtins: launch.builtins } : {}),
    ...(launch.plugins ? { plugins: launch.plugins } : {}),
    ...(launch.oauthClients ? { oauthClients: oauthClientsFrom(launch.oauthClients.ids) } : {}),
    ...(launch.hosts ? { policy: hub.policy, directory: hub.directory } : {}),
    ...(launch.secrets === 'host' ? { secrets: hub.secrets } : {})
  } : {}
  const harness = await createStandaloneHarness(paths, profile, dependencies, extra)
  started = harness
  // Plugins run here for every window. One plugin's uncaught error is logged; it does not end every
  // session the harness holds, as it would end a single in-process terminal.
  const survive = (error: unknown): void => { log('uncaught error in the long-lived harness', error instanceof Error ? error.stack ?? error.message : String(error)) }
  process.on('uncaughtException', survive)
  process.on('unhandledRejection', survive)
  let removeSignals = (): void => undefined
  try {
    await harness.ready
    const variantScope = ensureStandaloneDefaults(harness, paths, profile)
    const startedAt = new Date().toISOString()
    let stopping: (() => void) | null = null
    const stopped = new Promise<void>((resolveStop) => { stopping = resolveStop })
    const server = await serveSocket(harness, files.socket, {
      'daemon.status': () => ({
        pid: process.pid, version: PACKAGE_VERSION, startedAt, variantScope,
        windows: harness.terminals.windowCount(), hosts: hub.hostNames(), live: harness.sessions.liveSessions(), detached: harness.terminals.detached()
      }),
      'daemon.stop': () => {
        setImmediate(() => stopping?.())
        return { stopping: true }
      }
    }, { hub })
    const onSignal = (): void => stopping?.()
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    removeSignals = () => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    }
    // A long-lived process nobody uses should not outlive its work. Idle means nothing is attached:
    // no window, live session, phone pairing, reply without a window, or client (a host's connection stays open).
    const idleMs = options.idleMs === undefined ? DAEMON_IDLE_MS : options.idleMs
    let idleTimer: ReturnType<typeof setInterval> | null = null
    if (idleMs !== null) {
      let idleSince: number | null = null
      idleTimer = setInterval(() => {
        const busy = harness.terminals.windowCount() > 0 || harness.sessions.liveSessions().length > 0 || harness.remotes.running() > 0 || server.connections() > 0
        if (busy) idleSince = null
        else if (idleSince === null) idleSince = Date.now()
        else if (Date.now() - idleSince >= idleMs) {
          log('the long-lived harness is idle; exiting')
          stopping?.()
        }
      }, options.checkMs ?? Math.min(60_000, Math.max(1, Math.floor(idleMs / 2))))
      idleTimer.unref()
    }
    try {
      await stopped
    } finally {
      if (idleTimer) clearInterval(idleTimer)
    }
    await server.close()
    return 0
  } finally {
    await Promise.race([harness.close(), new Promise((done) => setTimeout(done, 5000))])
    removeSignals()
    process.off('uncaughtException', survive)
    process.off('unhandledRejection', survive)
    release()
    setLogSink(null)
  }
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
  const client = await connectDaemon(paths, { start: !options.attach, anyVersion: Boolean(options.attach), ...(options.spawn ? { spawn: options.spawn } : {}) })
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
  const client = await connectDaemon(paths, { start: false, anyVersion: true })
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
export async function runDaemonCommand(subcommand: string | undefined, paths: StandalonePaths, profile: InteractiveProfile, hostConfig?: string): Promise<number> {
  switch (subcommand) {
    case 'run': return runDaemon(paths, profile, {}, hostConfig ? { launch: readDaemonLaunch(hostConfig) } : {})
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
      const client = await connectDaemon(paths, { start: false, anyVersion: true })
      const status = await client.call<DaemonStatus>('daemon.status')
      client.close()
      process.stdout.write(`The harness is running (process ${status.pid}, version ${status.version ?? 'unknown'}, since ${status.startedAt}): ${status.live.length} live session(s), ${status.detached.length} reply(ies) without a window.\n`)
      return 0
    }
    case 'stop': {
      if (!daemonRecord(paths.stateDir)) {
        process.stdout.write('No harness is running for these folders.\n')
        return 0
      }
      const client = await connectDaemon(paths, { start: false, anyVersion: true })
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

export { acquireDaemonLock, connectDaemon, daemonFiles, daemonLaunchHash, daemonRecord, DAEMON_VERSION_MISMATCH, readDaemonLaunch }
export type { ConnectDaemonOptions, DaemonFiles, DaemonLaunch, DaemonStatus, LockRecord } from '../server/daemonClient'
