import { mkdtempSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { NotesBridge } from './bridge'

const send = (port: number, path: string, options: { method?: string; host?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': 'text/plain' } }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })

describe('the page bridge', () => {
  it('listens only on loopback, keeps its settings owner-only, wants its token and relays one operation', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-bridge-'))
    const bridge = new NotesBridge({ stateDir })
    try {
      const { port, token } = await bridge.start()
      expect(statSync(join(stateDir, 'notes-bridge.json')).mode & 0o777).toBe(0o600)
      expect((await send(port, `/page-notes.js?token=${token}`, { host: `evil.example:${port}` })).status).toBe(421)
      expect((await send(port, '/page-notes.js?token=nope')).status).toBe(403)
      expect((await send(port, '/register', { method: 'POST', body: { token: 'nope' } })).status).toBe(403)
      expect((await send(port, `/poll?token=${token}&window=missing`)).status).toBe(410)

      const script = await send(port, `/page-notes.js?token=${token}`)
      expect(script.body).toContain('__harnessPageNotesBridge')
      expect(script.body).not.toContain('__ARGS__')

      const { windowId } = JSON.parse((await send(port, '/register', { method: 'POST', body: { token, url: 'tauri://localhost/', title: 'App' } })).body)
      expect(bridge.list()).toEqual([expect.objectContaining({ id: windowId, url: 'tauri://localhost/', title: 'App' })])
      const call = bridge.call(windowId, { operation: 'identity' })
      const polled = JSON.parse((await send(port, `/poll?token=${token}&window=${windowId}&url=${encodeURIComponent('tauri://localhost/x')}&title=App`)).body)
      expect(polled.operation).toEqual({ operation: 'identity' })
      await send(port, '/reply', { method: 'POST', body: { token, window: windowId, id: polled.id, reply: '{"ok":true,"result":1}' } })
      expect(await call).toBe('{"ok":true,"result":1}')
      expect(bridge.list()[0].url).toBe('tauri://localhost/x')
      await expect(bridge.call('nope', { operation: 'identity' })).rejects.toThrow('no longer connected')
    } finally {
      await bridge.close()
    }
  })
})
