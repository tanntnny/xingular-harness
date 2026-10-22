// One live browser for one session: an isolated profile, numbered tabs, and the refs of each
// tab's latest snapshot. Calls run one at a time; the browser starts on first use and closes when
// the session ends or sits idle.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Browser, BrowserContext, Page } from 'playwright-core'

import type { BrowserConfig } from './config'
import type { NetworkPolicy } from './network'

/** Any name as a file or folder name: other characters become `_`. */
export const fileName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 100) || '_'

export const VIEWPORT = { width: 1280, height: 800 }
export const ACTION_TIMEOUT_MS = 15_000
export const NAVIGATION_TIMEOUT_MS = 30_000

export interface Tab {
  id: string
  page: Page
  /** Bumped on every navigation of the tab's main frame: refs of an earlier generation are stale. */
  generation: number
  /** Refs of the latest snapshot, with the snapshot line that names each. */
  refs: Map<string, string>
  refsGeneration: number
}

export interface Download {
  tab: string
  path: string
  name: string
}

/** Opens a browser context; tests replace it. */
export type Launcher = (input: { profileDir: string | null; downloads: string; config: BrowserConfig }) => Promise<{ context: BrowserContext; browser: Browser | null; attached: boolean }>

export const launchBrowser: Launcher = async ({ profileDir, downloads, config }) => {
  const { chromium } = await import('playwright-core')
  if (config.cdpUrl) {
    // A browser a person runs: we open our own context in it and never close the browser itself.
    const browser = await chromium.connectOverCDP(config.cdpUrl)
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true })
    return { context, browser, attached: true }
  }
  const options = { headless: !config.headed, viewport: VIEWPORT, acceptDownloads: true, downloadsPath: downloads }
  const attempts: { channel?: string; executablePath?: string }[] = config.executablePath ? [{ executablePath: config.executablePath }] : [{ channel: 'chrome' }, { channel: 'msedge' }, {}]
  let last: unknown = null
  for (const attempt of attempts) {
    try {
      const context = profileDir
        ? await chromium.launchPersistentContext(profileDir, { ...options, ...attempt })
        : await (await chromium.launch({ ...options, ...attempt })).newContext({ viewport: VIEWPORT, acceptDownloads: true })
      return { context, browser: context.browser(), attached: false }
    } catch (error) {
      last = error
    }
  }
  throw new Error(`No browser could be started. Install Google Chrome, or run \`npx playwright install chromium\`. (${last instanceof Error ? last.message.split('\n')[0] : String(last)})`)
}

export interface BrowserSessionOptions {
  key: string
  /** The profile kept for this caller, or null for a throwaway one. */
  profileDir: string | null
  downloadsDir: string
  config: () => BrowserConfig
  network: NetworkPolicy
  launch: Launcher
  idleMs: number
  onIdle: () => void
}

export class BrowserSession {
  private closed = false
  private context: BrowserContext | null = null
  private browser: Browser | null = null
  private attached = false
  private starting: Promise<void> | null = null
  private readonly tabs = new Map<string, Tab>()
  private current: string | null = null
  private nextTab = 1
  private queue: Promise<unknown> = Promise.resolve()
  private idle: NodeJS.Timeout | null = null
  private temporaryProfile: string | null = null
  readonly downloads: Download[] = []
  /** Set when the kept profile was in use and a throwaway one was opened instead. */
  profileNote: string | null = null

  constructor(private readonly options: BrowserSessionOptions) {}

  /** Runs `work` after every earlier call of this session has finished. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    this.touch()
    return next
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.options.onIdle(), this.options.idleMs)
    this.idle.unref?.()
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error('The browser session has ended.')
    if (this.context) return
    this.starting ??= (async () => {
      mkdirSync(this.options.downloadsDir, { recursive: true })
      let launched: Awaited<ReturnType<Launcher>>
      try {
        launched = await this.options.launch({ profileDir: this.options.profileDir, downloads: this.options.downloadsDir, config: this.options.config() })
      } catch (error) {
        // Another session holds the kept profile: work in a throwaway one rather than wait.
        if (!this.options.profileDir || !/ProcessSingleton|already in use|lock/i.test(String(error))) throw error
        this.temporaryProfile = mkdtempSync(join(tmpdir(), `harness-browser-${fileName(this.options.key)}-`))
        launched = await this.options.launch({ profileDir: this.temporaryProfile, downloads: this.options.downloadsDir, config: this.options.config() })
        this.profileNote = 'The saved browser profile is in use by another session, so this one started without its sign-ins.'
      }
      this.context = launched.context
      this.browser = launched.browser
      this.attached = launched.attached
      this.context.setDefaultTimeout(ACTION_TIMEOUT_MS)
      this.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
      await this.context.route('**/*', async (route) => {
        const refusal = await this.options.network.refusal(route.request().url())
        if (refusal) await route.abort('blockedbyclient')
        else await route.continue()
      })
      this.context.on('page', (page) => this.adopt(page))
      for (const page of this.context.pages()) this.adopt(page)
    })()
    try {
      await this.starting
      if (this.closed) throw new Error('The browser session has ended.')
    } finally {
      this.starting = null
    }
  }

  private adopt(page: Page): Tab {
    const existing = [...this.tabs.values()].find((tab) => tab.page === page)
    if (existing) return existing
    const tab: Tab = { id: `t${this.nextTab++}`, page, generation: 0, refs: new Map(), refsGeneration: -1 }
    this.tabs.set(tab.id, tab)
    this.current ??= tab.id
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) tab.generation += 1
    })
    page.on('close', () => {
      this.tabs.delete(tab.id)
      if (this.current === tab.id) this.current = this.tabs.keys().next().value ?? null
    })
    page.on('download', (download) => {
      const name = fileName(download.suggestedFilename() || 'download')
      const path = join(this.options.downloadsDir, `${Date.now()}-${name}`)
      void download.saveAs(path).then(() => this.downloads.push({ tab: tab.id, path, name })).catch(() => undefined)
    })
    return tab
  }

  /** A tab by id, or the current one, starting the browser and opening a first tab when needed. */
  async tab(id?: string | null): Promise<Tab> {
    await this.start()
    if (id) {
      const tab = this.tabs.get(id)
      if (!tab) throw new Error(`There is no tab ${id}. browser_tabs lists them.`)
      return tab
    }
    if (this.current && this.tabs.has(this.current)) return this.tabs.get(this.current)!
    return this.open()
  }

  async open(): Promise<Tab> {
    await this.start()
    const tab = this.adopt(await this.context!.newPage())
    this.current = tab.id
    return tab
  }

  select(id: string): Tab {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`There is no tab ${id}.`)
    this.current = id
    return tab
  }

  list(): { id: string; url: string; current: boolean }[] {
    return [...this.tabs.values()].map((tab) => ({ id: tab.id, url: tab.page.url(), current: tab.id === this.current }))
  }

  /** What pages in this browser may reach. */
  get network(): NetworkPolicy {
    return this.options.network
  }

  get currentId(): string | null {
    return this.current
  }

  get started(): boolean {
    return this.context !== null
  }

  async close(): Promise<void> {
    this.closed = true
    await this.starting?.catch(() => undefined)
    if (this.idle) clearTimeout(this.idle)
    const { context, browser, attached } = this
    this.context = null
    this.browser = null
    this.tabs.clear()
    this.current = null
    await context?.close().catch(() => undefined)
    // An attached browser belongs to a person: only our context goes.
    if (!attached) await browser?.close().catch(() => undefined)
    if (this.temporaryProfile) rmSync(this.temporaryProfile, { recursive: true, force: true })
    this.temporaryProfile = null
  }
}
