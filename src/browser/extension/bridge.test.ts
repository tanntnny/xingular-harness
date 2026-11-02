import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BrowserExtensionBridge } from './bridge'

const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`
const bridges: BrowserExtensionBridge[] = []

function create() {
  const bridge = new BrowserExtensionBridge({ stateDir: mkdtempSync(join(tmpdir(), 'browser-bridge-')), port: 0 })
  bridges.push(bridge)
  return bridge
}

async function fetchWithOrigin(url: string, origin: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { Origin: origin, ...(init.headers as Record<string, string> | undefined) } })
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
})

describe('Brave loopback bridge', () => {
  it('pairs only a browser extension, then carries one request through the long-poll channel', async () => {
    const bridge = create()
    const started = await bridge.start()
    expect(started.pairingCode).toMatch(/^\d+:([0-9A-F]{12})$/)
    expect(started.status).toMatchObject({ state: 'pairing', paired: false, connected: false })
    const [portText, code] = started.pairingCode!.split(':')
    const base = `http://127.0.0.1:${portText}`

    const denied = await fetchWithOrigin(`${base}/pair`, 'https://example.test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    })
    expect(denied.status).toBe(403)
    await denied.arrayBuffer()

    const paired = await fetchWithOrigin(`${base}/pair`, extensionOrigin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    })
    expect(paired.status).toBe(200)
    const { token } = await paired.json() as { token: string }
    expect(token).toMatch(/^[a-f0-9]{48}$/)
    expect((await bridge.start()).pairingCode).toBeUndefined()
    expect(bridge.status()).toMatchObject({ state: 'waiting', paired: true, connected: false })

    const auth = { Authorization: `Bearer ${token}` }
    const poll = fetch(`${base}/poll`, { headers: auth })
    for (let attempt = 0; attempt < 20 && !bridge.status().connected; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(bridge.status().connected).toBe(true)
    const command = bridge.request({ op: 'tabs.list' })
    const packet = await (await poll).json() as { id: string; operation: unknown }
    expect(packet.operation).toEqual({ op: 'tabs.list' })
    const result = { ok: true, value: [{ tabId: 12 }] }
    const reply = await fetch(`${base}/reply`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: packet.id, result })
    })
    expect(reply.status).toBe(200)
    expect(await reply.json()).toEqual({ ok: true })
    await expect(command).resolves.toEqual(result)
    expect(bridge.status()).toMatchObject({ state: 'connected', paired: true, connected: true })
  })

  it('requires a bearer token when service-worker requests omit Origin and rejects another extension origin', async () => {
    const bridge = create()
    const started = await bridge.start()
    const [portText, code] = started.pairingCode!.split(':')
    const base = `http://127.0.0.1:${portText}`
    const paired = await fetchWithOrigin(`${base}/pair`, extensionOrigin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    })
    const { token } = await paired.json() as { token: string }

    const noToken = await fetchWithOrigin(`${base}/control`, extensionOrigin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' })
    })
    expect(noToken.status).toBe(403)
    await noToken.arrayBuffer()

    const noOriginNoToken = await fetch(`${base}/control`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' })
    })
    expect(noOriginNoToken.status).toBe(403)
    await noOriginNoToken.arrayBuffer()

    const wrongOrigin = await fetchWithOrigin(`${base}/control`, `chrome-extension://${'b'.repeat(32)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' })
    })
    expect(wrongOrigin.status).toBe(403)
    await wrongOrigin.arrayBuffer()

    const control = await fetch(`${base}/control`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' })
    })
    expect(control.status).toBe(200)
    const controlResult = await control.json() as { status: { paused: boolean } }
    expect(controlResult.status.paused).toBe(true)
    expect(bridge.status()).toMatchObject({ paused: true, paired: true })
    await expect(bridge.request({ op: 'tabs.list' })).rejects.toThrow('not connected')

    await bridge.stop()
    expect(bridge.status()).toMatchObject({ state: 'stopped', paired: false, connected: false })
    await expect(fetch(`${base}/status`, { headers: { Authorization: `Bearer ${token}`, Origin: extensionOrigin } })).rejects.toThrow()
  })

  it('expires a pairing code and rejects repeated incorrect attempts', async () => {
    const bridge = create()
    const started = await bridge.start()
    const [portText] = started.pairingCode!.split(':')
    const base = `http://127.0.0.1:${portText}`
    let response: Response | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await fetchWithOrigin(`${base}/pair`, extensionOrigin, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000000000' })
      })
      await response.arrayBuffer()
    }
    expect(response?.status).toBe(429)
  })

  it('preserves the paired token and paused state across normal shutdown, then revokes with CORS on stop', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'browser-bridge-reconnect-'))
    const bridge = new BrowserExtensionBridge({ stateDir, port: 0 })
    bridges.push(bridge)
    const started = await bridge.start()
    const savedPort = started.status.port!
    const [portText, code] = started.pairingCode!.split(':')
    const base = `http://127.0.0.1:${portText}`
    const paired = await fetchWithOrigin(`${base}/pair`, extensionOrigin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    })
    const { token } = await paired.json() as { token: string }
    const auth = { Authorization: `Bearer ${token}` }

    const firstPoll = fetchWithOrigin(`${base}/poll`, extensionOrigin, { headers: auth })
    for (let attempt = 0; attempt < 20 && !bridge.status().connected; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    const pause = await fetchWithOrigin(`${base}/control`, extensionOrigin, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' })
    })
    expect(pause.status).toBe(200)
    await pause.arrayBuffer()
    await bridge.close()
    const shutdownPoll = await firstPoll
    expect(shutdownPoll.status).toBe(503)
    expect(shutdownPoll.headers.get('access-control-allow-origin')).toBe(extensionOrigin)
    await shutdownPoll.arrayBuffer()

    const restarted = new BrowserExtensionBridge({ stateDir, port: savedPort })
    bridges.push(restarted)
    const restart = await restarted.start()
    expect(restart.pairingCode).toBeUndefined()
    expect(restart.status).toMatchObject({ state: 'waiting', paired: true, connected: false, paused: true })
    const nextPoll = fetchWithOrigin(`${base}/poll`, extensionOrigin, { headers: auth })
    for (let attempt = 0; attempt < 20 && !restarted.status().connected; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(restarted.status()).toMatchObject({ state: 'paused', connected: true, paused: true })
    await expect(restarted.request({ op: 'tabs.list' })).rejects.toThrow('paused by the user')
    const resume = await fetchWithOrigin(`${base}/control`, extensionOrigin, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' })
    })
    expect(resume.status).toBe(200)
    await resume.arrayBuffer()

    await restarted.stop()
    const revokedPoll = await nextPoll
    expect(revokedPoll.status).toBe(410)
    expect(revokedPoll.headers.get('access-control-allow-origin')).toBe(extensionOrigin)
    await revokedPoll.arrayBuffer()
    expect(restarted.status()).toMatchObject({ state: 'stopped', paired: false, connected: false })
  })
})
