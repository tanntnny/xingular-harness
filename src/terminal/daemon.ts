// The long-lived harness for one data root and state folder (ADR-0083, phase 3). `xagent --daemon`
// starts it when it is not running and prepares its terminal there, so a reply keeps running when the
// window closes; `xagent attach` reconnects a window to it. It serves the server protocol on a
// socket in the state folder that only this user can open, and one lock keeps it the only harness
// writing for that state folder.
import type { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { log, setLogSink } from '../core/bus'
import { PACKAGE_VERSION } from '../core/version'
import type { InteractiveProfile } from '../core/interactiveProfile'
import type { Harness, HarnessOptions } from '../harness'
import { HostHub } from '../server/hostHub'
import { HarnessError } from '../core/errors'
import { acquireDaemonLock, connectDaemon, daemonFiles, daemonLaunchHash, daemonRecord, DAEMON_VERSION_MISMATCH, HOST_LAUNCH_FILE, OAUTH_CLIENTS_ENV, readDaemonLaunch, runningBuild, socketPathProblem, type DaemonLaunch, type DaemonStatus } from '../server/daemonClient'
import { serveSocket, type HarnessClient } from '../server/socket'
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
  const release = acquireDaemonLock(paths.stateDir, undefined, {
    ...(launch ? { config: daemonLaunchHash(launch) } : {}),
    dataRoot: paths.dataRoot,
    accountState: paths.accountState ?? null,
    ...(runningBuild() ? { build: runningBuild() } : {})
  })
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
  // A profile whose credentials a host keeps is served by that host, when it is connected. This holds
  // whoever started the daemon: the credentials are the host's, not the launch's.
  const hostSecrets = launch?.secrets === 'host' || profile.secretBackend.kind === 'host'
  const extra: Partial<HarnessOptions> = {
    ...(launch ? {
      ...(launch.productName ? { productName: launch.productName } : {}),
      ...(launch.browser !== undefined ? { browser: launch.browser } : {}),
      ...(launch.browserExtension ? { browserExtension: launch.browserExtension } : {}),
      ...(launch.worktrees ? { worktrees: launch.worktrees } : {}),
      ...(launch.builtins ? { builtins: launch.builtins } : {}),
      ...(launch.plugins ? { plugins: launch.plugins } : {}),
      ...(launch.oauthClients ? { oauthClients: oauthClientsFrom(launch.oauthClients.ids) } : {}),
      // A launch is a host's: its sessions are gated by it and named by it. (`hosts` is no longer needed.)
      policy: hub.policy,
      directory: hub.directory
    } : {}),
    ...(hostSecrets ? { secrets: hub.secrets } : {})
  }
  // Plugins run here for every window. One plugin's uncaught error is logged; it does not end every
  // session the harness holds, as it would end a single in-process terminal.
  const survive = (error: unknown): void => { log('uncaught error in the long-lived harness', error instanceof Error ? error.stack ?? error.message : String(error)) }
  process.on('uncaughtException', survive)
  process.on('unhandledRejection', survive)
  let removeSignals = (): void => undefined
  let created: Harness | null = null
  try {
    // A start that fails says why in the log, where the window that started it points, and frees the lock.
    try {
      created = await createStandaloneHarness(paths, profile, dependencies, extra)
    } catch (error) {
      log('the long-lived harness could not start', error instanceof Error ? error.stack ?? error.message : String(error))
      throw error
    }
    const harness: Harness = created
    started = harness
    // A run started while a host's call was served is that host's, whatever started it.
    harness.runs.listen((event) => { if (event.type === 'started') hub.claimFromCall(event.sessionId) })
    await harness.ready
    // A host's daemon leaves accounts and the default variant to the host (and to the terminals that
    // ask for them); a daemon nobody configured prepares both, as a window's own harness does.
    const variantScope = launch ? (paths.variant ?? profile.defaultVariantScope) : ensureStandaloneDefaults(harness, paths, profile)
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
    if (created) await Promise.race([created.close(), new Promise((done) => setTimeout(done, 5000))])
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
  /** Start the daemon when none runs. False for a window that must not be the one to start it. */
  startDaemon?: boolean
}

/** `xagent --daemon` and `xagent attach`: a terminal window on the long-lived harness. */
/** The folder `--worktree` names, made or found through the daemon, as the window's own harness does it. */
async function enterWorktree(client: HarnessClient, cwd: string, wanted: string | true): Promise<{ id: string; path: string }> {
  const name = wanted === true ? undefined : wanted
  const existing = name ? (await client.call<Array<{ id: string; name: string; path: string }>>('worktrees.list', { repo: cwd })).find((record) => record.name === name) : undefined
  if (existing) return existing
  const created = await client.call<{ worktree: { id: string; name: string; path: string }; setup: { state: string; log?: string } }>('worktrees.create', { repo: cwd, ...(name ? { name } : {}) }, 120_000)
  process.stdout.write(`Working in worktree ${created.worktree.name} (${created.worktree.path}).\n`)
  if (created.setup.state === 'untrusted') process.stdout.write('This repository has a setup script you have not trusted; read .xharness/worktree-setup, then run: xagent worktree trust-setup\n')
  if (created.setup.state === 'failed') process.stdout.write(`The worktree setup script failed; see ${created.setup.log}.\n`)
  await client.call('worktrees.prune', { repo: cwd }).catch(() => undefined)
  return created.worktree
}

/** Whether a call failed because the daemon is gone, not because it refused. */
const daemonGone = (error: unknown): boolean => ['harness_unavailable', 'harness_timeout'].includes((error as { code?: string })?.code ?? '')

export async function runDaemonTerminal(options: DaemonTerminalOptions): Promise<number> {
  const { paths, profile } = options
  // Errors before the frontend has drawn on the terminal are marked, so the caller may run the window in its
  // own harness instead; nothing is repeated after the person has seen the terminal.
  let frontendStarted = false
  const early = (error: unknown): never => {
    if (error && typeof error === 'object') (error as { beforeFrontend?: boolean }).beforeFrontend = !frontendStarted
    throw error
  }
  const client = await connectDaemon(paths, { start: options.startDaemon !== false && !options.attach, anyVersion: Boolean(options.attach), ...(options.spawn ? { spawn: options.spawn } : {}) }).catch(early)
  const newSessionId = options.createSessionId ?? randomUUID
  let cwd = options.attach?.cwd ?? options.cwd
  let current = options.attach
    ? { sessionId: options.attach.sessionId, accountId: options.attach.accountId as string | null, nativeSessionId: null as string | null }
    : { sessionId: newSessionId(), accountId: null as string | null, nativeSessionId: null as string | null }
  let attach = Boolean(options.attach)
  let ended = false
  try {
    const status = await client.call<{ variantScope: string }>('daemon.status')
    const variantScope = paths.variant ?? status.variantScope ?? profile.defaultVariantScope
    let worktreeId: string | null = null
    if (paths.worktree && !options.attach) {
      const worktree = await enterWorktree(client, cwd, paths.worktree)
      cwd = worktree.path
      worktreeId = worktree.id
    }
    let variantVersion: string | null = null
    for (;;) {
      const sessionFolder = options.attach && attach ? options.attach.sessionFolder : terminalSessionFolder(paths.dataRoot, cwd)
      const launch = await client.call<TerminalLaunch>('terminal.prepare', {
        ...current, cwd, sessionFolder,
        variant: { scope: variantScope, ...(variantVersion ? { version: variantVersion } : {}) },
        ...(worktreeId ? { run: { worktreeId } } : {}),
        ...(attach ? { attach: true } : {})
      }, 120_000)
      attach = false
      const env = { ...launch.env, [HARNESS_RUNTIME_ENV]: 'harness', ...(paths.remoteControl ? { [REMOTE_CONTROL_ENV]: '1' } : {}) }
      frontendStarted = true
      const code = await spawnFrontend({ ...launch, env }, cwd, options.spawn)
      // A daemon that went while the window was open has nothing left to keep or end.
      const next = await client.call<TerminalRelaunch | null>('terminal.takeRelaunch', { sessionId: current.sessionId }).catch((error) => {
        if (daemonGone(error)) return null
        throw error
      })
      if (!next) {
        const detached = await client.call<{ detached: boolean; activeRunId: string | null }>('terminal.detach', { sessionId: current.sessionId }).catch((error) => {
          if (daemonGone(error)) return { detached: false, activeRunId: null }
          throw error
        })
        ended = true
        if (detached.detached) process.stdout.write(`The reply is still running in the harness. Reattach with: xagent attach ${current.sessionId}\n`)
        return code
      }
      if (next.cwd) {
        process.stdout.write(`Opening ${next.cwd}.\n`)
        cwd = next.cwd
        worktreeId = next.worktreeId ?? null
      } else if (next.variantVersion) {
        process.stdout.write(`Switching this conversation to variant version ${next.variantVersion.slice(0, 8)}.\n`)
        variantVersion = next.variantVersion
      } else {
        const accounts = await client.call<{ accounts?: Array<{ id: string; label: string }> }>('accounts.list').catch(() => null)
        process.stdout.write(`Switching this session to account ${accounts?.accounts?.find((account) => account.id === next.accountId)?.label ?? 'another account'}.\n`)
      }
      await client.call('terminal.dispose', { sessionId: current.sessionId })
      current = { sessionId: newSessionId(), accountId: next.accountId, nativeSessionId: next.nativeSessionId }
    }
  } catch (error) {
    // A window that could not run (the frontend would not start, the daemon went away) leaves nothing prepared.
    if (!ended) await client.call('terminal.dispose', { sessionId: current.sessionId }, 5000).catch(() => undefined)
    return early(error)
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
    case 'run': {
      // A host leaves its launch options in the state folder, so a daemon any window starts is the one that host needs.
      const file = hostConfig ?? (existsSync(join(paths.stateDir, HOST_LAUNCH_FILE)) ? join(paths.stateDir, HOST_LAUNCH_FILE) : undefined)
      return runDaemon(paths, profile, {}, file ? { launch: readDaemonLaunch(file) } : {})
    }
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

export { acquireDaemonLock, connectDaemon, daemonFiles, daemonLaunchHash, daemonRecord, DAEMON_VERSION_MISMATCH, HOST_LAUNCH_FILE, readDaemonLaunch }
export type { ConnectDaemonOptions, DaemonFiles, DaemonLaunch, DaemonStatus, LockRecord } from '../server/daemonClient'
