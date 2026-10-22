// The browser, as one part of the harness's world tools: a plugin a person can switch off, and one
// live browser per session.
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import type { PluginDescriptor } from '../plugins/types'
import type { WorldContext, WorldPart } from '../world/world'
import { readBrowserConfig } from './config'
import { browserDiagnostic } from './diagnostics'
import { NetworkPolicy } from './network'
import { BrowserSession, fileName, launchBrowser, type Launcher } from './session'
import { BROWSER_TOOL_NAMES, browserTools } from './tools'

export const BROWSER_PLUGIN: PluginDescriptor = {
  id: 'browser',
  title: 'Browser',
  description: 'A browser the agent drives: open pages that need scripts, read them, click, type and choose. Each session has its own; sign-ins are kept per agent on this device. Sending, buying, deleting, account changes and granting access always ask you.',
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
}

export function browserPart(options: BrowserPartOptions): WorldPart & { sessions: Map<string, BrowserSession> } {
  const sessions = new Map<string, BrowserSession>()
  const diagnosticKeys = new Set<string>()
  const config = () => readBrowserConfig(options.stateDir)
  const network = options.network ?? new NetworkPolicy(config)
  const sessionFor = (context: WorldContext): BrowserSession => {
    let session = sessions.get(context.sessionKey)
    if (!session) {
      const owner = context.caller.agentId ?? context.caller.projectId ?? 'default'
      const key = context.sessionKey
      const diagnostic = context.caller.surface === 'doctor'
      if (diagnostic) diagnosticKeys.add(key)
      session = new BrowserSession({
        key,
        profileDir: diagnostic ? null : join(options.stateDir, 'browser', 'profiles', fileName(owner)),
        downloadsDir: join(options.stateDir, 'browser', 'downloads', fileName(key)),
        config: diagnostic ? () => ({ ...config(), cdpUrl: null, headed: false }) : config,
        network,
        launch: options.launch ?? launchBrowser,
        idleMs: options.idleMs ?? IDLE_MS,
        onIdle: () => void release(key)
      })
      sessions.set(key, session)
    }
    return session
  }
  const release = async (key: string): Promise<void> => {
    const session = sessions.get(key)
    sessions.delete(key)
    await session?.close()
    if (diagnosticKeys.delete(key)) rmSync(join(options.stateDir, 'browser', 'downloads', fileName(key)), { recursive: true, force: true })
  }
  return {
    plugin: BROWSER_PLUGIN,
    diagnostics: () => [browserDiagnostic(config)],
    sessions,
    tools: (context) => browserTools(context, () => sessionFor(context)),
    release,
    close: async () => {
      await Promise.all([...sessions.keys()].map(release))
    }
  }
}
