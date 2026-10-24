import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { BrowserContext } from 'playwright-core'

import type { NetworkPolicy } from '../browser/network'
import type { Launcher } from '../browser/session'
import { NotesBridge } from './bridge'
import { AnnotationCapture } from './capture'

// A real headless browser stands in for the visible window. Skipped where none can start.
let server: Server
let url = ''
let launch: Launcher | null = null
let chromiumAttempt: { channel?: string } = {}
const contexts: BrowserContext[] = []
const headedRequests: boolean[] = []
beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    const bridge = new URL(_request.url ?? '/', 'http://x').searchParams.get('bridge')
    response.end(`<title>Notes test</title><p>Hello capture world.</p><button id="go">Save</button>${bridge ? `<script src="${bridge}"></script>` : ''}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`
  const { chromium } = await import('playwright-core')
  for (const attempt of [{ channel: 'chrome' }, {}]) {
    try {
      const probe = await chromium.launch({ headless: true, ...attempt })
      await probe.close()
      chromiumAttempt = attempt
      launch = async ({ config }) => {
        headedRequests.push(config.headed)
        const browser = await chromium.launch({ headless: true, ...attempt })
        const context = await browser.newContext()
        contexts.push(context)
        return { context, browser, attached: false }
      }
      break
    } catch {
      launch = null
    }
  }
}, 60_000)
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const allowAll = { refusal: async () => null } as unknown as NetworkPolicy

describe('the capture browser', () => {
  it('opens a visible window on the page, reports it, and reveals a page target', async (context) => {
    if (!launch) context.skip()
    const capture = new AnnotationCapture({ stateDir: mkdtempSync(join(tmpdir(), 'harness-capture-')), launch: launch!, network: allowAll })
    try {
      expect(await capture.open('s1', url)).toEqual({ url, title: 'Notes test' })
      expect(headedRequests).toEqual([true])
      expect(await capture.identity('s1')).toMatchObject({ url, title: 'Notes test' })
      const { captureId } = await capture.begin('s1', 'text')
      expect(await capture.capture('s1', captureId)).toBeNull()
      await capture.cancel('s1', captureId)
      expect(await capture.reveal('s1', url, { kind: 'page' })).toEqual({ state: 'matched' })
      await expect(capture.open('s1', 'https://user:pw@example.com/')).rejects.toThrow('without credentials')
    } finally {
      await capture.close()
    }
  }, 60_000)

  it('inspects in an isolated world: the comment comes back trusted, the page saw no click', async (context) => {
    if (!launch) context.skip()
    const capture = new AnnotationCapture({ stateDir: mkdtempSync(join(tmpdir(), 'harness-capture-')), launch: launch!, network: allowAll })
    try {
      await capture.open('s1', url)
      await capture.inspect('s1')
      const page = contexts.at(-1)!.pages()[0]
      await page.evaluate(() => { (globalThis as any).document.getElementById('go').onclick = () => { (globalThis as any).clicked = true } })
      await page.click('#go')
      await page.keyboard.type('Primary, please')
      await page.keyboard.press('Control+Enter')
      const next = await capture.next('s1')
      expect(next).toMatchObject({ active: true, trusted: true, app: null, result: { action: 'send', body: 'Primary, please', target: { kind: 'element', tag: 'button' } } })
      expect(await page.evaluate(() => (globalThis as any).clicked ?? false)).toBe(false)
      // The page's own world cannot see the helper.
      expect(await page.evaluate(() => Boolean((globalThis as any)[Symbol.for('xingular.browser.annotations.page.v2')]))).toBe(false)
      // A reload loses the inspector; the next poll turns it on again.
      await page.reload()
      expect(await capture.next('s1')).toMatchObject({ active: true, result: null })
      await page.click('#go')
      await page.keyboard.type('Again')
      await page.keyboard.press('Control+Enter')
      expect((await capture.next('s1')).result).toMatchObject({ body: 'Again' })
      await capture.stopInspect('s1')
      await expect(capture.next('s1')).rejects.toThrow('off')
    } finally {
      await capture.close()
    }
  }, 60_000)

  it('attaches to an app over its DevTools port, uses its own windows, and leaves it running', async (context) => {
    if (!launch) context.skip()
    const { chromium } = await import('playwright-core')
    const port = 9300 + Math.floor(Math.random() * 500)
    const app = await chromium.launch({ headless: true, ...chromiumAttempt, args: [`--remote-debugging-port=${port}`] })
    try {
      const appPage = await (await app.newContext()).newPage()
      await appPage.goto(url)
      const capture = new AnnotationCapture({ stateDir: mkdtempSync(join(tmpdir(), 'harness-capture-')), launch: launch!, network: allowAll })
      const attached = await capture.attach('s1', { kind: 'cdp', endpoint: `http://127.0.0.1:${port}` })
      expect(attached).toMatchObject({ kind: 'cdp', app: { kind: 'cdp', name: `App at 127.0.0.1:${port}` } })
      expect(attached.windows).toEqual([expect.objectContaining({ url, title: 'Notes test', current: true })])
      await expect(capture.attach('s2', { kind: 'cdp', endpoint: 'http://example.com:9229' })).rejects.toThrow('on this computer')
      await capture.inspect('s1')
      await appPage.click('#go')
      await appPage.keyboard.type('Fix the app')
      await appPage.keyboard.press('Control+Enter')
      expect(await capture.next('s1')).toMatchObject({ trusted: true, app: { kind: 'cdp' }, result: { body: 'Fix the app' } })
      await capture.close()
      // The app and its window are still there.
      expect(await appPage.title()).toBe('Notes test')
    } finally {
      await app.close()
    }
  }, 60_000)

  it('captures through the page bridge in a window that loaded its script, as untrusted data', async (context) => {
    if (!launch) context.skip()
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-capture-'))
    const bridge = new NotesBridge({ stateDir })
    const capture = new AnnotationCapture({ stateDir, launch: launch!, network: allowAll, bridge })
    const { chromium } = await import('playwright-core')
    const app = await chromium.launch({ headless: true, ...chromiumAttempt })
    try {
      const attached = await capture.attach('s1', { kind: 'bridge', name: 'My app' })
      expect(attached.bridge?.snippet).toContain(attached.bridge!.scriptUrl)
      // Without the token the script is refused.
      expect((await fetch(attached.bridge!.scriptUrl.replace(/token=\w+/, 'token=bad'))).status).toBe(403)
      const appPage = await app.newPage()
      await appPage.goto(`${url}?bridge=${encodeURIComponent(attached.bridge!.scriptUrl)}`)
      await expect.poll(async () => (await capture.windows('s1')).length, { timeout: 10_000 }).toBe(1)
      await capture.inspect('s1')
      await appPage.click('#go')
      await appPage.keyboard.type('Via the bridge')
      await appPage.keyboard.press('Control+Enter')
      expect(await capture.next('s1')).toMatchObject({ trusted: false, app: { kind: 'bridge', name: 'My app' }, result: { body: 'Via the bridge' } })
      // The same port and token come back after a restart, so the app's script tag stays valid.
      await capture.close()
      const restarted = new NotesBridge({ stateDir })
      expect(await restarted.start()).toMatchObject({ port: attached.bridge!.port, token: attached.bridge!.token })
      await restarted.close()
    } finally {
      await app.close()
    }
  }, 60_000)
})
