// The long-lived harness (ADR-0083, phase 3): one per state folder, serving the protocol on a socket.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { InteractiveProfile } from '../core/interactiveProfile'
import { connectHarness, serveSocket } from '../server/socket'
import { acquireDaemonLock, connectDaemon, daemonFiles, daemonRecord, runDaemon } from './daemon'

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
