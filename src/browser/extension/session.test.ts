import { describe, expect, it, vi } from 'vitest'

import type { ActiveRun } from '../../sessions/registry'
import type { ToolSpec } from '../../tools/types'
import type { WorldContext } from '../../world/world'
import { DEFAULT_BROWSER_CONFIG } from '../config'
import { NetworkPolicy } from '../network'
import { browserTools } from '../tools'
import type { BrowserExtensionBridge } from './bridge'
import { BraveBrowserSession } from './session'

function setup(options: { connected?: boolean; tabs?: Record<string, unknown>[]; networkConfig?: typeof DEFAULT_BROWSER_CONFIG } = {}) {
  let generation = 0
  const operations: Record<string, unknown>[] = []
  const bridge = {
    status: () => ({ state: options.connected === false ? 'waiting' : 'connected', paired: true, connected: options.connected !== false, paused: false, port: 38671, lastSeenAt: Date.now() }),
    request: vi.fn(async (operation: Record<string, unknown>) => {
      operations.push(operation)
      if (options.connected === false) throw new Error('Brave is not connected. Connect the extension in Browser settings; nothing was done.')
      switch (operation.op) {
        case 'tabs.list': return { ok: true, value: options.tabs ?? [{ tabId: 7, url: 'https://example.org/', title: 'Example', generation, active: true }] }
        case 'page.snapshot':
          generation += 1
          return { ok: true, value: { generation, nodes: [
            { nodeId: 'root', role: 'rootWebArea', name: '', childIds: ['ignored-wrapper'] },
            { nodeId: 'ignored-wrapper', parentId: 'root', role: 'none', name: '', childIds: ['button', 'password'], ignored: true },
            { nodeId: 'button', parentId: 'ignored-wrapper', role: 'button', name: 'Continue', backendDOMNodeId: 101, childIds: [] },
            { nodeId: 'password', parentId: 'ignored-wrapper', role: 'textbox', name: 'Password', backendDOMNodeId: 102, childIds: [] }
          ] } }
        case 'page.text': return { ok: true, value: { title: 'Example', text: 'Visible page text' } }
        case 'page.element': return { ok: true, value: null }
        case 'page.containsText': return { ok: true, value: true }
        default: throw new Error(`Unexpected browser operation: ${String(operation.op)}`)
      }
    })
  }
  const network = new NetworkPolicy(() => options.networkConfig ?? DEFAULT_BROWSER_CONFIG, async () => ['93.184.216.34'])
  const session = new BraveBrowserSession({ bridge: bridge as unknown as BrowserExtensionBridge, network, idleMs: 60_000, onIdle: () => undefined })
  const run = { runId: 'r1', sessionId: 's1', requestApproval: vi.fn(async () => 'approved') } as unknown as ActiveRun
  const context: WorldContext = { run, caller: {}, attended: true, subagent: false, sessionKey: 's1', cwd: '/tmp' }
  const tools = browserTools(context, () => session)
  const call = async (name: string, input: Record<string, unknown> = {}): Promise<string> => {
    const result = await tools.find((tool: ToolSpec) => tool.name === name)!.execute(input)
    return typeof result === 'string' ? result : result.text
  }
  return { bridge, call, operations, session, setGeneration: (value: number) => { generation = value } }
}

const ref = (snapshot: string, name: string): string => {
  const line = snapshot.split('\n').find(candidate => candidate.includes(name))
  const found = line && /\[ref=([a-z0-9]+)\]/.exec(line)?.[1]
  if (!found) throw new Error(`No ref for ${name} in ${snapshot}`)
  return found
}

describe('Brave browser session adapter', () => {
  it('uses shared snapshots and actions against the paired extension', async () => {
    const { call, operations, session } = setup()
    const snapshot = await call('browser_snapshot')
    const button = ref(snapshot, 'Continue')
    expect(snapshot).toContain('Tab b7: https://example.org/')
    expect(await call('browser_click', { ref: button })).toContain('Clicked')
    expect(operations.some(operation => operation.op === 'page.element' && operation.method === 'click' && operation.backendDOMNodeId === 101)).toBe(true)
    await session.close()
  })

  it('rejects refs after another snapshot generation and never fills sensitive fields', async () => {
    const { call, operations, setGeneration, session } = setup()
    const snapshot = await call('browser_snapshot')
    const button = ref(snapshot, 'Continue')
    setGeneration(2)
    expect(await call('browser_click', { ref: button })).toContain('changed since its last snapshot')
    const fresh = await call('browser_snapshot')
    const password = ref(fresh, 'Password')
    expect(await call('browser_type', { ref: password, text: 'not-a-secret' })).toContain('Ask the user to fill it themselves')
    expect(operations.some(operation => operation.op === 'page.element')).toBe(false)
    await session.close()
  })

  it('refuses disconnected Brave without switching to an isolated browser', async () => {
    const { call, operations, session } = setup({ connected: false })
    expect(await call('browser_tabs')).toContain('Brave is not connected')
    expect(operations.every(operation => operation.op === 'tabs.list')).toBe(true)
    await session.close()
  })

  it('filters tabs rejected by the shared browser network policy', async () => {
    const unallowedSite = { tabId: 8, url: 'https://other.example/', title: 'Other', generation: 0, active: true }
    const { session } = setup({ tabs: [unallowedSite], networkConfig: { ...DEFAULT_BROWSER_CONFIG, allowedDomains: ['example.org'] } })
    await session.refresh()
    expect(session.list()).toEqual([])
    await session.close()
  })
})
