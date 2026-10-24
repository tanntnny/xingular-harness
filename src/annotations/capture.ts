// The terminal's capture surface for page notes (PROP-0017, PROP-0018). A front end captures in
// one target at a time:
// - `web`: a visible browser window the person browses in, separate from the agent's browser;
// - `cdp`: the windows of a desktop app started with a DevTools port (an Electron app, say);
// - `bridge`: app windows that loaded the page bridge script (a macOS web view has no DevTools port).
// The person selects text, clicks an element, or inspects with the popover; the front end pulls
// what they did through the page helper.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { Browser, Page } from 'playwright-core'

import { readBrowserConfig } from '../browser/config'
import { NetworkPolicy } from '../browser/network'
import { BrowserSession, fileName, launchBrowser, type Launcher } from '../browser/session'
import { NotesBridge, type BridgeInfo } from './bridge'
import { evaluateIsolated } from './isolated'
import { pageCall, pageReply, type PageOperation } from './pageScript'
import { validateUrl, type NoteApp, type NoteTarget } from './store'

export interface CaptureEnvelope {
  url: string
  title: string
  documentId: string
  target: NoteTarget
}

export type CaptureTargetSpec = { kind: 'web' } | { kind: 'cdp'; endpoint: string; name?: string | null } | { kind: 'bridge'; name?: string | null }

export interface CaptureWindow {
  id: string
  url: string
  title: string
  current: boolean
}

/** One comment the person submitted in the inspector's popover. */
export interface InspectResult extends CaptureEnvelope {
  body: string
  action: 'save' | 'queue' | 'send'
}

export interface InspectState {
  /** False once the person or the page ended it. */
  active: boolean
  url: string
  title: string
  documentId: string
  result: InspectResult | null
  /** Whether the result came from a script world the page cannot reach. */
  trusted: boolean
  /** The app the window belongs to, for the note's source. */
  app: NoteApp | null
}

/** Opens a DevTools connection to a running app; tests replace it. */
export type AppConnector = (endpoint: string) => Promise<Browser>

export interface AnnotationCaptureOptions {
  stateDir: string
  launch?: Launcher
  network?: NetworkPolicy
  connect?: AppConnector
  bridge?: NotesBridge
}

const IDLE_MS = 60 * 60_000
const LOOPBACK = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/

interface Target {
  readonly kind: CaptureTargetSpec['kind']
  readonly app: NoteApp | null
  evaluate(operation: PageOperation): Promise<{ reply: unknown; trusted: boolean }>
  windows(): Promise<CaptureWindow[]>
  select(id: string): void
  close(): Promise<void>
}

const connectApp: AppConnector = async (endpoint) => {
  const { chromium } = await import('playwright-core')
  return chromium.connectOverCDP(endpoint)
}

/** An app's own windows over its DevTools port. Nothing is routed or opened, and the app is never closed. */
class CdpTarget implements Target {
  readonly kind = 'cdp' as const
  private readonly ids = new WeakMap<Page, string>()
  private nextId = 1
  private current: Page | null = null

  constructor(private readonly browser: Browser, readonly app: NoteApp) {}

  private pages(): Page[] {
    return this.browser.contexts().flatMap((context) => context.pages()).filter((page) => !/^(?:devtools|chrome-extension):/.test(page.url()))
  }

  private id(page: Page): string {
    let id = this.ids.get(page)
    if (!id) {
      id = `w${this.nextId++}`
      this.ids.set(page, id)
    }
    return id
  }

  private page(): Page {
    const pages = this.pages()
    if (this.current && pages.includes(this.current)) return this.current
    this.current = pages[0] ?? null
    if (!this.current) throw new Error('The app has no open window.')
    return this.current
  }

  async evaluate(operation: PageOperation): Promise<{ reply: unknown; trusted: boolean }> {
    return evaluateIsolated(this.page(), pageCall(operation))
  }

  async windows(): Promise<CaptureWindow[]> {
    const current = this.pages().length ? this.page() : null
    return Promise.all(this.pages().map(async (page) => ({ id: this.id(page), url: page.url(), title: await page.title().catch(() => ''), current: page === current })))
  }

  select(id: string): void {
    const page = this.pages().find((candidate) => this.ids.get(candidate) === id)
    if (!page) throw new Error(`There is no app window ${id}.`)
    this.current = page
    void page.bringToFront().catch(() => undefined)
  }

  async close(): Promise<void> {
    // Disconnects; an app we attached to keeps running.
    await this.browser.close().catch(() => undefined)
  }
}

/** Windows that loaded the page bridge script. Every answer is page data the page could forge. */
class BridgeTarget implements Target {
  readonly kind = 'bridge' as const
  private current: string | null = null

  constructor(private readonly bridge: NotesBridge, readonly app: NoteApp) {}

  private window(): string {
    const windows = this.bridge.list()
    if (this.current && windows.some((window) => window.id === this.current)) return this.current
    this.current = windows.sort((left, right) => right.lastSeen - left.lastSeen)[0]?.id ?? null
    if (!this.current) throw new Error('No app window has connected to the page bridge yet. Load the bridge script in the app and reload it.')
    return this.current
  }

  async evaluate(operation: PageOperation): Promise<{ reply: unknown; trusted: boolean }> {
    return { reply: await this.bridge.call(this.window(), operation), trusted: false }
  }

  async windows(): Promise<CaptureWindow[]> {
    const current = this.bridge.list().length ? this.window() : null
    return this.bridge.list().map((window) => ({ id: window.id, url: window.url, title: window.title, current: window.id === current }))
  }

  select(id: string): void {
    if (!this.bridge.list().some((window) => window.id === id)) throw new Error(`There is no app window ${id}.`)
    this.current = id
  }

  async close(): Promise<void> {}
}

/** The visible browser window, with the helper in an isolated world. */
class WebTarget implements Target {
  readonly kind = 'web' as const
  readonly app = null

  constructor(readonly session: BrowserSession) {}

  evaluate(operation: PageOperation): Promise<{ reply: unknown; trusted: boolean }> {
    return this.session.run(async () => evaluateIsolated((await this.session.tab()).page, pageCall(operation)))
  }

  async windows(): Promise<CaptureWindow[]> {
    if (!this.session.started) return []
    return Promise.all(this.session.list().map(async (tab) => ({ id: tab.id, url: tab.url, title: await (await this.session.tab(tab.id)).page.title().catch(() => ''), current: tab.current })))
  }

  select(id: string): void {
    void this.session.select(id).page.bringToFront().catch(() => undefined)
  }

  close(): Promise<void> {
    return this.session.close()
  }
}

export class AnnotationCapture {
  private readonly targets = new Map<string, Target>()
  private readonly inspecting = new Map<string, { captureId: string; documentId: string | null }>()
  private readonly network: NetworkPolicy
  readonly bridge: NotesBridge

  constructor(private readonly options: AnnotationCaptureOptions) {
    this.network = options.network ?? new NetworkPolicy(() => readBrowserConfig(options.stateDir))
    this.bridge = options.bridge ?? new NotesBridge({ stateDir: options.stateDir })
  }

  private web(key: string): WebTarget {
    const existing = this.targets.get(key)
    if (existing instanceof WebTarget) return existing
    const session = new BrowserSession({
      key: `notes-${key}`,
      profileDir: join(this.options.stateDir, 'browser', 'profiles', 'person'),
      downloadsDir: join(this.options.stateDir, 'browser', 'downloads', fileName(`notes-${key}`)),
      // Always a window the person can see and select in.
      config: () => ({ ...readBrowserConfig(this.options.stateDir), headed: true }),
      network: this.network,
      launch: this.options.launch ?? launchBrowser,
      idleMs: IDLE_MS,
      onIdle: () => void this.release(key)
    })
    const target = new WebTarget(session)
    this.targets.set(key, target)
    return target
  }

  private target(key: string): Target {
    return this.targets.get(key) ?? this.web(key)
  }

  private async replace(key: string, target: Target): Promise<void> {
    const old = this.targets.get(key)
    this.targets.set(key, target)
    this.inspecting.delete(key)
    if (old && old !== target) await old.close().catch(() => undefined)
  }

  private async call<T>(key: string, operation: PageOperation): Promise<T> {
    return pageReply<T>((await this.target(key).evaluate(operation)).reply)
  }

  /** What `key` captures in now. */
  describe(key: string): { kind: CaptureTargetSpec['kind']; app: NoteApp | null; inspecting: boolean } {
    const target = this.targets.get(key)
    return { kind: target?.kind ?? 'web', app: target?.app ?? null, inspecting: this.inspecting.has(key) }
  }

  /** Captures in an app's windows instead of the browser: over its DevTools port, or the page bridge. */
  async attach(key: string, spec: CaptureTargetSpec): Promise<{ kind: CaptureTargetSpec['kind']; app: NoteApp | null; windows: CaptureWindow[]; bridge?: BridgeInfo }> {
    if (spec.kind === 'web') {
      if (this.targets.get(key)?.kind !== 'web') await this.replace(key, this.web(key))
      return { kind: 'web', app: null, windows: await this.target(key).windows() }
    }
    if (spec.kind === 'cdp') {
      if (typeof spec.endpoint !== 'string' || !LOOPBACK.test(spec.endpoint)) throw new Error('An app\'s DevTools address must be on this computer, such as http://127.0.0.1:9229.')
      const browser = await (this.options.connect ?? connectApp)(spec.endpoint)
      const name = spec.name?.trim() || `App at ${new URL(spec.endpoint).host}`
      const target = new CdpTarget(browser, { kind: 'cdp', name: name.slice(0, 200) })
      await this.replace(key, target)
      return { kind: 'cdp', app: target.app, windows: await target.windows() }
    }
    if (spec.kind === 'bridge') {
      const bridge = await this.bridge.start()
      const target = new BridgeTarget(this.bridge, { kind: 'bridge', name: (spec.name?.trim() || 'App window').slice(0, 200) })
      await this.replace(key, target)
      return { kind: 'bridge', app: target.app, windows: await target.windows(), bridge }
    }
    throw new Error('A capture target is web, cdp or bridge.')
  }

  windows(key: string): Promise<CaptureWindow[]> {
    return this.target(key).windows()
  }

  /** Switches to another window or tab of the target; an inspector there starts again. */
  async selectWindow(key: string, id: string): Promise<void> {
    const inspecting = this.inspecting.has(key)
    if (inspecting) await this.stopInspect(key).catch(() => undefined)
    this.target(key).select(id)
    if (inspecting) await this.inspect(key)
  }

  /** Shows the capture window, at `url` when given. Captures in the browser again if an app was attached. */
  async open(key: string, url?: string | null): Promise<{ url: string; title: string }> {
    if (this.targets.get(key) && this.targets.get(key)!.kind !== 'web') await this.replace(key, this.web(key))
    const { session } = this.web(key)
    return session.run(async () => {
      const tab = await session.tab()
      if (url) {
        const address = validateUrl(url)
        const refusal = await this.network.refusal(address)
        if (refusal) throw new Error(refusal)
        await tab.page.goto(address, { waitUntil: 'domcontentloaded' })
      }
      await tab.page.bringToFront().catch(() => undefined)
      return { url: tab.page.url(), title: await tab.page.title().catch(() => '') }
    })
  }

  identity(key: string): Promise<{ url: string; title: string; documentId: string }> {
    return this.call(key, { operation: 'identity' })
  }

  /** Starts listening for the person's selection or click. Returns the id `capture` takes. */
  async begin(key: string, kind: 'text' | 'element'): Promise<{ captureId: string }> {
    this.inspecting.delete(key)
    const captureId = randomUUID()
    await this.call(key, { operation: 'begin', kind, captureId })
    return { captureId }
  }

  /** What the person selected, or null when nothing is selected yet. */
  capture(key: string, captureId: string): Promise<CaptureEnvelope | null> {
    return this.call(key, { operation: 'capture', captureId })
  }

  async cancel(key: string, captureId?: string): Promise<void> {
    if (!this.targets.has(key)) return
    await this.call(key, { operation: 'cancel', ...(captureId ? { captureId } : {}) })
  }

  /** Turns on the inspector in the current window: hover outlines, a click opens the comment popover. */
  async inspect(key: string): Promise<{ captureId: string }> {
    const captureId = randomUUID()
    await this.call(key, { operation: 'begin', kind: 'inspect', captureId })
    const identity = await this.identity(key).catch(() => null)
    this.inspecting.set(key, { captureId, documentId: identity?.documentId ?? null })
    return { captureId }
  }

  async stopInspect(key: string): Promise<void> {
    const state = this.inspecting.get(key)
    this.inspecting.delete(key)
    if (state && this.targets.has(key)) await this.call(key, { operation: 'cancel', captureId: state.captureId }).catch(() => undefined)
  }

  /**
   * The next comment the person submitted, if any. A new document (a reload, a link) loses the
   * inspector; it is turned on again there, so the person can keep going.
   */
  async next(key: string): Promise<InspectState> {
    const target = this.target(key)
    const state = this.inspecting.get(key)
    if (!state) throw new Error('The inspector is off.')
    const { reply, trusted } = await target.evaluate({ operation: 'next', captureId: state.captureId })
    const value = pageReply<Omit<InspectState, 'trusted' | 'app'>>(reply)
    if (!value.active && this.inspecting.get(key) === state && value.documentId !== state.documentId) {
      await target.evaluate({ operation: 'begin', kind: 'inspect', captureId: state.captureId })
      state.documentId = value.documentId
      return { ...value, active: true, result: null, trusted, app: target.app }
    }
    if (!value.active) this.inspecting.delete(key)
    return { ...value, trusted, app: target.app }
  }

  async toast(key: string, text: string): Promise<void> {
    await this.call(key, { operation: 'toast', text: text.slice(0, 200) })
  }

  /** Opens the note's page when another one is showing, then scrolls to and marks its target. */
  async reveal(key: string, url: string, target: NoteTarget): Promise<{ state: 'matched' | 'ambiguous' | 'unresolved'; reason?: string }> {
    const current = this.targets.get(key)
    if (!current || current.kind === 'web') {
      const shown = (current as WebTarget | undefined)?.session.started ? await this.identity(key).catch(() => null) : null
      if (shown?.url !== url) await this.open(key, url)
    }
    return this.call(key, { operation: 'reveal', target })
  }

  async release(key: string): Promise<void> {
    const target = this.targets.get(key)
    this.targets.delete(key)
    this.inspecting.delete(key)
    await target?.close()
  }

  async close(): Promise<void> {
    await Promise.all([...this.targets.keys()].map((key) => this.release(key)))
    await this.bridge.close()
  }
}
