import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Browser } from 'playwright-core'

import { AnnotationCapture, appExecutable, type DevToolsFetch } from './capture'

const tmp = () => mkdtempSync(join(tmpdir(), 'harness-devtools-'))

// An app's DevTools answers, keyed by URL; nothing else answers.
function answers(table: Record<string, unknown>): DevToolsFetch {
  return async (url) => table[url] ?? null
}

const browser = { contexts: () => [], close: async () => {} } as unknown as Browser

describe('apps with a DevTools port', () => {
  it('finds Electron and Chromium apps on the usual ports, and skips a Node inspector', async () => {
    const capture = new AnnotationCapture({
      stateDir: tmp(),
      fetchJson: answers({
        'http://127.0.0.1:9222/json/version': { Browser: 'Chrome/126.0.0.0', 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.0 Chrome/126.0.0.0 Electron/31.0.2 Safari/537.36', webSocketDebuggerUrl: 'ws://x' },
        'http://127.0.0.1:9222/json/list': [{ type: 'page', title: 'Slack | general', url: 'app://slack' }, { type: 'page', title: 'DevTools', url: 'devtools://x' }, { type: 'service_worker', title: 'sw', url: 'https://x' }],
        'http://127.0.0.1:9223/json/version': { Browser: 'Chrome/126.0.0.0', 'User-Agent': 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36', webSocketDebuggerUrl: 'ws://y' },
        'http://127.0.0.1:9223/json/list': [],
        'http://127.0.0.1:9229/json/version': { Browser: 'node.js/v22.0.0', 'Protocol-Version': '1.1' }
      })
    })
    const apps = await capture.discover()
    expect(apps).toEqual([
      { endpoint: 'http://127.0.0.1:9222', port: 9222, name: 'Slack | general', browser: 'Electron/31.0.2', electron: true, windows: 1 },
      { endpoint: 'http://127.0.0.1:9223', port: 9223, name: 'Chrome/126.0.0.0', browser: 'Chrome/126.0.0.0', electron: false, windows: 0 }
    ])
  })

  it('remembers a port it attached to and looks there again', async () => {
    const fetchJson = vi.fn(async () => null)
    const capture = new AnnotationCapture({ stateDir: tmp(), fetchJson, connect: async () => browser })
    await capture.attach('k', { kind: 'cdp', endpoint: 'http://127.0.0.1:9333' })
    await capture.discover()
    expect(fetchJson).toHaveBeenCalledWith('http://127.0.0.1:9333/json/version', expect.any(Number))
  })

  it('starts an app with a DevTools port and attaches to it, keeping the loopback rule', async () => {
    const spawnApp = vi.fn()
    let ready = false
    const connect = vi.fn(async () => browser)
    const capture = new AnnotationCapture({
      stateDir: tmp(), spawnApp, connect, freePort: async () => 9444,
      fetchJson: async (url) => { if (url.endsWith('/json/version') && ready) return { Browser: 'Chrome/1' }; ready = true; return null }
    })
    const launched = await capture.launchApp('k', '/opt/My Tool', ['--flag'])
    expect(spawnApp).toHaveBeenCalledWith('/opt/My Tool', ['--flag', '--remote-debugging-port=9444'])
    expect(connect).toHaveBeenCalledWith('http://127.0.0.1:9444')
    expect(launched).toMatchObject({ kind: 'cdp', endpoint: 'http://127.0.0.1:9444', app: { kind: 'cdp', name: 'My Tool' } })
    await expect(capture.attach('k', { kind: 'cdp', endpoint: 'http://example.com:9222' })).rejects.toThrow('on this computer')
  })

  it('gives up on an app that never opens its DevTools port', async () => {
    const capture = new AnnotationCapture({ stateDir: tmp(), spawnApp: () => {}, freePort: async () => 9555, fetchJson: async () => null, launchTimeoutMs: 10 })
    await expect(capture.launchApp('k', '/Applications/Notes')).rejects.toThrow('did not open a DevTools port')
  })

  it('starts the program inside a macOS app bundle', () => {
    const bundle = join(tmp(), 'My App.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(bundle, 'Contents', 'MacOS', 'helper'), '')
    writeFileSync(join(bundle, 'Contents', 'MacOS', 'My App'), '')
    expect(appExecutable(bundle)).toBe(join(bundle, 'Contents', 'MacOS', 'My App'))
    expect(appExecutable('/usr/local/bin/tool')).toBe('/usr/local/bin/tool')
    expect(() => appExecutable(join(tmp(), 'Missing.app'))).toThrow('Contents/MacOS')
  })
})
