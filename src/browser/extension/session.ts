import type { NetworkPolicy } from '../network'
import type { Download } from '../session'
import type { BrowserToolElement, BrowserToolLocator, BrowserToolPage, BrowserToolSession, BrowserToolTab } from '../tools'
import type { BrowserExtensionBridge } from './bridge'

interface RemoteTab {
  tabId: number
  url: string
  title: string
  generation: number
  active: boolean
}

interface RemoteNode {
  nodeId: string
  role: string
  name: string
  level?: number
  backendDOMNodeId?: number
  childIds?: string[]
  parentId?: string
  ignored?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const escaped = (value: string): string => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
const quote = (value: string): string => JSON.stringify(value.slice(0, 240))
const ACTIONABLE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option'])

export class BraveBrowserSession implements BrowserToolSession {
  private readonly tabs = new Map<string, RemoteTabState>()
  private current: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private idle: NodeJS.Timeout | null = null
  private readonly idleMs: number
  readonly downloads: Download[] = []
  readonly profileNote = 'Brave is using your existing profile. Only normal tabs on sites you allowed in the extension are available; Incognito tabs are never exposed.'

  constructor(private readonly options: { bridge: BrowserExtensionBridge; network: NetworkPolicy; idleMs: number; onIdle: () => void }) {
    this.idleMs = options.idleMs
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    this.touch()
    return next
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(this.options.onIdle, this.idleMs)
    this.idle.unref?.()
  }

  async invoke<T>(operation: Record<string, unknown>): Promise<T> {
    const response = await this.options.bridge.request(operation)
    if (!isRecord(response) || typeof response.ok !== 'boolean') throw new Error('The Brave extension returned an invalid response.')
    if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : 'The Brave extension could not complete the operation.')
    return response.value as T
  }

  private idFor(tabId: number): string {
    return `b${tabId.toString(36)}`
  }

  private async refreshTabs(): Promise<void> {
    const remote = await this.invoke<RemoteTab[]>({ op: 'tabs.list' })
    if (!Array.isArray(remote)) throw new Error('The Brave extension returned an invalid tab list.')
    const live = new Set<string>()
    this.current = null
    for (const entry of remote) {
      if (!isRecord(entry) || !Number.isInteger(entry.tabId) || typeof entry.url !== 'string' || typeof entry.title !== 'string' || !Number.isInteger(entry.generation)) continue
      if (await this.options.network.refusal(entry.url)) continue
      const tabId = Number(entry.tabId)
      const id = this.idFor(tabId)
      live.add(id)
      const old = this.tabs.get(id)
      if (old) {
        old.remote = { tabId, url: entry.url, title: entry.title, generation: Number(entry.generation), active: entry.active === true }
        old.generation = Number(entry.generation)
      } else {
        this.tabs.set(id, {
          id,
          remote: { tabId, url: entry.url, title: entry.title, generation: Number(entry.generation), active: entry.active === true },
          generation: Number(entry.generation), refs: new Map(), refsGeneration: -1,
          page: new BravePage(this, id)
        })
      }
      if (entry.active === true) this.current = id
    }
    for (const id of this.tabs.keys()) if (!live.has(id)) this.tabs.delete(id)
    if (this.current && !this.tabs.has(this.current)) this.current = null
  }

  async refresh(): Promise<void> {
    await this.refreshTabs()
  }

  async refreshOne(id: string): Promise<RemoteTabState> {
    await this.refreshTabs()
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`Brave tab ${id} is no longer available. The tab may have closed, or the page may have moved to a site you have not allowed.`)
    return tab
  }

  get(id: string): RemoteTabState {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`There is no tab ${id}. browser_tabs lists the available tabs.`)
    return tab
  }

  async tab(id?: string | null): Promise<RemoteTabState> {
    await this.refreshTabs()
    if (id) {
      const tab = this.tabs.get(id)
      if (!tab) throw new Error(`There is no tab ${id}. browser_tabs lists the available tabs.`)
      return tab
    }
    if (this.current && this.tabs.has(this.current)) return this.tabs.get(this.current)!
    return this.open()
  }

  async open(): Promise<RemoteTabState> {
    const tabId = await this.invoke<number>({ op: 'tabs.create' })
    if (!Number.isInteger(tabId)) throw new Error('The Brave extension did not return the new tab.')
    await this.refreshTabs()
    const tab = this.tabs.get(this.idFor(tabId))
    if (!tab) throw new Error('Brave created a tab but it is not available yet. Try browser_tabs again.')
    this.current = tab.id
    return tab
  }

  async select(id: string): Promise<RemoteTabState> {
    const tab = this.get(id)
    await this.invoke({ op: 'tabs.activate', tabId: tab.remote.tabId })
    this.current = id
    await this.refreshTabs()
    return this.get(id)
  }

  list(): { id: string; url: string; current: boolean }[] {
    return [...this.tabs.entries()].map(([id, tab]) => ({ id, url: tab.remote.url, current: id === this.current }))
  }

  get network(): NetworkPolicy {
    return this.options.network
  }

  get started(): boolean {
    return true
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.tabs.clear()
    this.current = null
  }
}

interface RemoteTabState extends BrowserToolTab {
  remote: RemoteTab
}

class BravePage implements BrowserToolPage {
  private readonly refs = new Map<string, { backendDOMNodeId: number; generation: number }>()

  constructor(private readonly session: BraveBrowserSession, private readonly id: string) {}

  private get tab(): RemoteTabState {
    return this.session.get(this.id)
  }

  async refresh(): Promise<void> {
    const tab = await this.session.refreshOne(this.id)
    tab.generation = tab.remote.generation
  }

  url(): string {
    return this.tab.remote.url
  }

  async title(): Promise<string> {
    await this.refresh()
    return this.tab.remote.title
  }

  async goto(url: string): Promise<null> {
    await this.session.invoke({ op: 'page.navigate', tabId: this.tab.remote.tabId, url })
    await this.refresh()
    return null
  }

  async goBack(): Promise<null> {
    await this.session.invoke({ op: 'page.back', tabId: this.tab.remote.tabId })
    await this.refresh()
    return null
  }

  async goForward(): Promise<null> {
    await this.session.invoke({ op: 'page.forward', tabId: this.tab.remote.tabId })
    await this.refresh()
    return null
  }

  async reload(): Promise<null> {
    await this.session.invoke({ op: 'page.reload', tabId: this.tab.remote.tabId })
    await this.refresh()
    return null
  }

  async close(): Promise<void> {
    await this.session.invoke({ op: 'tabs.close', tabId: this.tab.remote.tabId })
  }

  async ariaSnapshot(options: { mode: 'ai'; depth?: number; timeout?: number } = { mode: 'ai' }): Promise<string> {
    const response = await this.session.invoke<{ nodes: RemoteNode[]; generation: number }>({
      op: 'page.snapshot', tabId: this.tab.remote.tabId,
      ...(options.depth ? { depth: Math.max(1, Math.min(40, options.depth)) } : {})
    })
    const tab = this.tab
    tab.generation = response.generation
    tab.remote.generation = response.generation
    this.refs.clear()
    const nodes = Array.isArray(response.nodes) ? response.nodes : []
    const byId = new Map(nodes.filter(node => node && typeof node.nodeId === 'string').map(node => [node.nodeId, node]))
    const lines: string[] = []
    let nextRef = 1
    const walk = (node: RemoteNode, depth: number): void => {
      if (depth > (options.depth ?? 12)) return
      const role = node.role || 'text'
      const name = node.name?.trim() ?? ''
      const actionable = ACTIONABLE.has(role) && Number.isInteger(node.backendDOMNodeId)
      if (!node.ignored && role !== 'rootWebArea' && role !== 'none' && (name || actionable)) {
        const ref = actionable ? `e${nextRef++}` : null
        if (ref) this.refs.set(ref, { backendDOMNodeId: node.backendDOMNodeId!, generation: response.generation })
        const suffix = ref ? ` [ref=${ref}]` : ''
        const level = role === 'heading' && Number.isInteger(node.level) ? ` [level=${node.level}]` : ''
        lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` ${quote(name)}` : ''}${level}${suffix}`)
      }
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId)
        if (child) walk(child, depth + 1)
      }
    }
    const roots = nodes.filter(node => !node.parentId || !byId.has(node.parentId))
    for (const root of roots) walk(root, 0)
    return lines.join('\n')
  }

  async content(): Promise<string> {
    await this.refresh()
    const value = await this.session.invoke<{ title: string; text: string }>({ op: 'page.text', tabId: this.tab.remote.tabId })
    this.tab.remote.title = value.title
    return `<html><head><title>${escaped(value.title)}</title></head><body>${escaped(value.text)}</body></html>`
  }

  async screenshot(options: { type: 'jpeg'; quality: number }): Promise<Buffer> {
    return this.capture(options)
  }

  getByRef(ref: string): BrowserToolLocator {
    const target = this.refs.get(ref)
    if (!target) throw new Error(`There is no live element for ref ${ref}. Take browser_snapshot again.`)
    return new BraveLocator(this, target)
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    await this.refresh()
    return this.session.invoke<T>({ op: 'page.evaluate', tabId: this.tab.remote.tabId, expression })
  }

  keyboard = {
    press: async (key: string): Promise<void> => {
      await this.session.invoke({ op: 'page.press', tabId: this.tab.remote.tabId, key })
    }
  }

  mouse = {
    wheel: async (x: number, y: number): Promise<void> => {
      await this.session.invoke({ op: 'page.scroll', tabId: this.tab.remote.tabId, x, y })
    }
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, Math.min(10_000, Math.max(0, ms))))
  }

  getByText(text: string): { first(): { waitFor(options: { timeout: number }): Promise<void> } } {
    return { first: () => ({ waitFor: async ({ timeout }) => {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        const found = await this.session.invoke<boolean>({ op: 'page.containsText', tabId: this.tab.remote.tabId, text })
        if (found) return
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const error = new Error(`Timeout ${timeout}ms exceeded while waiting for text`)
      error.name = 'TimeoutError'
      throw error
    } }) }
  }

  getNode(target: { backendDOMNodeId: number; generation: number }): number {
    if (target.generation !== this.tab.generation || this.tab.refsGeneration !== this.tab.generation) throw new Error(`The page in ${this.id} changed since its last snapshot. Take browser_snapshot again and use a ref from it.`)
    return target.backendDOMNodeId
  }

  async locatorCall<T>(target: { backendDOMNodeId: number; generation: number }, method: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.refresh()
    const backendDOMNodeId = this.getNode(target)
    return this.session.invoke<T>({ op: 'page.element', tabId: this.tab.remote.tabId, backendDOMNodeId, generation: target.generation, method, ...args })
  }

  async capture(options: { type: 'jpeg'; quality: number }, target?: { backendDOMNodeId: number; generation: number }): Promise<Buffer> {
    await this.refresh()
    const args: Record<string, unknown> = { op: 'page.screenshot', tabId: this.tab.remote.tabId, quality: Math.max(10, Math.min(95, options.quality)) }
    if (target) {
      args.backendDOMNodeId = this.getNode(target)
      args.generation = target.generation
    }
    const result = await this.session.invoke<{ data: string }>(args)
    return Buffer.from(result.data, 'base64')
  }
}

class BraveLocator implements BrowserToolLocator {
  constructor(
    private readonly page: BravePage,
    private readonly target: { backendDOMNodeId: number; generation: number }
  ) {}

  async click(options: { button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    await this.page.locatorCall({ ...this.target }, 'click', { button: options.button ?? 'left', double: false })
  }

  async dblclick(options: { button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    await this.page.locatorCall({ ...this.target }, 'click', { button: options.button ?? 'left', double: true })
  }

  async screenshot(options: { type: 'jpeg'; quality: number }): Promise<Buffer> {
    return this.page.capture(options, this.target)
  }

  async evaluate<T>(callback: (element: BrowserToolElement) => T): Promise<T> {
    const declaration = callback.toString()
    return this.page.locatorCall<T>({ ...this.target }, 'evaluate', { functionDeclaration: `function(){ return (${declaration})(this) }` })
  }

  async fill(value: string): Promise<void> {
    await this.page.locatorCall({ ...this.target }, 'fill', { text: value })
  }

  async press(key: string): Promise<void> {
    await this.page.locatorCall({ ...this.target }, 'press', { key })
  }

  async selectOption(values: string[]): Promise<string[]> {
    return this.page.locatorCall<string[]>({ ...this.target }, 'select', { values })
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.page.locatorCall({ ...this.target }, 'scrollIntoView')
  }
}
