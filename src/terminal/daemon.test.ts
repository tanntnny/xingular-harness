// The long-lived harness (ADR-0083, phase 3): one per state folder, serving the protocol on a socket.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness, type HarnessOptions } from '../harness'
import type { InteractiveProfile } from '../core/interactiveProfile'
import { connectHarness, serveSocket } from '../server/socket'
import { PACKAGE_VERSION } from '../core/version'
import { runRecordSchema } from '../sessions/contracts'
import { appendEvent, loadRun, saveRun } from '../sessions/runStore'
import { acquireDaemonLock, connectDaemon, DAEMON_VERSION_MISMATCH, daemonFiles, daemonLaunchHash, daemonRecord, runDaemon, type DaemonOptions } from './daemon'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

// A short folder: a Unix socket path has a small length limit.
const base = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'xd-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('the daemon lock', () => {
  it('lets one process hold a state folder and replaces a lock whose process is gone', () => {
    const state = base()
    const release = acquireDaemonLock(state)
    expect(daemonRecord(state)?.pid).toBe(process.pid)
    expect(() => acquireDaemonLock(state)).toThrow(/already running/)
    release()
    expect(daemonRecord(state)).toBeNull()
    writeFileSync(daemonFiles(state).lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '', socket: '' }))
    expect(daemonRecord(state)).toBeNull()
    const again = acquireDaemonLock(state)
    expect(daemonRecord(state)?.pid).toBe(process.pid)
    again()
  })
})

describe('the protocol on a socket', () => {
  it('serves the method table to each connection, relays run events, and stops relaying when it closes', async () => {
    const dir = base()
    const harness = createHarness({ dataRoot: join(dir, 'data'), stateDir: join(dir, 'state'), secrets: memorySecretStore() })
    cleanup.push(() => harness.close())
    mkdirSync(join(dir, 'state'), { recursive: true })
    const server = await serveSocket(harness, join(dir, 'state', 'h.sock'))
    cleanup.push(() => server.close())
    expect(statSync(server.path).mode & 0o777).toBe(0o600)
    const first = await connectHarness(server.path)
    const second = await connectHarness(server.path)
    expect(await first.call<string[]>('harness.methods')).toEqual(expect.arrayContaining(['sessions.run', 'sessions.live', 'terminal.detach']))
    await first.call('accounts.create', { label: 'Main', authKind: 'apiKey' })
    expect(await second.call('accounts.list')).toBeTruthy()
    const seen: unknown[] = []
    second.onMessage((message) => void seen.push(message))
    harness.bus.emit({ type: 'plugins.changed' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toContainEqual(expect.objectContaining({ notice: { type: 'plugins.changed' } }))
    await expect(first.call('no.such.method')).rejects.toMatchObject({ code: 'unknown_method' })
    first.close()
    await first.closed
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(server.connections()).toBe(1)
    // A closed connection hears nothing more; the open one still does.
    const before = seen.length
    harness.bus.emit({ type: 'plugins.changed' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen.length).toBe(before + 1)
    second.close()
  })
})

describe('the long-lived harness', () => {
  it('runs for a state folder, prepares terminals over its socket, reports and stops', async () => {
    const dir = base()
    // A first run makes its own state folder.
    const paths = { dataRoot: join(dir, 'data'), stateDir: join(dir, 'state') }
    const profile: InteractiveProfile = { version: 1, dataRoot: paths.dataRoot, stateDir: paths.stateDir, defaultVariantScope: 'default', secretBackend: { kind: 'file', path: join(paths.stateDir, 'secrets.json') } }
    const running = runDaemon(paths, profile, { createHarness: (options) => createHarness({ ...options, secrets: memorySecretStore() }) as Harness })
    const client = await (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          return await connectDaemon(paths, { start: false })
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      throw new Error('the daemon did not start')
    })()
    const status = await client.call<{ pid: number; variantScope: string; detached: unknown[] }>('daemon.status')
    expect(status).toMatchObject({ pid: process.pid, variantScope: 'default', detached: [] })
    expect(() => acquireDaemonLock(paths.stateDir)).toThrow(/already running/)
    const cwd = join(dir, 'project')
    mkdirSync(cwd)
    const launch = await client.call<{ env: Record<string, string | null> }>('terminal.prepare', { sessionId: 'd1', cwd, sessionFolder: join(dir, 'sf') })
    expect(Object.keys(launch.env).length).toBeGreaterThan(0)
    // A window that closes with no reply running ends its session.
    expect(await client.call('terminal.detach', { sessionId: 'd1' })).toEqual({ detached: false, activeRunId: null })
    await client.call('daemon.stop')
    expect(await running).toBe(0)
    await client.closed
    expect(existsSync(daemonFiles(paths.stateDir).lock)).toBe(false)
    expect(existsSync(daemonFiles(paths.stateDir).socket)).toBe(false)
  })
})

describe('the daemon version', () => {
  const folders = () => {
    const dir = base()
    const paths = { dataRoot: join(dir, 'data'), stateDir: join(dir, 'state') }
    const profile: InteractiveProfile = { version: 1, dataRoot: paths.dataRoot, stateDir: paths.stateDir, defaultVariantScope: 'default', secretBackend: { kind: 'file', path: join(paths.stateDir, 'secrets.json') } }
    return { dir, paths, profile }
  }
  const start = (folder: ReturnType<typeof folders>, options: DaemonOptions = { idleMs: null }) =>
    runDaemon(folder.paths, folder.profile, { createHarness: (given) => createHarness({ ...given, secrets: memorySecretStore() }) as Harness }, options)
  const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(check()).toBe(true)
  }
  /** Makes the running daemon look like one from another release. */
  const age = (folder: ReturnType<typeof folders>, version: string | undefined): void => {
    const lock = daemonFiles(folder.paths.stateDir).lock
    const record = JSON.parse(readFileSync(lock, 'utf8'))
    if (version === undefined) delete record.version
    else record.version = version
    writeFileSync(lock, JSON.stringify(record))
  }

  it('records its version in the lock and in its status', async () => {
    const folder = folders()
    const running = start(folder)
    await waitFor(() => daemonRecord(folder.paths.stateDir) !== null && existsSync(daemonFiles(folder.paths.stateDir).socket))
    expect(daemonRecord(folder.paths.stateDir)?.version).toBe(PACKAGE_VERSION)
    const client = await connectDaemon(folder.paths, { start: false })
    expect(await client.call('daemon.status')).toMatchObject({ version: PACKAGE_VERSION, windows: 0 })
    await client.call('daemon.stop')
    expect(await running).toBe(0)
  })

  it('replaces a daemon of another version, or one from before the version check, when nothing uses it', async () => {
    for (const old of ['0.0.1', undefined]) {
      const folder = folders()
      const first = start(folder)
      await waitFor(() => daemonRecord(folder.paths.stateDir) !== null && existsSync(daemonFiles(folder.paths.stateDir).socket))
      age(folder, old)
      let second: Promise<number> | null = null
      // The "spawned" daemon runs in this process, once the old one has gone.
      const spawn = (() => {
        second = start(folder)
        return { unref: () => undefined }
      }) as never
      const client = await connectDaemon(folder.paths, { start: true, spawn })
      expect(await first).toBe(0)
      expect(await client.call('daemon.status')).toMatchObject({ version: PACKAGE_VERSION })
      expect(daemonRecord(folder.paths.stateDir)?.version).toBe(PACKAGE_VERSION)
      await client.call('daemon.stop')
      expect(await second).toBe(0)
    }
  })

  it('does not stop an older daemon that a window or a reply still uses', async () => {
    const folder = folders()
    const running = start(folder)
    await waitFor(() => daemonRecord(folder.paths.stateDir) !== null && existsSync(daemonFiles(folder.paths.stateDir).socket))
    const window = await connectDaemon(folder.paths, { start: false })
    const cwd = join(folder.dir, 'project')
    mkdirSync(cwd)
    await window.call('terminal.prepare', { sessionId: 'busy', cwd, sessionFolder: join(folder.dir, 'sf') })
    age(folder, '0.0.1')
    const spawn = (() => { throw new Error('must not start another harness') }) as never
    await expect(connectDaemon(folder.paths, { start: true, spawn })).rejects.toMatchObject({ code: DAEMON_VERSION_MISMATCH })
    expect(daemonRecord(folder.paths.stateDir)?.pid).toBe(process.pid)
    // A window may still reattach to it, and `daemon stop` still reaches it, whatever its version.
    const again = await connectDaemon(folder.paths, { start: false, anyVersion: true })
    expect(await again.call('daemon.status')).toMatchObject({ windows: 1 })
    await again.call('daemon.stop')
    expect(await running).toBe(0)
    window.close()
  })
})

describe('the daemon idle exit', () => {
  const folders = () => {
    const dir = base()
    const paths = { dataRoot: join(dir, 'data'), stateDir: join(dir, 'state') }
    const profile: InteractiveProfile = { version: 1, dataRoot: paths.dataRoot, stateDir: paths.stateDir, defaultVariantScope: 'default', secretBackend: { kind: 'file', path: join(paths.stateDir, 'secrets.json') } }
    return { dir, paths, profile }
  }
  const start = (folder: ReturnType<typeof folders>, options: DaemonOptions) =>
    runDaemon(folder.paths, folder.profile, { createHarness: (given) => createHarness({ ...given, secrets: memorySecretStore() }) as Harness }, options)

  it('exits on its own once nothing is attached, and releases its lock and socket', async () => {
    const folder = folders()
    const code = await start(folder, { idleMs: 120, checkMs: 20 })
    expect(code).toBe(0)
    expect(existsSync(daemonFiles(folder.paths.stateDir).lock)).toBe(false)
    expect(existsSync(daemonFiles(folder.paths.stateDir).socket)).toBe(false)
  })

  it('stays up while a client is connected and a window is open, then exits when they are gone', async () => {
    const folder = folders()
    let exited = false
    const running = start(folder, { idleMs: 150, checkMs: 20 }).then((code) => { exited = true; return code })
    const client = await (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          return await connectDaemon(folder.paths, { start: false })
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      throw new Error('the daemon did not start')
    })()
    const cwd = join(folder.dir, 'project')
    mkdirSync(cwd)
    await client.call('terminal.prepare', { sessionId: 'w1', cwd, sessionFolder: join(folder.dir, 'sf') })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(exited).toBe(false)
    await client.call('terminal.detach', { sessionId: 'w1' })
    client.close()
    expect(await running).toBe(0)
  })
})

describe('a daemon a host launched', () => {
  const folder = () => {
    const dir = base()
    const paths = { dataRoot: join(dir, 'data'), stateDir: join(dir, 'state') }
    const profile: InteractiveProfile = { version: 1, dataRoot: paths.dataRoot, stateDir: paths.stateDir, defaultVariantScope: 'default', secretBackend: { kind: 'file', path: join(paths.stateDir, 'secrets.json') } }
    return { dir, paths, profile }
  }
  const launch = { hosts: true, productName: 'Host App', worktrees: { branchPrefix: 'h/' } }

  it('records its launch, lists the hosts connected to it, and is not replaced while one is', async () => {
    const f = folder()
    const running = runDaemon(f.paths, f.profile, { createHarness: (given) => createHarness({ ...given, secrets: memorySecretStore() }) as Harness }, { idleMs: null, launch })
    for (let i = 0; i < 200 && !existsSync(daemonFiles(f.paths.stateDir).socket); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(daemonRecord(f.paths.stateDir)?.config).toBe(daemonLaunchHash(launch))
    // The same launch connects; a key order that differs is the same launch.
    expect(daemonLaunchHash({ worktrees: { branchPrefix: 'h/' }, productName: 'Host App', hosts: true })).toBe(daemonLaunchHash(launch))
    const config = { file: join(f.dir, 'launch.json'), hash: daemonLaunchHash(launch) }
    const host = await connectDaemon(f.paths, { start: false, config })
    await host.call('host.register', { name: 'app', policy: true })
    expect(await host.call('daemon.status')).toMatchObject({ hosts: ['app'] })
    // Another launch is refused while the host uses this one.
    const spawn = (() => { throw new Error('must not start another harness') }) as never
    await expect(connectDaemon(f.paths, { start: true, spawn, config: { file: config.file, hash: 'another' } })).rejects.toMatchObject({ code: DAEMON_VERSION_MISMATCH })
    await host.call('daemon.stop')
    expect(await running).toBe(0)
  })

  it('is replaced by a launch that differs once no host or window uses it', async () => {
    const f = folder()
    const first = runDaemon(f.paths, f.profile, { createHarness: (given) => createHarness({ ...given, secrets: memorySecretStore() }) as Harness }, { idleMs: null })
    for (let i = 0; i < 200 && !existsSync(daemonFiles(f.paths.stateDir).socket); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    // Started with no launch options: a host that needs its own gets a new daemon.
    let second: Promise<number> | null = null
    const spawn = (() => {
      second = runDaemon(f.paths, f.profile, { createHarness: (given) => createHarness({ ...given, secrets: memorySecretStore() }) as Harness }, { idleMs: null, launch })
      return { unref: () => undefined }
    }) as never
    const client = await connectDaemon(f.paths, { start: true, spawn, config: { file: join(f.dir, 'launch.json'), hash: daemonLaunchHash(launch) } })
    expect(await first).toBe(0)
    expect(daemonRecord(f.paths.stateDir)?.config).toBe(daemonLaunchHash(launch))
    await client.call('daemon.stop')
    expect(await second).toBe(0)
  })
})

describe('when the daemon cannot serve', () => {
  const folder = (state?: string) => {
    const dir = base()
    const paths = { dataRoot: join(dir, 'data'), stateDir: state ?? join(dir, 'state') }
    const profile: InteractiveProfile = { version: 1, dataRoot: paths.dataRoot, stateDir: paths.stateDir, defaultVariantScope: 'default', secretBackend: { kind: 'file', path: join(paths.stateDir, 'secrets.json') } }
    return { dir, paths, profile }
  }
  const deep = (dir: string) => join(dir, 'a'.repeat(40), 'b'.repeat(40), 'state')
  const make = (given: HarnessOptions): Harness => createHarness({ ...given, secrets: memorySecretStore() })

  it('says a state folder is too deep for the socket, before and without starting anything', async () => {
    const f = folder()
    const stateDir = deep(f.dir)
    const spawn = (() => { throw new Error('must not start a harness it cannot reach') }) as never
    await expect(connectDaemon({ dataRoot: f.paths.dataRoot, stateDir }, { start: true, spawn })).rejects.toMatchObject({ code: 'socket_path_too_long', message: expect.stringContaining('--state') })
    await expect(runDaemon({ dataRoot: f.paths.dataRoot, stateDir }, { ...f.profile, stateDir }, { createHarness: make }, { idleMs: null })).rejects.toMatchObject({ code: 'socket_path_too_long' })
    // Reaching a daemon that is not there is still the usual refusal.
    await expect(connectDaemon({ dataRoot: f.paths.dataRoot, stateDir }, { start: false })).rejects.toMatchObject({ code: 'daemon_not_running' })
  })

  it('records a reply a dead daemon left running as interrupted when the next one starts', async () => {
    const f = folder()
    // What a killed daemon leaves behind: a run that never settled, owned by a process that is gone.
    const root = f.paths.dataRoot
    const record = runRecordSchema.parse({ id: 'run-killed', sessionId: 'terminal-1', projectId: null, mode: 'code', harness: 'pi', sessionType: 'terminal', nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: null, status: 'running', startedAt: 'start', endedAt: null })
    mkdirSync(join(root, 'runs'), { recursive: true })
    saveRun(root, record)
    appendEvent(root, { id: 'e0', runId: 'run-killed', sessionId: 'terminal-1', sequence: 0, timestamp: 't', type: 'started', payload: {} })
    writeFileSync(join(root, 'runs', 'run-killed', 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 54321 }))
    const running = runDaemon(f.paths, f.profile, { createHarness: make }, { idleMs: null })
    for (let i = 0; i < 200 && !existsSync(daemonFiles(f.paths.stateDir).socket); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(loadRun(root, 'run-killed').status).toBe('interrupted')
    const client = await connectDaemon(f.paths, { start: false })
    await client.call('daemon.stop')
    expect(await running).toBe(0)
  })

  it('refuses to attach a window to a session another window holds', async () => {
    const f = folder()
    const running = runDaemon(f.paths, f.profile, { createHarness: make }, { idleMs: null })
    for (let i = 0; i < 200 && !existsSync(daemonFiles(f.paths.stateDir).socket); i++) await new Promise((resolve) => setTimeout(resolve, 25))
    const first = await connectDaemon(f.paths, { start: false })
    const second = await connectDaemon(f.paths, { start: false })
    const cwd = join(f.dir, 'project')
    mkdirSync(cwd)
    const sessionFolder = join(f.dir, 'sf')
    await first.call('terminal.prepare', { sessionId: 'held', cwd, sessionFolder })
    // Only a session whose window closed during a reply can be attached; this one has a window.
    await expect(second.call('terminal.prepare', { sessionId: 'held', cwd, sessionFolder, attach: true })).rejects.toMatchObject({ code: 'not_found' })
    expect(await first.call('daemon.status')).toMatchObject({ windows: 1 })
    await first.call('terminal.detach', { sessionId: 'held' })
    await first.call('daemon.stop')
    expect(await running).toBe(0)
    second.close()
  })
})
