import { get, request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../sessions/contracts'
import type { RemoteAddress } from './addresses'
import { decode, open, seal } from './seal'
import { RemoteControl, checkPrompt, projectEvent, projectRequest, type RemoteSessionPort } from './service'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
const LAN: RemoteAddress = { kind: 'lan', address: '192.168.1.20', family: 'IPv4', interface: 'en0' }

let sequence = 0
const event = (type: RunEvent['type'], payload: unknown, runId = 'run-1'): RunEvent => ({
  id: `e${++sequence}`, runId, sessionId: 'session-1', sequence, timestamp: new Date(0).toISOString(), type, payload
})

function session() {
  const listeners = new Set<(event: RunEvent) => void>()
  let revision = 1
  let requests: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  const control = vi.fn(async (call: string, params: Record<string, unknown>): Promise<unknown> => {
    if (call === 'terminal.pending.wait') {
      if (params.revision === revision) await new Promise<void>((resolve) => { waiters.add(resolve); setTimeout(resolve, 200) })
      return { revision, requests }
    }
    return {}
  })
  const port: RemoteSessionPort = {
    sessionId: 'session-1',
    title: () => 'project',
    send: vi.fn(async () => ({ runId: 'run-2' })),
    control,
    history: () => [
      event('message.completed', { messageId: 'u1', role: 'user', text: 'Fix the login redirect' }),
      event('context.snapshot', { systemPrompt: 'secret instructions', tools: [] }),
      event('message.delta', { messageId: 'a1', text: 'Look' }),
      event('message.completed', { messageId: 'a1', role: 'assistant', text: 'Looking at it.' })
    ],
    listen: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    state: () => ({ ready: true, active: false })
  }
  return {
    port,
    control,
    emit: (value: RunEvent) => { for (const listener of listeners) listener(value) },
    pend: (next: Record<string, unknown>[]) => {
      requests = next
      revision += 1
      for (const wake of waiters) wake()
      waiters.clear()
    }
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

interface Phone {
  base: string
  deviceId: string
  key: Uint8Array
  n: number
  call(method: string, params?: Record<string, unknown>): Promise<any>
}

async function pairPhone(remote: RemoteControl): Promise<Phone> {
  const url = new URL(remote.status().url!)
  const base = url.origin
  const [pairingId, linkKey] = url.hash.slice(1).split('.')
  const key = decode(linkKey!)
  const hello = post(base, '/rc/hello', { p: pairingId, f: seal(key, 1, { userAgent: IPHONE }) })
  await vi.waitFor(() => expect(remote.status().request).not.toBeNull())
  remote.confirm(remote.status().request!.id, true)
  const reply = await hello
  expect(reply.status).toBe(200)
  const paired = open<{ deviceId: string; deviceKey: string }>(key, reply.body.f, () => true).body
  const phone: Phone = {
    base,
    deviceId: paired.deviceId,
    key: decode(paired.deviceKey),
    n: 0,
    async call(method, params = {}) {
      phone.n += 1
      const response = await post(base, '/rc/call', { d: phone.deviceId, f: seal(phone.key, phone.n, { id: phone.n, method, params }) })
      if (response.body.error) throw new Error(response.body.error.message)
      const body = open<{ id: number; result?: unknown; error?: { message: string } }>(phone.key, response.body.f, () => true).body
      if (body.error) throw new Error(body.error.message)
      return body.result
    }
  }
  return phone
}

function listen(phone: Phone) {
  const messages: any[] = []
  phone.n += 1
  const url = `${phone.base}/rc/events?d=${encodeURIComponent(phone.deviceId)}&f=${seal(phone.key, phone.n, { open: true })}`
  let buffer = ''
  const request = get(url, (response) => {
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith('data: ')) messages.push(open(phone.key, block.slice(6), () => true).body)
        end = buffer.indexOf('\n\n')
      }
    })
  })
  request.on('error', () => undefined)
  return { messages, close: () => request.destroy() }
}

const remotes: RemoteControl[] = []
function remoteControl(port: RemoteSessionPort): RemoteControl {
  const remote = new RemoteControl(port, { addresses: () => [LAN], bindHost: '127.0.0.1', productName: 'Acme <Agent>' })
  remotes.push(remote)
  return remote
}

afterEach(async () => {
  await Promise.all(remotes.splice(0).map((remote) => remote.dispose()))
})

describe('remote control', () => {
  it('keeps only what the phone shows from run events and decisions', () => {
    expect(projectEvent(event('context.snapshot', { systemPrompt: 'x' }))).toBeNull()
    expect(projectEvent(event('tool.started', { toolCallId: 't1', name: 'bash', summary: 'npm test', input: 'secret input' }))).toEqual({ kind: 'tool', runId: 'run-1', id: 't1', name: 'bash', phase: 'start', summary: 'npm test' })
    expect(projectEvent(event('status.changed', { status: 'interrupted' }))).toEqual({ kind: 'run', runId: 'run-1', status: 'interrupted' })
    const action = `Run outside the workspace.\n\nCommand:\n${'x'.repeat(10_000)}`
    expect(projectRequest({ type: 'approval', requestId: 'a1', target: 'workspace-write', action, operation: { args: { secret: true } } })).toMatchObject({ type: 'approval', action })
    expect(projectRequest({ type: 'approval', requestId: 'a1', action })).not.toHaveProperty('operation')
  })

  it('refuses commands and shell escapes from the phone', () => {
    expect(() => checkPrompt('/help')).toThrow('only at the terminal')
    expect(() => checkPrompt('  !rm -rf /')).toThrow('only at the terminal')
    expect(() => checkPrompt('   ')).toThrow('empty')
    expect(checkPrompt('Run the tests')).toBe('Run the tests')
  })

  it('serves the page, pairs a phone after confirmation, and answers its calls', async () => {
    const fake = session()
    const remote = remoteControl(fake.port)
    const status = await remote.start()
    expect(status.running).toBe(true)
    expect(status.kind).toBe('lan')
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[\w-]+\.[\w-]+$/)

    const page = await fetch(new URL(status.url!).origin + '/')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain('/nacl.js')
    expect(html).toContain('<title>Acme &#60;Agent&#62;</title>')
    expect((await fetch(new URL(status.url!).origin + '/nacl.js')).status).toBe(200)

    const phone = await pairPhone(remote)
    expect(remote.status().devices).toEqual([{ id: phone.deviceId, label: 'iPhone · Safari', connected: false }])
    expect(remote.status().url).not.toBe(status.url)

    const snapshot = await phone.call('snapshot')
    expect(snapshot.title).toBe('project')
    expect(snapshot.events).toEqual([
      { kind: 'message', runId: 'run-1', messageId: 'u1', role: 'user', text: 'Fix the login redirect' },
      { kind: 'message', runId: 'run-1', messageId: 'a1', role: 'assistant', text: 'Looking at it.' }
    ])

    await expect(phone.call('send', { text: '/accounts' })).rejects.toThrow('only at the terminal')
    expect(await phone.call('send', { text: 'Run the tests' })).toEqual({ runId: 'run-2' })
    expect(fake.port.send).toHaveBeenCalledWith('Run the tests')
    await phone.call('interrupt')
    expect(fake.control).toHaveBeenCalledWith('terminal.interrupt', {})
    await phone.call('approve', { requestId: 'a1', decision: 'approved' })
    expect(fake.control).toHaveBeenCalledWith('terminal.approve', { requestId: 'a1', decision: 'approved', alwaysAllow: false })
    await phone.call('answers', { batchId: 'b1', answers: [{ questionId: 'q1', answer: { selected: ['Yes'] } }] })
    expect(fake.control).toHaveBeenCalledWith('terminal.answers', { batchId: 'b1', answers: [{ questionId: 'q1', answer: { selected: ['Yes'] } }] })
    await expect(phone.call('links.open', { url: 'https://example.com' })).rejects.toThrow('does not offer')
  })

  it('refuses a replayed call, an unknown device, a wrong Host and a denied pairing', async () => {
    const fake = session()
    const remote = remoteControl(fake.port)
    await remote.start()
    const phone = await pairPhone(remote)
    const body = { d: phone.deviceId, f: seal(phone.key, 99, { id: 1, method: 'interrupt', params: {} }) }
    expect((await post(phone.base, '/rc/call', body)).status).toBe(200)
    expect((await post(phone.base, '/rc/call', body)).status).toBe(401)
    expect((await post(phone.base, '/rc/call', { d: 'nobody', f: body.f })).status).toBe(401)

    const port = new URL(phone.base).port
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: `attacker.example:${port}` } }, (response) => { response.resume(); resolve(response.statusCode!) })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(421)

    const url = new URL(remote.status().url!)
    const [pairingId, linkKey] = url.hash.slice(1).split('.')
    const hello = post(phone.base, '/rc/hello', { p: pairingId, f: seal(decode(linkKey!), 1, { userAgent: IPHONE }) })
    await vi.waitFor(() => expect(remote.status().request).not.toBeNull())
    remote.confirm(remote.status().request!.id, false)
    expect((await hello).status).toBe(403)
  })

  it('streams run events and decisions, and tells the phone when remote control stops', async () => {
    const fake = session()
    const remote = remoteControl(fake.port)
    await remote.start()
    const phone = await pairPhone(remote)
    const stream = listen(phone)
    try {
      await vi.waitFor(() => expect(remote.status().devices[0]?.connected).toBe(true))
      await vi.waitFor(() => expect(stream.messages[0]).toEqual({ type: 'pending', requests: [] }))
      fake.emit(event('message.delta', { messageId: 'a2', text: 'Hel' }))
      await vi.waitFor(() => expect(stream.messages).toContainEqual({ type: 'event', event: { kind: 'delta', runId: 'run-1', messageId: 'a2', text: 'Hel' } }))
      fake.pend([{ type: 'approval', requestId: 'a9', runId: 'run-1', target: 'bash', action: '{"command":"npm test"}', rememberable: true }])
      await vi.waitFor(() => expect(stream.messages.some((message) => message.type === 'pending' && message.requests[0]?.requestId === 'a9')).toBe(true))
      await remote.stop()
      await vi.waitFor(() => expect(stream.messages.at(-1)).toEqual({ type: 'ended' }))
      expect(remote.status()).toMatchObject({ running: false, url: null, devices: [] })
    } finally {
      stream.close()
    }
  })

  it('cannot start again once its terminal session ended', async () => {
    const remote = remoteControl(session().port)
    await remote.start()
    await remote.dispose()
    await expect(remote.start()).rejects.toThrow('terminal has ended')
  })
})
