// Remote control of a host's live session (PAR-018, page 15): one pairing per conversation, shared by
// a terminal window and a host's chat, ending with the live session and not with a window.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from '../sessions/contracts'
import type { PiEvent, PiSessionLike, SessionFactory } from '../sessions/runner'
import { methods } from '../server/methods'
import type { RemoteAddress } from './addresses'
import type { RemoteSessionPort } from './service'
import { SwitchablePort } from './sessionRemotes'

const LAN: RemoteAddress = { kind: 'lan', address: '192.168.1.20', family: 'IPv4', interface: 'en0' }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await tick(10)
}

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

/** A reusable fake Pi session whose replies echo the prompt. */
function factory(): SessionFactory {
  let count = 0
  return async () => {
    let listener: (event: PiEvent) => void = () => undefined
    const session: PiSessionLike = {
      sessionId: `native-${++count}`,
      subscribe: (fn) => { listener = fn; return () => { listener = () => undefined } },
      prompt: async (text) => {
        listener({ type: 'message_start', message: { role: 'assistant' } })
        listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] } })
      },
      sendCustomMessage: async () => undefined,
      abort: async () => undefined,
      dispose: () => undefined,
      rebind: async () => undefined
    }
    return session
  }
}

function setup() {
  const harness = createHarness({
    dataRoot: mkdtempSync(join(tmpdir(), 'rs-data-')), stateDir: mkdtempSync(join(tmpdir(), 'rs-state-')), secrets: memorySecretStore(),
    sessionFactory: factory(), remoteControl: { addresses: () => [LAN], bindHost: '127.0.0.1' }
  })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const sessionDir = join(harness.env.root, 'sessions', 'agent-1')
  const run = (id: string, extra: Record<string, unknown> = {}) =>
    harness.sessions.run({ run: { id, sessionId: 'agent-1' }, cwd: harness.env.root, sessionDir, text: `hello ${id}`, caller: { agentId: 'agent-1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] }, live: true, ...extra })
  const table = methods(harness)
  // The server awaits a handler, so a synchronous refusal reaches a caller as a rejection.
  const call = new Proxy({} as Record<string, (params: Record<string, unknown>) => Promise<unknown>>, { get: (_, name: string) => async (params: Record<string, unknown>) => table[name](params) })
  return { harness, run, call }
}

describe('remote control of a live session', () => {
  it('needs a live session, then pairs through the host methods', async () => {
    const { harness, run, call } = setup()
    await expect(call['sessions.remoteControl.start']({ sessionId: 'agent-1' })).rejects.toMatchObject({ code: 'not_found' })
    await run('r1')
    await tick()
    await expect(call['sessions.remoteControl.start']({ sessionId: 'agent-1', interface: 'everywhere' })).rejects.toThrow('auto, tailscale or lan')
    const started = await call['sessions.remoteControl.start']({ sessionId: 'agent-1' }) as { running: boolean; url: string }
    expect(started).toMatchObject({ running: true })
    expect(started.url).toMatch(/^http:\/\/[\d.]+:\d+\/#/)
    expect(await call['sessions.remoteControl.status']({ sessionId: 'agent-1' })).toMatchObject({ running: true, devices: [] })
    // One pairing per live session: asking again is the same pairing.
    expect(harness.remotes.forLive('agent-1')).toBe(harness.remotes.forLive('agent-1'))
    await expect(call['sessions.remoteControl.confirm']({ sessionId: 'agent-1', requestId: 'r', allow: 'yes' })).rejects.toThrow('boolean choice')
    expect(await call['sessions.remoteControl.stop']({ sessionId: 'agent-1' })).toMatchObject({ running: false })
  })

  it('ends with the live session, not at a pin change', async () => {
    const { harness, run, call } = setup()
    await run('r1')
    await tick()
    await call['sessions.remoteControl.start']({ sessionId: 'agent-1' })
    const remote = harness.remotes.forLive('agent-1')!
    // A changed model opens a new Pi session on the same conversation; the phone stays paired.
    await run('r2', { model: 'other/model' })
    await tick()
    expect(harness.remotes.has('agent-1')).toBe(true)
    expect(remote.status().running).toBe(true)
    // The host closes the conversation: the server stops and the pairing is gone.
    harness.sessions.closeLive('agent-1')
    await until(() => !harness.remotes.has('agent-1'))
    expect(harness.remotes.has('agent-1')).toBe(false)
    expect(remote.status().running).toBe(false)
  })

  it('serves a phone from the session alone: history, a message, and refused stale decisions', async () => {
    const { harness, run } = setup()
    await run('r1')
    await tick()
    const port = harness.remotes.livePort('agent-1')
    expect(port.state()).toEqual({ ready: true, active: false })
    expect(port.history().some((event) => event.type === 'message.completed' && (event.payload as { text?: string }).text === 'reply to hello r1')).toBe(true)
    const seen: RunEvent[] = []
    const stop = port.listen((event) => void seen.push(event))
    // The harness runs the message as the next reply of the conversation.
    const sent = await port.send('and more')
    expect(sent.runId).toBeTruthy()
    await until(() => seen.some((event) => event.type === 'completed' && event.runId === sent.runId))
    expect(seen.some((event) => event.type === 'message.completed' && (event.payload as { text?: string }).text === 'reply to and more')).toBe(true)
    stop()
    expect(await port.control('terminal.pending.wait', { revision: -1 })).toEqual({ revision: expect.any(Number), requests: [] })
    await expect(port.control('terminal.approve', { requestId: 'nope', decision: 'approved' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(port.control('terminal.answer', { requestId: 'nope', answer: 'x' })).rejects.toMatchObject({ code: 'invalid_request' })
    port.close?.()
  })

  it('keeps a terminal window\'s pairing through its live session closing, and ends it with the window', async () => {
    const { harness, run } = setup()
    await run('r1')
    await tick()
    const fake: RemoteSessionPort = {
      sessionId: 'agent-1', title: () => 't', send: async () => ({ runId: 'x' }), control: async () => ({}),
      history: () => [], listen: () => () => undefined, state: () => ({ ready: true, active: false })
    }
    const binding = {}
    const control = harness.remotes.open('agent-1', 'terminal', binding, () => fake)
    expect(harness.remotes.open('agent-1', 'terminal', binding, () => { throw new Error('same binding is not made twice') })).toBe(control)
    // `/new` in a terminal closes its live session; the window and its pairing go on.
    harness.sessions.closeLive('agent-1')
    await tick(50)
    expect(harness.remotes.has('agent-1')).toBe(true)
    await harness.remotes.end('agent-1')
    expect(harness.remotes.has('agent-1')).toBe(false)
  })

  it('moves a pairing to the live session when its window closes during a reply', async () => {
    const { harness, run } = setup()
    await run('r1')
    await tick()
    const terminalPort: RemoteSessionPort = {
      sessionId: 'agent-1', title: () => 'terminal', send: async () => ({ runId: 'x' }), control: async () => ({}),
      history: () => [], listen: () => () => undefined, state: () => ({ ready: true, active: true }), close: vi.fn()
    }
    const control = harness.remotes.open('agent-1', 'terminal', {}, () => terminalPort)
    harness.remotes.keepLive('agent-1')
    expect(terminalPort.close).toHaveBeenCalled()
    expect(harness.remotes.forLive('agent-1')).toBe(control)
    // The window is gone, and the live session still ends the pairing's life with the conversation's run.
    expect(control.status()).toMatchObject({ running: false })
  })
})

describe('a port that can change its backing', () => {
  const backing = (name: string) => {
    const listeners = new Set<(event: RunEvent) => void>()
    const port: RemoteSessionPort = {
      sessionId: 's', title: () => name, send: async () => ({ runId: name }), control: async () => name,
      history: () => [], listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, state: () => ({ ready: true, active: false }), close: vi.fn()
    }
    return { port, listeners, emit: (event: RunEvent) => { for (const fn of listeners) fn(event) } }
  }

  it('sends calls and events through the new backing after a switch', async () => {
    const first = backing('first')
    const second = backing('second')
    const port = new SwitchablePort('s', first.port)
    const seen: string[] = []
    port.listen((event) => void seen.push(event.id))
    expect(port.title()).toBe('first')
    port.rebind(second.port)
    expect(first.port.close).toHaveBeenCalled()
    expect(first.listeners.size).toBe(0)
    expect(second.listeners.size).toBe(1)
    expect(port.title()).toBe('second')
    expect((await port.send('x')).runId).toBe('second')
    second.emit({ id: 'e1' } as RunEvent)
    expect(seen).toEqual(['e1'])
    port.close()
    expect(second.listeners.size).toBe(0)
  })
})
