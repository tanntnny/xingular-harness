// Hosts that connect to a shared harness over its socket (page 10): what each supplies is routed to
// the sessions it started, and nobody else's.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from '../sessions/contracts'
import type { PiEvent, PiSessionLike, SessionFactory } from '../sessions/runner'
import type { ToolSession } from '../tools/types'
import { HostHub } from './hostHub'
import { connectHarness, serveSocket, type HarnessClient, type SocketServer } from './socket'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const factory = (): SessionFactory => async () => {
  let listener: (event: PiEvent) => void = () => undefined
  const session: PiSessionLike = {
    sessionId: 'native',
    subscribe: (fn) => { listener = fn; return () => undefined },
    prompt: async (text) => {
      listener({ type: 'message_start', message: { role: 'assistant' } })
      listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] } })
    },
    sendCustomMessage: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined
  }
  return session
}

async function start(hubOptions: Partial<ConstructorParameters<typeof HostHub>[0]> = {}): Promise<{ harness: Harness; hub: HostHub; server: SocketServer; connect: () => Promise<HarnessClient> }> {
  // A short folder: a Unix socket path has a small length limit.
  const dir = mkdtempSync(join(tmpdir(), 'hh-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const harness = createHarness({ dataRoot: join(dir, 'data'), stateDir: join(dir, 'state'), secrets: memorySecretStore(), sessionFactory: factory() })
  cleanup.push(() => harness.close())
  mkdirSync(join(dir, 'state'), { recursive: true })
  harness.accounts.create('Main', 'apiKey')
  const hub = new HostHub({ root: () => harness.env.root, awayMs: 0, ...hubOptions })
  const server = await serveSocket(harness, join(dir, 'state', 'h.sock'), {}, { hub })
  cleanup.push(() => server.close())
  const clients: HarnessClient[] = []
  cleanup.push(() => clients.forEach((client) => client.close()))
  return { harness, hub, server, connect: async () => { const client = await connectHarness(server.path); clients.push(client); return client } }
}

const run = (client: HarnessClient, sessionId: string, root: string) =>
  client.call('sessions.run', { run: { id: `${sessionId}-run`, sessionId }, cwd: root, sessionDir: join(root, 'sessions', sessionId), text: 'hi', caller: { agentId: 'a', agentName: 'A', actor: 'Chat' }, tools: { allow: ['read'] } })

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await tick(10)
}
const events = (client: HarnessClient): RunEvent[] => {
  const seen: RunEvent[] = []
  client.onMessage((message) => { if (message.event) seen.push(message.event as RunEvent) })
  return seen
}

describe('a host on the shared harness', () => {
  it('needs a name to register', async () => {
    const { connect } = await start()
    const client = await connect()
    await expect(client.call('host.register', {})).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('hears the events of its own sessions only, while a plain client hears all', async () => {
    const { harness, connect } = await start()
    const first = await connect()
    const second = await connect()
    const plain = await connect()
    await first.call('host.register', { name: 'first' })
    await second.call('host.register', { name: 'second' })
    const heardFirst = events(first)
    const heardSecond = events(second)
    const heardPlain = events(plain)
    await run(first, 's1', harness.env.root)
    await run(second, 's2', harness.env.root)
    await until(() => heardFirst.some((event) => event.type === 'completed') && heardSecond.some((event) => event.type === 'completed'))
    expect(new Set(heardFirst.map((event) => event.sessionId))).toEqual(new Set(['s1']))
    expect(new Set(heardSecond.map((event) => event.sessionId))).toEqual(new Set(['s2']))
    expect(new Set(heardPlain.map((event) => event.sessionId))).toEqual(new Set(['s1', 's2']))
  })

  it('gives a host its sessions back when it reconnects under the same name', async () => {
    const { harness, connect, hub } = await start()
    const first = await connect()
    await first.call('host.register', { name: 'app' })
    await run(first, 's1', harness.env.root)
    first.close()
    await first.closed
    await until(() => hub.hostNames().length === 0)
    const again = await connect()
    expect(await again.call('host.register', { name: 'app' })).toEqual({ name: 'app', resumed: ['s1'] })
    expect(hub.ownerOf('s1')).toBe('app')
  })

  it('asks the host that started a run, and gates nobody else\'s runs', async () => {
    const { harness, connect, hub } = await start()
    const host = await connect()
    const asked: Array<Record<string, unknown>> = []
    host.handle('policy.scope', (params) => { asked.push(params); return { allowed: false, reason: 'the host says no' } })
    host.handle('policy.authorize', () => { throw new Error('tool switched off') })
    await host.call('host.register', { name: 'app', policy: true })
    await run(host, 'owned', harness.env.root)
    const call = (sessionId: string) => ({ run: { id: `${sessionId}-run`, sessionId, mode: 'chat' }, caller: {}, tool: 'bash', args: { command: 'ls' } }) as never
    await expect(hub.policy.scope!(call('owned'))).resolves.toEqual({ allowed: false, reason: 'the host says no' })
    expect(asked[0]).toMatchObject({ runId: 'owned-run', sessionId: 'owned', mode: 'chat', tool: 'bash' })
    await expect(hub.policy.authorize!(call('owned'))).rejects.toMatchObject({ message: expect.stringContaining('tool switched off') })
    // A terminal's session has no host: no host's policy applies.
    await expect(hub.policy.scope!(call('terminal'))).resolves.toEqual({ allowed: true })
    await expect(hub.policy.authorize!(call('terminal'))).resolves.toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(await hub.policy.connections!({ sessionId: 'terminal', runId: null, caller: {}, connectionIds: ['x'] })).toEqual(['x'])
    // The host goes away: its sessions are not run ungated, and nothing is approved on its behalf.
    host.close()
    await host.closed
    await until(() => hub.hostNames().length === 0)
    await expect(hub.policy.scope!(call('owned'))).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(await hub.policy.approval!({ run: { id: 'owned-run', sessionId: 'owned' } as never, target: 'x' })).toEqual({ unattended: true })
    expect(await hub.policy.connections!({ sessionId: 'owned', runId: null, caller: {}, connectionIds: ['x'] })).toEqual([])
  })

  it('serves credentials from the connected host, and refuses when there is none', async () => {
    const { connect, hub } = await start()
    await expect(hub.secrets.get('k')).rejects.toMatchObject({ code: 'host_unavailable' })
    const host = await connect()
    const kept = new Map<string, string>([['k', 'v']])
    host.handle('secrets.get', (params) => kept.get(params.key) ?? null)
    host.handle('secrets.set', (params) => void kept.set(params.key, params.value))
    await host.call('host.register', { name: 'app', secrets: true })
    expect(await hub.secrets.get('k')).toBe('v')
    await hub.secrets.set('n', 'w')
    expect(kept.get('n')).toBe('w')
  })

  it('offers a host\'s tools to its own sessions only, and runs them on the host', async () => {
    const { harness, connect, hub } = await start()
    const host = await connect()
    const called: Array<Record<string, unknown>> = []
    host.handle('tools.call', (params) => { called.push(params); return 'did it' })
    await host.call('host.register', { name: 'app', tools: true })
    await host.call('tools.register', { tools: [{ name: 'react', description: 'React', parameters: { type: 'object', properties: {} } }] })
    await run(host, 'owned', harness.env.root)
    const session = (sessionId: string) => ({ run: { runId: `${sessionId}-run`, sessionId }, caller: {}, allow: ['react'], depth: 0, cwd: '/tmp' }) as unknown as ToolSession
    const specs = await hub.tools(session('owned'))
    expect(specs.map((spec) => spec.name)).toEqual(['react'])
    expect(await specs[0].execute({})).toBe('did it')
    expect(called[0]).toMatchObject({ name: 'react', runId: 'owned-run', sessionId: 'owned' })
    expect(await hub.tools(session('terminal'))).toEqual([])
  })

  it('merges the names hosts push, and offers a host\'s broker tools through it', async () => {
    const { harness, connect, hub } = await start()
    const host = await connect()
    host.handle('broker.list', () => [{ name: 'files_read', description: 'Read a file' }])
    host.handle('broker.call', (params) => ({ called: params.name, by: params.session.sessionId }))
    host.handle('broker.revision', () => 7)
    await host.call('host.register', { name: 'app', directory: true, broker: { names: ['files_read'], note: 'The app lists the rest.' } })
    await host.call('directory.set', { agents: { a1: 'Helper' }, sessions: { s1: 'a1' } })
    expect(hub.directory.agentName('a1')).toBe('Helper')
    expect(hub.directory.sessionAgent('s1')).toBe('a1')
    expect(hub.directory.agentName('nobody')).toBeNull()
    await run(host, 'owned', harness.env.root)
    const broker = (sessionId: string) => ({ token: 't', sessionId, runId: null, caller: {}, readOnly: false, depth: 0 }) as never
    expect(hub.broker.has('files_read')).toBe(true)
    expect(hub.broker.has('other')).toBe(false)
    expect(hub.broker.discoveryNote).toBe('The app lists the rest.')
    expect(await hub.broker.list(broker('owned'))).toEqual([{ name: 'files_read', description: 'Read a file' }])
    expect(await hub.broker.call(broker('owned'), 'files_read', {})).toEqual({ called: 'files_read', by: 'owned' })
    expect(await hub.broker.revision!(broker('owned'))).toBe(7)
    expect(await hub.broker.list(broker('terminal'))).toEqual([])
    await expect(hub.broker.call(broker('terminal'), 'files_read', {})).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('does not reopen a data root that is already open', async () => {
    const { harness, connect } = await start()
    const client = await connect()
    const before = harness.recovery
    expect(await client.call('harness.open', { dataRoot: harness.dataRoot! })).toEqual(before)
  })

  it('waits for a host that is briefly away, and fails only when it stays away', async () => {
    const { connect, hub } = await start({ awayMs: 3000 })
    const reading = hub.secrets.get('k')
    await tick(100)
    const host = await connect()
    host.handle('secrets.get', () => 'back')
    await host.call('host.register', { name: 'app', secrets: true })
    expect(await reading).toBe('back')
    const { hub: stays } = await start({ awayMs: 150 })
    const started = Date.now()
    await expect(stays.secrets.get('k')).rejects.toMatchObject({ code: 'host_unavailable' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(120)
  })

  it('gives a host the sessions its calls start, whatever started them', async () => {
    const { connect, hub } = await start()
    const host = await connect()
    await host.call('host.register', { name: 'app' })
    const peer = [...(hub as unknown as { byPeer: Map<object, unknown> }).byPeer.keys()][0] as never
    hub.claimFromCall('outside')
    expect(hub.ownerOf('outside')).toBeNull()
    hub.origin.run(peer, () => hub.claimFromCall('side-question'))
    expect(hub.ownerOf('side-question')).toBe('app')
  })

  it('forgets the least recently used owner first, and keeps a session that is in use', async () => {
    const { connect, hub } = await start({ ownerLimit: 3 })
    const host = await connect()
    await host.call('host.register', { name: 'app' })
    const peer = [...(hub as unknown as { byPeer: Map<object, unknown> }).byPeer.keys()][0] as never
    for (const id of ['a', 'b', 'c']) hub.claim(peer, id)
    expect(hub.ownerOf('a')).toBe('app')
    hub.claim(peer, 'd')
    expect(hub.ownerOf('a')).toBe('app')
    expect(hub.ownerOf('b')).toBeNull()
  })

  it('sends a sign-in link only to the call that asked for it', async () => {
    const { connect, hub } = await start()
    const host = await connect()
    const plain = await connect()
    await host.call('host.register', { name: 'app' })
    const peers = (hub as unknown as { byPeer: Map<object, unknown> }).byPeer
    const hostPeer = [...peers.keys()][0] as never
    const otherPeer = {} as never
    const notice = { type: 'connections.openUrl' }
    // A host's call: only that host. A call no host made: the clients that are not hosts.
    expect(hub.origin.run(hostPeer, () => hub.deliverNotice(hostPeer, notice))).toBe(true)
    expect(hub.origin.run(hostPeer, () => hub.deliverNotice(otherPeer, notice))).toBe(false)
    expect(hub.deliverNotice(hostPeer, notice)).toBe(false)
    expect(hub.deliverNotice(otherPeer, notice)).toBe(true)
    // Everything else goes to everyone.
    expect(hub.deliverNotice(hostPeer, { type: 'plugins.changed' })).toBe(true)
    plain.close()
  })
})
