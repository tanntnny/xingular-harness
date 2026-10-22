import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  socket: vi.fn(async (_connection: unknown, call: string) => call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }),
  telemetry: vi.fn(async (event: string) => event === 'poll' ? { command: null } : {})
}))
vi.mock('./client', () => ({
  connectionFromEnv: () => ({ socket: '/extension-test', token: 'lifecycle' }),
  socketCall: transport.socket,
  terminalCall: transport.telemetry
}))

import terminalExtension, { type TerminalPlanRunState } from './piExtension'
import { PLAN_INSTRUCTIONS } from '../sessions/planMode'

function extension() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const commands = new Map<string, unknown>()
  const api = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: vi.fn()
  } as unknown as ExtensionAPI
  const ctx = { sessionManager: { getSessionFile: () => '/history/session.jsonl' }, ui: { getEditorText: () => '' }, abort: vi.fn() } as unknown as ExtensionContext
  return { api, ctx, handlers, commands }
}

afterEach(() => vi.useRealTimers())

describe('terminal bridge lifecycle', () => {
  it('registers the shared naming tool against Pi metadata', async () => {
    const { api } = extension()
    let name: string | undefined
    api.getSessionName = () => name
    api.setSessionName = vi.fn(value => { name = value })
    await terminalExtension(api)
    const naming = vi.mocked(api.registerTool).mock.calls.map(([tool]) => tool).find(tool => tool.name === 'session_name')!
    await naming.execute('name-1', { name: 'Add web browser integrations' }, undefined, undefined, {} as ExtensionToolContext)
    await naming.execute('name-2', { name: 'Add web browser integrations' }, undefined, undefined, {} as ExtensionToolContext)
    expect(name).toBe('Add web browser integrations')
    expect(api.setSessionName).toHaveBeenCalledOnce()
    await expect(naming.execute('name-3', { name: 'Add web browser integrations for all agents' }, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow('six words')
  })

  it('adds plan instructions as a one-run context section and withdraws them on the next user request', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['read']) }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    const planned = { messageType: 'user', prompt: 'inspect this', systemPrompt: 'stable prefix', systemPromptOptions: { sections: { identity: 'identity' } } }
    await handlers.get('before_agent_start')!(planned, ctx)
    expect(planned.systemPromptOptions.sections).toEqual({ identity: 'identity', plan: PLAN_INSTRUCTIONS })
    expect(planned.systemPrompt).toBe('stable prefix')

    state.active = false
    const ordinary = { messageType: 'user', prompt: 'now implement', systemPrompt: 'stable prefix', systemPromptOptions: { sections: { identity: 'identity', plan: PLAN_INSTRUCTIONS } } }
    await handlers.get('before_agent_start')!(ordinary, ctx)
    expect(ordinary.systemPromptOptions.sections).toEqual({ identity: 'identity' })
    expect(ordinary.systemPrompt).toBe('stable prefix')
  })

  it('blocks tools outside the active plan allowlist before consulting terminal policy', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['read']) }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    const policyCalls = transport.socket.mock.calls.filter(([, call]) => call === 'terminal.policy').length
    const result = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'call-1', input: { command: 'touch unsafe' } }, ctx)
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining('Plan mode is research-only') })
    expect(transport.socket.mock.calls.filter(([, call]) => call === 'terminal.policy')).toHaveLength(policyCalls)
  })

  it('names the cause when the harness cannot answer a tool call', async () => {
    const { api, ctx, handlers } = extension()
    await terminalExtension(api)
    const original = transport.socket.getMockImplementation()
    transport.socket.mockImplementation(async (_connection, call: string) => {
      if (call === 'terminal.policy') throw new Error('The run is no longer active (its status is interrupted).')
      return call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }
    })
    try {
      const result = await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 'call-2', input: { path: 'README.md' } }, ctx)
      expect(result).toEqual({ block: true, reason: 'The terminal controller is unavailable: The run is no longer active (its status is interrupted).' })
    } finally {
      transport.socket.mockImplementation(original!)
    }
  })

  it('keeps one private control claim while replacing native session pollers and restoring readiness', async () => {
    vi.useFakeTimers()
    const first = extension()
    await terminalExtension(first.api)
    await first.handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, first.ctx)
    await vi.advanceTimersByTimeAsync(100)
    const polls = transport.telemetry.mock.calls.filter(([event]) => event === 'poll').length
    expect(polls).toBe(1)
    await first.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'resume' }, first.ctx)
    await vi.advanceTimersByTimeAsync(300)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'poll')).toHaveLength(polls)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'shutdown')).toHaveLength(1)
    const next = extension()
    await terminalExtension(next.api)
    await next.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, next.ctx)
    await vi.advanceTimersByTimeAsync(100)
    expect(transport.socket.mock.calls.filter(([, call]) => call === 'control.claim')).toHaveLength(1)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'ready')).toHaveLength(2)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'poll')).toHaveLength(polls + 1)
    expect([...next.commands.keys()]).toEqual(['hub', 'plugins', 'accounts'])
    await next.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, next.ctx)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'shutdown')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
