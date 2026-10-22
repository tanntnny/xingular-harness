// The harness's tools that reach outside the machine's files: the web, a browser, the computer's
// screen. They are foundation code, offered to every session whose plugin is switched on, and
// every call passes the same gate as any tool (page 13).
import type { SecretStore } from '../accounts/secrets'
import type { CallerContext } from '../core/caller'
import * as attachments from '../plugins/attachments'
import { settingValue } from '../plugins/firstParty'
import { contributionId } from '../plugins/identity'
import type { PluginDescriptor } from '../plugins/types'
import type { ActiveRun } from '../sessions/registry'
import { findRun } from '../sessions/runStore'
import type { ToolProvider, ToolSession, ToolSpec } from '../tools/types'
import { KEYLESS_SEARCH, WEB_PLUGIN, WEB_SETTINGS, webTools } from '../web/tools'
import type { WebRequest } from '../web/safeRequest'
import { SEARCH_PROVIDERS } from '../web/search'
import { invalid } from '../core/errors'
import { readBrowserConfig, writeBrowserConfig, type BrowserConfig } from '../browser/config'
import { browserPart, type BrowserPartOptions } from '../browser/index'

/** What a world tool knows about the session calling it. */
export interface WorldContext {
  /** The run the call belongs to, when there is one; approvals go through it. */
  run: ActiveRun | null
  caller: CallerContext
  /** A person can answer an approval now (not a refinement, reflection or other unattended run). */
  attended: boolean
  /** The call comes from a child run. */
  subagent: boolean
  /** One key per live session: its browser, its pages. */
  sessionKey: string
  cwd: string
}

export interface WorldOptions {
  root: () => string
  stateDir: string
  secrets: SecretStore
  /** Replaces network reads in tests. */
  request?: WebRequest
  /** Replaces the browser's launcher and address check in tests. */
  browser?: Omit<BrowserPartOptions, 'stateDir'> | false
}

/** A family of world tools, switched as one plugin. */
export interface WorldPart {
  plugin: PluginDescriptor
  tools(context: WorldContext): ToolSpec[]
  diagnostics?: import('../doctor/types').ProviderDiagnostics['diagnostics']
  /** A live session ended: let go of what it held. */
  release?(sessionKey: string): Promise<void>
  close?(): Promise<void>
}

const UNATTENDED = new Set(['probe', 'improver', 'reflection'])

export class World {
  readonly parts: WorldPart[] = []
  private readonly web: ToolProvider

  constructor(private readonly options: WorldOptions) {
    this.web = webTools({ secrets: options.secrets, request: options.request, keyless: () => this.setting(WEB_PLUGIN.id, KEYLESS_SEARCH) === 1 })
    this.parts.push({ plugin: WEB_PLUGIN, tools: () => this.web({} as ToolSession) as ToolSpec[] })
    if (options.browser !== false) this.parts.push(browserPart({ stateDir: options.stateDir, ...options.browser }))
  }

  add(part: WorldPart): void {
    this.parts.push(part)
  }

  get plugins(): PluginDescriptor[] {
    return this.parts.map((part) => part.plugin)
  }

  /** A number a person set on one of these plugins. */
  setting(pluginId: string, key: string): number {
    const descriptor = pluginId === WEB_PLUGIN.id ? { settings: WEB_SETTINGS } : this.parts.find((part) => part.plugin.id === pluginId)?.plugin
    const setting = descriptor?.settings?.find((candidate) => candidate.key === key)
    return setting ? settingValue(setting, attachments.load(this.options.root()).settings[pluginId]) : 0
  }

  /** Every world tool for a context, with the plugin each belongs to. */
  tools(context: WorldContext, on: (pluginId: string, tool: string) => boolean): ToolSpec[] {
    return this.parts.flatMap((part) => part.tools(context).filter((tool) => on(part.plugin.id, tool.name)))
  }

  /** The provider an SDK session asks: only tools whose plugin is on for the caller. */
  provider(): ToolProvider {
    const provider: ToolProvider = (session) => {
      const record = findRun(this.options.root(), session.run.runId)
      const contributions = new Set(session.capabilities.contributions)
      return this.tools(
        { run: session.run, caller: session.caller, attended: !UNATTENDED.has(record?.trigger ?? ''), subagent: session.depth > 0 || record?.relation === 'subagent', sessionKey: session.run.sessionId, cwd: session.cwd },
        (pluginId, tool) => !contributions.size || contributions.has(contributionId(pluginId, 'tool', tool))
      )
    }
    provider.diagnostics = async context => (await Promise.all(this.parts.map(part => part.diagnostics?.(context) ?? []))).flat()
    return provider
  }

  /** Which search services have a key, and whether keyless search is on. Never the keys. */
  async searchStatus(): Promise<{ id: string; title: string; ready: boolean }[]> {
    return Promise.all(SEARCH_PROVIDERS.map(async (provider) => ({
      id: provider.id,
      title: provider.title,
      ready: provider.key ? Boolean(await this.options.secrets.get(provider.key)) : this.setting(WEB_PLUGIN.id, KEYLESS_SEARCH) === 1
    })))
  }

  /** Saves or forgets a search service's key. */
  async setSearchKey(providerId: string, key: string | null): Promise<void> {
    const provider = SEARCH_PROVIDERS.find((candidate) => candidate.id === providerId && candidate.key)
    if (!provider?.key) throw invalid(`Search keys are kept for ${SEARCH_PROVIDERS.filter((candidate) => candidate.key).map((candidate) => candidate.id).join(', ')}.`)
    if (key === null) await this.options.secrets.delete(provider.key)
    else if (!key.trim() || /\s/.test(key.trim())) throw invalid('A key is one word with no spaces.')
    else await this.options.secrets.set(provider.key, key.trim())
  }

  browserConfig(): BrowserConfig {
    return readBrowserConfig(this.options.stateDir)
  }

  configureBrowser(change: Partial<BrowserConfig>): BrowserConfig {
    return writeBrowserConfig(this.options.stateDir, change)
  }

  async release(sessionKey: string): Promise<void> {
    await Promise.all(this.parts.map((part) => part.release?.(sessionKey)))
  }

  async close(): Promise<void> {
    await Promise.all(this.parts.map((part) => part.close?.()))
  }
}

