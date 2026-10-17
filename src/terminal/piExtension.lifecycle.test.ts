import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
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

import terminalExtension from './piExtension'

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
