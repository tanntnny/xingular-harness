import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'

import { BROWSER_TOOLS, BROWSER_TOOL_NAMES } from './contracts'
import { browserBackendTools, browserToolSpec } from './backend'
import { browserTools } from './tools'
import { remoteTools } from '../server/remote'
import type { RpcPeer } from '../server/rpc'
import type { WorldContext } from '../world/world'

describe('backend-neutral browser contract', () => {
  it('is the isolated backend schema and policy source, without opening a browser', () => {
    const isolated = browserTools({} as WorldContext, () => { throw new Error('must not launch') })
    expect(isolated.map(tool => tool.name)).toEqual(BROWSER_TOOL_NAMES)
    for (const tool of isolated) {
      const definition = BROWSER_TOOLS.find(item => item.name === tool.name)!
      expect(tool.parameters(Type)).toEqual(definition.inputSchema)
      expect(tool.readOnly).toBe(definition.readOnly)
      expect(tool.planModeSafe).toBe(definition.planModeSafe)
    }
  })

  it('refuses unsupported semantics without calling a backend', async () => {
    let called = false
    const tools = browserBackendTools({ id: 'test native', unsupported: () => 'No snapshot refs.', execute: async () => { called = true; return 'wrong' } })
    expect(await tools.find(tool => tool.name === 'browser_click')!.execute({ ref: 'e12' })).toContain('Nothing was done')
    expect(called).toBe(false)
  })

  it('passes supported arguments intact and preserves structured image results', async () => {
    const image = { text: 'image', image: { data: 'AA==', mimeType: 'image/jpeg' } }
    const calls: unknown[] = []
    const tools = browserBackendTools({ id: 'test', unsupported: () => null, execute: async (...args) => { calls.push(args); return image } })
    expect(await tools.find(tool => tool.name === 'browser_screenshot')!.execute({ tab: 'opaque', ref: 'e12' })).toBe(image)
    expect(calls).toEqual([['browser_screenshot', { tab: 'opaque', ref: 'e12' }]])
  })

  it('uses the canonical browser schema and preserves image results for remote backends', async () => {
    const handlers = new Map<string, (params: any) => unknown>()
    const image = { text: 'Page screenshot', image: { data: 'AA==', mimeType: 'image/jpeg' } }
    const callHost = async () => image
    const provider = remoteTools({ handle: (name: string, handler: (params: any) => unknown) => handlers.set(name, handler), callHost } as unknown as RpcPeer)
    handlers.get('tools.register')!({ tools: [
      { name: 'browser_screenshot', description: 'Host-specific schema', parameters: { type: 'object', properties: { selector: { type: 'string' } } } },
      { name: 'browser_screenshot', description: 'Duplicate registration', parameters: { type: 'object' } }
    ] })
    const tools = await provider({ allow: ['browser_screenshot'], run: { runId: 'run-1', sessionId: 'session-1' } } as any)
    expect(tools).toHaveLength(1)
    expect(tools[0].parameters(Type)).toEqual(BROWSER_TOOLS.find(tool => tool.name === 'browser_screenshot')!.inputSchema)
    expect(await tools[0].execute({ tab: 'opaque' })).toEqual(image)
  })

  it('keeps mutation and tab closing out of plan mode', () => {
    for (const name of ['browser_click', 'browser_type', 'browser_select', 'browser_press'] as const) {
      expect(browserToolSpec(name).readOnly).toBeUndefined()
      expect(browserToolSpec(name).planModeSafe).toBeUndefined()
    }
    expect(browserToolSpec('browser_tabs').planModeSafe!({ op: 'close' })).toBe(false)
    expect(browserToolSpec('browser_tabs').planModeSafe!({ op: 'list' })).toBe(true)
    expect(browserToolSpec('browser_read').readOnly).toBe(true)
  })
})
