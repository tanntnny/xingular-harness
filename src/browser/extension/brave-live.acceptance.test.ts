import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type BrowserContext, type Worker } from 'playwright-core'
import { afterEach, describe, expect, it } from 'vitest'

import { createBrowserEngine } from '../index'
import { writeBrowserConfig } from '../config'

const extensionDir = join(process.cwd(), 'browser-extension')
const braveExecutable = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const scratch = join(process.cwd(), '.tmp')
// This test drives a real Brave window, so it runs only when a person asks for it:
// XINGULAR_BRAVE_LIVE=1 npx vitest run src/browser/extension/brave-live.acceptance.test.ts
const live = process.env.XINGULAR_BRAVE_LIVE === '1' && existsSync(braveExecutable)

async function until<T>(work: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let value: T
  do {
    value = await work()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  } while (Date.now() < end)
  return value!
}

async function openActionPopup(context: BrowserContext, worker: Worker): Promise<import('playwright-core').Page | null> {
  const before = new Set(context.pages())
  const pageEvent = context.waitForEvent('page', { timeout: 5_000 }).catch(() => null)
  await worker.evaluate(async () => {
    const openPopup = (globalThis as any).chrome?.action?.openPopup
    if (openPopup) await openPopup.call((globalThis as any).chrome.action)
  }).catch(() => {})
  const eventPage = await pageEvent
  const page = eventPage ?? context.pages().find(candidate => !before.has(candidate) && candidate.url().endsWith('/popup.html')) ?? null
  if (page) await page.waitForLoadState('domcontentloaded').catch(() => {})
  return page
}

describe.skipIf(!live)('disposable Brave live acceptance', () => {
  let context: BrowserContext | null = null
  let engine: ReturnType<typeof createBrowserEngine> | null = null
  let server: Server | null = null
  let stateDir = ''
  let profileDir = ''

  afterEach(async () => {
    await context?.close().catch(() => {})
    await engine?.close().catch(() => {})
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
    if (profileDir) rmSync(profileDir, { recursive: true, force: true })
    context = null
    engine = null
    server = null
    stateDir = ''
    profileDir = ''
  })

  it('pairs, scopes access, controls a tab, and refuses a disconnect without fallback', async () => {
    expect(existsSync(braveExecutable)).toBe(true)
    expect(existsSync(extensionDir)).toBe(true)
    mkdirSync(scratch, { recursive: true })

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>Brave fixture</title><main><h1>Brave fixture</h1><button id="continue" type="button" onclick="document.querySelector('#result').textContent='continued'">Continue</button><form onsubmit="event.preventDefault(); document.querySelector('#result').textContent='submitted'"><label for="notes">Notes</label><input id="notes"><label for="password">Password</label><input id="password" type="password"><button type="submit">Send</button></form><p id="result">ready</p></main>`)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind to a port.')
    const origin = `http://127.0.0.1:${address.port}`

    stateDir = mkdtempSync(join(scratch, 'brave-live-'))
    writeBrowserConfig(stateDir, { backend: 'brave', allowPrivate: true })
    engine = createBrowserEngine({ stateDir, extensionPort: 0, idleMs: 120_000 })
    const pairing = await engine.extension.start()
    expect(pairing.pairingCode).toMatch(/^\d+:[0-9A-F]{12}$/)
    profileDir = mkdtempSync(join(scratch, 'brave-profile-'))
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: braveExecutable,
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-component-update',
        '--window-size=1280,900'
      ]
    })

    let worker = context.serviceWorkers().find(candidate => candidate.url().endsWith('/background.js'))
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
    const extensionId = worker.url().split('/')[2]
    const popupUrl = `chrome-extension://${extensionId}/popup.html`
    const sitePage = await context.newPage()
    await sitePage.goto(origin, { waitUntil: 'domcontentloaded' })
    await sitePage.bringToFront()

    let popup = await openActionPopup(context, worker)
    let openedActionPopup = Boolean(popup)
    if (!popup) {
      popup = await context.newPage()
      await popup.goto(popupUrl)
    }
    await popup.locator('#pairing-code').fill(pairing.pairingCode!)
    await popup.locator('#connect').click()
    const connectedStatus = await until(async () => engine!.extension.status(), value => value.connected)
    expect(connectedStatus.connected).toBe(true)
    expect((await engine.extension.status()).paired).toBe(true)

    if (!openedActionPopup) {
      await popup.close()
      await sitePage.bringToFront()
      popup = await openActionPopup(context, worker)
      openedActionPopup = Boolean(popup)
      if (!popup) {
        popup = await context.newPage()
        await popup.goto(popupUrl)
        await popup.evaluate(async origin => {
          const scope = globalThis as any
          const nativeQuery = scope.chrome.tabs.query.bind(scope.chrome.tabs)
          Object.defineProperty(scope.chrome.tabs, 'query', {
            configurable: true,
            value: (query: Record<string, unknown>) => query.active
              ? Promise.resolve([{ id: 1, url: origin, incognito: false, active: true }])
              : nativeQuery(query)
          })
          if (typeof scope.update === 'function') await scope.update()
        }, origin)
      }
    }

    let sitePermission = false
    if (popup) {
      const allowButton = popup.locator('#allow')
      const ready = await until(async () => {
        await popup!.evaluate(async () => {
          const scope = globalThis as any
          if (typeof scope.update === 'function') await scope.update()
        }).catch(() => {})
        return allowButton.isEnabled().catch(() => false)
      }, value => value, 8_000)
      expect(ready).toBe(true)
      await allowButton.click()
      sitePermission = await until(
        () => popup!.evaluate(async address => (globalThis as any).XingularSiteAccess.allowed(address), origin),
        value => value,
        8_000
      )
    }
    expect(sitePermission, 'The explicit site-permission flow should grant the fixture origin in the disposable profile.').toBe(true)

    await sitePage.waitForFunction(() => Boolean((globalThis as any).document.getElementById('__xingular_agent_browser_badge__')), null, { timeout: 10_000 })
    const caller = { surface: 'cli', actor: 'Code', sessionId: 'brave-live-acceptance', runId: 'brave-live-acceptance' }
    let approvals = 0
    const run = { requestApproval: async () => { approvals++; return 'approved' as const } }
    const tools = engine.tools({ run: run as any, caller, attended: true, subagent: false, sessionKey: 'brave-live-acceptance', cwd: process.cwd() })
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      const tool = tools.find(candidate => candidate.name === name)
      if (!tool) throw new Error(`Missing browser tool ${name}.`)
      return tool.execute(input)
    }

    const denied = await call('browser_navigate', { url: origin.replace('127.0.0.1', 'localhost') })
    expect(String(denied)).toContain('Site access is not enabled')
    expect(sitePage.url()).toBe(`${origin}/`)

    const navigated = await call('browser_navigate', { url: `${origin}/next` })
    expect(String(navigated)).toContain('Brave fixture')
    const snapshot = String(await call('browser_snapshot'))
    const continueRef = /button "Continue" \[ref=([a-z0-9]+)\]/i.exec(snapshot)?.[1]
    expect(continueRef).toBeTruthy()
    await call('browser_click', { ref: continueRef })
    const afterClickText = String(await call('browser_read'))
    expect(afterClickText).toContain('continued')

    const afterClick = String(await call('browser_snapshot'))
    const sendRef = /button "Send" \[ref=([a-z0-9]+)\]/i.exec(afterClick)?.[1]
    expect(sendRef).toBeTruthy()
    await call('browser_click', { ref: sendRef })
    expect(approvals).toBe(1)
    const afterSubmit = String(await call('browser_snapshot'))
    const passwordRef = /textbox "Password" \[ref=([a-z0-9]+)\]/i.exec(afterSubmit)?.[1]
    expect(passwordRef).toBeTruthy()
    const passwordResult = await call('browser_type', { ref: passwordRef, text: 'must-not-be-typed' })
    expect(String(passwordResult)).toContain('Ask the user to fill it themselves')
    expect(await sitePage.locator('#password').inputValue()).toBe('')

    const badgeRect = await sitePage.evaluate(() => {
      const host = (globalThis as any).document.getElementById('__xingular_agent_browser_badge__')
      return host?.getBoundingClientRect().toJSON() ?? null
    })
    expect(badgeRect).toBeTruthy()
    const badgeButton = (offset: number) => ({ x: badgeRect!.right - offset, y: badgeRect!.top + badgeRect!.height / 2 })
    const clickBadge = async (offset: number) => {
      const point = badgeButton(offset)
      await sitePage.mouse.click(point.x, point.y)
    }
    await clickBadge(83)
    await until(async () => engine!.extension.status(), value => value.paused)
    const pausedResult = await call('browser_tabs')
    expect(String(pausedResult)).toContain('paused by the user')
    await clickBadge(83)
    await until(async () => engine!.extension.status(), value => !value.paused && value.connected)

    await clickBadge(30)
    await until(async () => engine!.extension.status(), value => value.state === 'stopped' && !value.paired)
    const disconnectedResult = await call('browser_navigate', { url: `${origin}/after-stop` })
    expect(String(disconnectedResult)).toContain('Brave is not connected')
    expect(engine.sessions.has('isolated:brave-live-acceptance')).toBe(false)
  }, 180_000)
})
