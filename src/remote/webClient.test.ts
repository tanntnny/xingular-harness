// Runs the phone page's script in a small DOM against a real remote-control server, as a phone's
// browser would: pairing, the transcript, streaming, an approval card and sending a message.
import { get, type ClientRequest } from 'node:http'
import { parseHTML } from 'linkedom'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../sessions/contracts'
import { RemoteControl, type RemoteSessionPort } from './service'
import { PAGE_JS, pageHtml } from './webClient'

let sequence = 0
const event = (type: RunEvent['type'], payload: unknown): RunEvent => ({
  id: `e${++sequence}`, runId: 'run-1', sessionId: 'session-1', sequence, timestamp: new Date(0).toISOString(), type, payload
})

const remotes: RemoteControl[] = []
const sources: Array<{ close(): void }> = []
afterEach(async () => {
  for (const source of sources.splice(0)) source.close()
  await Promise.all(remotes.splice(0).map((remote) => remote.dispose()))
})

function fakeSession() {
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
    title: () => 'checkout',
    send: vi.fn(async () => ({ runId: 'run-2' })),
    control,
    history: () => [event('message.completed', { messageId: 'u1', role: 'user', text: 'Fix the login redirect' })],
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

/** The page's browser: its DOM, storage, fetch and EventSource, all aimed at the server. */
function browser(url: string) {
  const target = new URL(url)
  const { window, document } = parseHTML(pageHtml('Test Product'))
  const storage = new Map<string, string>()
  const location = { hash: target.hash, host: target.host, pathname: '/' }
  const history = { replaceState: (_state: unknown, _title: string, path: string) => { location.hash = ''; location.pathname = path } }
  class EventSource {
    onopen: (() => void) | null = null
    onmessage: ((message: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    private readonly request: ClientRequest
    constructor(path: string) {
      let buffer = ''
      this.request = get(target.origin + path, (response) => {
        this.onopen?.()
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          let end = buffer.indexOf('\n\n')
          while (end >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (block.startsWith('data: ')) this.onmessage?.({ data: block.slice(6) })
            end = buffer.indexOf('\n\n')
          }
        })
      })
      this.request.on('error', () => this.onerror?.())
      sources.push(this)
    }
    close() { this.request.destroy() }
  }
  Object.assign(window, { nacl })
  const run = new Function('window', 'document', 'location', 'history', 'localStorage', 'fetch', 'EventSource', 'navigator', PAGE_JS)
  run(
    window, document, location, history,
    { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    (path: string, init: RequestInit) => fetch(target.origin + path, init),
    EventSource,
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1' }
  )
  return { document, storage, location }
}

describe('the phone page', () => {
  it('pairs, shows the session, streams a reply, answers an approval and sends a message', async () => {
    const fake = fakeSession()
    const remote = new RemoteControl(fake.port, { addresses: () => [{ kind: 'lan', address: '192.168.1.20', family: 'IPv4', interface: 'en0' }], bindHost: '127.0.0.1' })
    remotes.push(remote)
    const status = await remote.start()
    const phone = browser(status.url!)
    const text = (id: string) => phone.document.getElementById(id)!.textContent ?? ''

    await vi.waitFor(() => expect(remote.status().request?.label).toBe('iPhone · Safari'))
    expect(text('coverTitle')).toBe('Waiting for approval')
    remote.confirm(remote.status().request!.id, true)

    await vi.waitFor(() => expect(text('log')).toContain('Fix the login redirect'))
    expect(text('title')).toBe('checkout')
    expect(phone.location.hash).toBe('')
    expect([...phone.storage.values()][0]).toContain('deviceKey')
    await vi.waitFor(() => expect(remote.status().devices[0]?.connected).toBe(true))

    fake.emit(event('message.delta', { messageId: 'a1', text: 'Look' }))
    await vi.waitFor(() => expect(text('log')).toContain('Look'))
    fake.emit(event('message.completed', { messageId: 'a1', role: 'assistant', text: 'Looking at the redirect.' }))
    fake.emit(event('message.delta', { messageId: 'a1', text: ' late' }))
    await vi.waitFor(() => expect(text('log')).toContain('Looking at the redirect.'))
    expect(text('log')).not.toContain('late')

    // Model text is shown as text, never as markup.
    fake.emit(event('message.completed', { messageId: 'a2', role: 'assistant', text: '<img src=x onerror=alert(1)>' }))
    await vi.waitFor(() => expect(text('log')).toContain('<img src=x'))
    expect(phone.document.getElementById('log')!.querySelector('img')).toBeNull()

    fake.pend([{ type: 'approval', requestId: 'a9', runId: 'run-1', target: 'bash', action: '{"command":"npm test"}', rememberable: false }])
    await vi.waitFor(() => expect(text('cards')).toContain('Approve bash?'))
    expect(text('cards')).toContain('{"command":"npm test"}')
    const allow = [...phone.document.querySelectorAll('#cards button')].find((button) => button.textContent === 'Allow once') as unknown as { click(): void }
    allow.click()
    await vi.waitFor(() => expect(fake.control).toHaveBeenCalledWith('terminal.approve', { requestId: 'a9', decision: 'approved', alwaysAllow: false }))

    const input = phone.document.getElementById('input') as unknown as { value: string }
    input.value = 'Run the tests'
    ;(phone.document.getElementById('send') as unknown as { click(): void }).click()
    await vi.waitFor(() => expect(fake.port.send).toHaveBeenCalledWith('Run the tests'))

    await remote.stop()
    await vi.waitFor(() => expect(text('coverTitle')).toBe('Session not reachable'))
  })
})
