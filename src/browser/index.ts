// Foundation owns the isolated browser engine; the Browser plugin exposes its user-facing tools.
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import type { PluginDescriptor } from '../plugins/types'
import type { WorldContext, WorldPart } from '../world/world'
import type { ToolSpec } from '../tools/types'
import { readBrowserConfig } from './config'
import { browserDiagnostic } from './diagnostics'
import { NetworkPolicy } from './network'
import { BrowserSession, fileName, launchBrowser, type Launcher } from './session'
import type { BrowserToolSession } from './tools'
import { BrowserExtensionBridge } from './extension/bridge'
import { BraveBrowserSession } from './extension/session'
import { BROWSER_TOOL_NAMES, browserTools } from './tools'

export const BROWSER_PLUGIN: PluginDescriptor = {
  id: 'browser',
  title: 'Browser',
  description: 'The browser backend selected by the person: an isolated Harness profile or the connected Brave profile. Brave exposes only normal tabs on sites explicitly allowed in the extension, never Incognito; a disconnect refuses calls and never switches backends. Sending, buying, deleting, account changes and granting access always ask you.',
  manage: 'tools',
  switchable: { on: true },
  // Its tools are listed in the World group, which the Web plugin owns.
  tools: BROWSER_TOOL_NAMES.map((name) => ({ name }))
}

/** A browser closes after this long without a call. */
export const IDLE_MS = 15 * 60_000

export interface BrowserPartOptions {
  stateDir: string
  launch?: Launcher
  /** Replaces the address check in tests. */
  network?: NetworkPolicy
  idleMs?: number
  extensionPort?: number
}

/** Foundation-owned isolated browser engine. Plugin tools receive sessions through this interface. */
export interface BrowserEngine {
  sessions: Map<string, BrowserToolSession>
  extension: BrowserExtensionBridge
  diagnostics: NonNullable<WorldPart['diagnostics']>
  tools(context: WorldContext): ToolSpec[]
  toolsForSession(session: import('../tools/types').ToolSession, context: WorldContext): ToolSpec[]
  release(sessionKey: string): Promise<void>
  close(): Promise<void>
}

export function createBrowserEngine(options: BrowserPartOptions): BrowserEngine {
  const sessions = new Map<string, BrowserToolSession>()
  const owners = new Map<string, string>()
  const diagnosticKeys = new Set<string>()
  const config = () => readBrowserConfig(options.stateDir)
  const network = options.network ?? new NetworkPolicy(config)
  const extension = new BrowserExtensionBridge({ stateDir: options.stateDir, port: options.extensionPort })
  const releaseExact = async (key: string): Promise<void> => {
    const session = sessions.get(key)
    sessions.delete(key)
    owners.delete(key)
    await session?.close()
    if (diagnosticKeys.delete(key)) rmSync(join(options.stateDir, 'browser', 'downloads', fileName(key)), { recursive: true, force: true })
  }
  const sessionFor = (context: WorldContext, backend: 'isolated' | 'brave'): BrowserToolSession => {
    const key = `${backend}:${context.sessionKey}`
    let session = sessions.get(key)
    if (!session) {
      owners.set(key, context.sessionKey)
      if (context.caller.surface === 'doctor') {
        diagnosticKeys.add(key)
        session = new BrowserSession({
          key,
          profileDir: null,
          downloadsDir: join(options.stateDir, 'browser', 'downloads', fileName(key)),
          config: () => ({ ...config(), backend: 'isolated', cdpUrl: null, headed: false }),
          network,
          launch: options.launch ?? launchBrowser,
          idleMs: options.idleMs ?? IDLE_MS,
          onIdle: () => void releaseExact(key)
        })
      } else if (backend === 'brave') {
        session = new BraveBrowserSession({ bridge: extension, network, idleMs: options.idleMs ?? IDLE_MS, onIdle: () => void releaseExact(key) })
      } else {
        const owner = context.caller.agentId ?? context.caller.projectId ?? 'default'
        session = new BrowserSession({
          key,
          profileDir: join(options.stateDir, 'browser', 'profiles', fileName(owner)),
          downloadsDir: join(options.stateDir, 'browser', 'downloads', fileName(key)),
          config,
          network,
          launch: options.launch ?? launchBrowser,
          idleMs: options.idleMs ?? IDLE_MS,
          onIdle: () => void releaseExact(key)
        })
      }
      sessions.set(key, session)
    }
    return session
  }
  const toolsForContext = (context: WorldContext): ToolSpec[] => {
    const backend = context.caller.surface !== 'doctor' && config().backend === 'brave' ? 'brave' : 'isolated'
    const session = sessionFor(context, backend)
    return browserTools(context, () => session)
  }
  const release = async (sessionKey: string): Promise<void> => {
    const keys = [...owners.entries()].filter(([, owner]) => owner === sessionKey).map(([key]) => key)
    await Promise.all(keys.map(releaseExact))
  }
  return {
    diagnostics: () => [browserDiagnostic(config)],
    sessions,
    extension,
    tools: toolsForContext,
    toolsForSession: (_session, context) => toolsForContext(context),
    release,
    close: async () => {
      await Promise.all([...sessions.keys()].map(releaseExact))
      await extension.close()
    }
  }
}

/** Plugin adapter that exposes the Foundation engine's checked browser tools to a session. */
export function browserPluginPart(engine: BrowserEngine): WorldPart {
  return { plugin: BROWSER_PLUGIN, diagnostics: engine.diagnostics, tools: context => engine.tools(context) }
}

/** Combined adapter retained for direct browser tests and embedders that construct a WorldPart. */
export function browserPart(options: BrowserPartOptions): WorldPart & Pick<BrowserEngine, 'sessions' | 'release' | 'close'> {
  const engine = createBrowserEngine(options)
  return { ...browserPluginPart(engine), sessions: engine.sessions, release: engine.release, close: engine.close }
}
