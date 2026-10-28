import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  socket: vi.fn(async (_connection: unknown, call: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }),
  telemetry: vi.fn(async (event: string) => event === 'poll' ? { command: null } : event === 'begin' ? { runId: 'run-1', workspaceRoot: process.cwd() } : {})
}))
vi.mock('./client', () => ({
  connectionFromEnv: () => ({ socket: '/extension-test', token: 'lifecycle' }),
  socketCall: transport.socket,
  terminalCall: transport.telemetry
}))

import terminalExtension, { type TerminalPlanRunState } from './piExtension'
import { resolveWritePath } from '../core/workspace'
import { PLAN_INSTRUCTIONS } from '../sessions/planMode'

function extension() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const commands = new Map<string, unknown>()
  const api = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const previous = handlers.get(event)
      handlers.set(event, async (...args) => {
        const priorResult = previous ? await previous(...args) : undefined
        const effectiveArgs = event === 'context' && priorResult && typeof priorResult === 'object' && 'messages' in priorResult
          ? [{ ...(args[0] as object), ...(priorResult as object) }, ...args.slice(1)]
          : args
        const result = await handler(...effectiveArgs)
        return result ?? priorResult
      })
    },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
    getThinkingLevel: () => 'medium'
  } as unknown as ExtensionAPI
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => '/history/session.jsonl', getBranch: () => [] }, ui: { getEditorText: () => '' }, abort: vi.fn() } as unknown as ExtensionContext
  return { api, ctx, handlers, commands }
}

afterEach(() => vi.useRealTimers())

describe('terminal bridge lifecycle', () => {
  it('registers one question tool with fixed-column sketch guidance, and no terminal-only alias', async () => {
    const { api } = extension()
    await terminalExtension(api)
    const tools = vi.mocked(api.registerTool).mock.calls.map(([tool]) => tool)
    expect(tools.some(tool => tool.name === 'ask_user_question')).toBe(false)
    const question = tools.find(tool => tool.name === 'ask_user')!
    expect(question.description).toContain('outer `+` corners in fixed columns')
    expect(question.description).toContain('same columns on every content row')
  })

  it('discovers the native active tool set outside plan mode and respects the plan allowlist', async () => {
    const state: TerminalPlanRunState = { active: false, allowedTools: new Set(), connectors: ['connector-1'] }
    const { api } = extension()
    api.getActiveTools = () => ['read', 'get_capabilities']
    api.getAllTools = () => [
      { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
      { name: 'get_capabilities', description: 'Inspect tools', parameters: { type: 'object' } },
      { name: 'bash', description: 'Run a command', parameters: { type: 'object' } }
    ] as never
    await terminalExtension(api, state)
    const discovery = vi.mocked(api.registerTool).mock.calls.map(([tool]) => tool).find(tool => tool.name === 'get_capabilities')!
    const ordinary = await discovery.execute('caps-1', {}, undefined, undefined, {} as ExtensionToolContext)
    const ordinaryText = ordinary.content[0].type === 'text' ? ordinary.content[0].text : ''
    const ordinaryInventory = JSON.parse(ordinaryText)
    expect(ordinaryInventory.tools.map((tool: { name: string }) => tool.name)).toEqual(['read', 'get_capabilities'])
    expect(ordinaryInventory.connectors).toEqual(['connector-1'])

    state.active = true
    state.allowedTools = new Set(['read'])
    const planned = await discovery.execute('caps-2', {}, undefined, undefined, {} as ExtensionToolContext)
    const plannedText = planned.content[0].type === 'text' ? planned.content[0].text : ''
    expect(JSON.parse(plannedText).tools).toEqual([{ name: 'read', description: 'Read a file', state: 'callable' }])
  })

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

  it('registers the shared todo tool and records each list on the harness run', async () => {
    const { api } = extension()
    await terminalExtension(api)
    const todo = vi.mocked(api.registerTool).mock.calls.map(([tool]) => tool).find(tool => tool.name === 'todo_write')!
    expect(todo.description).toContain('The user watches this list')
    const result = await todo.execute('c-1', { items: [{ text: 'Fix it', status: 'in_progress' }] }, undefined, undefined, {} as ExtensionToolContext)
    expect(result.content).toEqual([{ type: 'text', text: '[~] Fix it' }])
    expect(transport.telemetry).toHaveBeenCalledWith('todo', { items: [{ text: 'Fix it', status: 'in_progress' }] })
    transport.telemetry.mockClear()
    await todo.execute('c-2', { items: [{ text: '', status: 'pending' }] }, undefined, undefined, {} as ExtensionToolContext)
    expect(transport.telemetry).not.toHaveBeenCalledWith('todo', expect.anything())
  })

  it('rehydrates the current plan and todo in context after compaction', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['read', 'todo_write']) }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Plan the migration', systemPromptOptions: { sections: {} } }, ctx)
    await handlers.get('context')!({ messages: [{ role: 'user', content: 'Plan the migration', timestamp: 1 }] }, ctx)
    await handlers.get('tool_result')!({
      toolName: 'todo_write', isError: false,
      input: { items: [{ text: 'Inspect compatibility', status: 'completed' }, { text: 'Resolve the API question', status: 'in_progress' }] },
      content: []
    }, ctx)

    const compacted = { messages: [{ role: 'compactionSummary', summary: 'Earlier research.', tokensBefore: 50_000, timestamp: 2 }] }
    const first = await handlers.get('context')!(compacted, ctx) as { messages: { content?: string }[] }
    expect(first.messages.at(-1)?.content).toContain('Plan the migration')
    expect(first.messages.at(-1)?.content).toContain('Resolve the API question')
    expect(first.messages.at(-1)?.content).toContain('Plan mode is on for this request')
    const next = await handlers.get('context')!(compacted, ctx) as { messages: { content?: string }[] }
    expect(next.messages.at(-1)?.content).toContain('Resolve the API question')

    state.active = false
    await handlers.get('agent_settled')!({}, ctx)
    const after = await handlers.get('context')!(compacted, ctx) as { messages: { content?: string }[] } | undefined
    expect(after?.messages.some(message => message.content?.includes('Plan mode is on')) ?? false).toBe(false)
  })

  it('derives a provisional name and adds the session state to the request', async () => {
    const { api, ctx, handlers } = extension()
    let name: string | undefined
    api.getSessionName = () => name
    api.setSessionName = vi.fn((value: string) => { name = value })
    const original = transport.socket.getMockImplementation()
    transport.socket.mockImplementation(async (_connection, call) => {
      if (call === 'terminal.policy') return { allowed: true }
      return call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }
    })
    try {
      await terminalExtension(api)
      await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Please fix the login redirect before release', systemPromptOptions: { sections: {} } }, ctx)
      expect(name).toBe('Fix the login redirect before release')
      const result = await handlers.get('context')!({ messages: [{ role: 'user', content: 'Please fix the login redirect before release', timestamp: 1 }] }, ctx) as { messages: { content?: string }[] }
      expect(result.messages.at(-1)?.content).toContain('Name: "Fix the login redirect before release".')
      expect(result.messages.at(-1)?.content).toContain('Todo for this run: The todo list is empty.')
      expect(result.messages.at(-1)?.content).toContain('This is the first turn')
    } finally {
      transport.socket.mockImplementation(original!)
    }
  })

  it('adds plan instructions and eligible profiles for one request, then restores the normal profile list', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['read']), subagentProfiles: { normal: 'All profiles', plan: 'Eligible research profiles only' } }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    const planned = { messageType: 'user', prompt: 'inspect this', systemPrompt: 'stable prefix', systemPromptOptions: { sections: { identity: 'identity' } } }
    await handlers.get('before_agent_start')!(planned, ctx)
    expect(planned.systemPromptOptions.sections).toEqual({ identity: 'identity', plan: PLAN_INSTRUCTIONS, subagents: 'Eligible research profiles only' })
    expect(planned.systemPrompt).toBe('stable prefix')

    state.active = false
    const ordinary = { messageType: 'user', prompt: 'now implement', systemPrompt: 'stable prefix', systemPromptOptions: { sections: { identity: 'identity', plan: PLAN_INSTRUCTIONS } } }
    await handlers.get('before_agent_start')!(ordinary, ctx)
    expect(ordinary.systemPromptOptions.sections).toEqual({ identity: 'identity', subagents: 'All profiles' })
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

  it('checks plan-mode profile eligibility before consulting terminal policy', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['spawn_subagent']) }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    transport.socket.mockImplementation(async (_connection: unknown, call: string, params?: Record<string, unknown>) => {
      const input = params?.input as Record<string, unknown> | undefined
      if (call === 'terminal.subagents.planSafe') return { allowed: input?.agent === 'explorer', reason: 'Unsafe plan profile.' }
      if (call === 'terminal.policy') return { allowed: true }
      return call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }
    })
    const policyCalls = transport.socket.mock.calls.filter(([, call]) => call === 'terminal.policy').length

    const denied = await handlers.get('tool_call')!({ toolName: 'spawn_subagent', toolCallId: 'call-unsafe', input: { agent: 'worker' } }, ctx)
    expect(denied).toEqual({ block: true, reason: 'Unsafe plan profile.' })
    expect(transport.socket.mock.calls.filter(([, call]) => call === 'terminal.policy')).toHaveLength(policyCalls)

    const allowed = await handlers.get('tool_call')!({ toolName: 'spawn_subagent', toolCallId: 'call-safe', input: { agent: 'explorer' } }, ctx)
    expect(allowed).toBeUndefined()
    const calls = transport.socket.mock.calls.map(([, call]) => call)
    expect(calls.lastIndexOf('terminal.subagents.planSafe')).toBeLessThan(calls.lastIndexOf('terminal.policy'))
  })

  it('passes plan-mode Bash to policy only when it stays read-only', async () => {
    const state: TerminalPlanRunState = { active: true, allowedTools: new Set(['read', 'bash']) }
    const { api, ctx, handlers } = extension()
    await terminalExtension(api, state)
    transport.socket.mockImplementation(async (_connection: unknown, call: string) => {
      if (call === 'terminal.policy') return { allowed: true }
      return call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }
    })

    const policyCalls = () => transport.socket.mock.calls.filter(([, call]) => call === 'terminal.policy').length
    const before = policyCalls()
    const outside = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'call-outside', input: { command: 'ls', workspaceWriteScope: 'outside' } }, ctx)
    expect(outside).toMatchObject({ block: true, reason: expect.stringContaining('Plan mode Bash is read-only') })
    const denied = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'call-denied', input: { command: 'ls && osascript -e 1' } }, ctx)
    expect(denied).toMatchObject({ block: true, reason: expect.stringContaining('osascript') })
    expect(policyCalls()).toBe(before)

    const allowed = await handlers.get('tool_call')!({ toolName: 'bash', toolCallId: 'call-read', input: { command: 'git log --oneline -3' } }, ctx)
    expect(allowed).toBeUndefined()
    expect(policyCalls()).toBe(before + 1)
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
    expect([...next.commands.keys()]).toEqual([])
    await next.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, next.ctx)
    expect(transport.telemetry.mock.calls.filter(([event]) => event === 'shutdown')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes a $skill anywhere in the message required for that request', async () => {
    const { api, ctx, handlers } = extension()
    const folder = mkdtempSync(join(tmpdir(), 'harness-required-skill-'))
    const path = join(folder, 'SKILL.md')
    writeFileSync(path, '---\nname: review\ndescription: Review a change.\n---\n\nInspect the diff.\n')
    Object.assign(api, {
      getSettings: () => ({ enableSkillCommands: true }),
      getCommands: () => [{ name: 'skill:review', description: 'Review a change.', source: 'skill', sourceInfo: { path, baseDir: folder, source: 'user', scope: 'user', origin: 'top-level' } }]
    })
    await terminalExtension(api)
    const result = await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Please $review this', systemPromptOptions: { sections: {} } }, ctx) as { message?: { customType?: string; content?: string; display?: boolean } } | undefined
    expect(result?.message).toMatchObject({ customType: 'xingular-required-skills', display: false })
    expect(result?.message?.content).toContain('The person required these skills for this request.')
    expect(result?.message?.content).toContain('Inspect the diff.')
    expect(result?.message?.content).toContain(folder)
  })

  it('does not make an unknown or disabled skill required', async () => {
    const { api, ctx, handlers } = extension()
    Object.assign(api, {
      getSettings: () => ({ enableSkillCommands: false }),
      getCommands: () => []
    })
    await terminalExtension(api)
    const result = await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Please $review this', systemPromptOptions: { sections: {} } }, ctx) as { message?: { customType?: string } } | undefined
    expect(result?.message?.customType).not.toBe('xingular-required-skills')
  })

  it('canonicalizes native terminal write paths before policy and execution', async () => {
    const original = transport.socket.getMockImplementation()
    const callStart = transport.socket.mock.calls.length
    transport.socket.mockImplementation(async (_connection: unknown, call: string) => {
      if (call === 'terminal.policy') return { allowed: true }
      return call === 'control.claim' ? { key: 'lexical-key' } : { tools: [] }
    })
    try {
      const { api, ctx, handlers } = extension()
      ctx.cwd = resolve(process.cwd(), 'src')
      await terminalExtension(api)
      await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Write a file', systemPromptOptions: { sections: {} } }, ctx)
      const input = { path: 'README.md', content: 'draft' }
      expect(await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'call-write', input }, ctx)).toBeUndefined()
      const canonicalPath = resolveWritePath('README.md', ctx.cwd)
      expect(input.path).toBe(canonicalPath)
      const policyCall = transport.socket.mock.calls.slice(callStart).find(([, call]) => call === 'terminal.policy')
      expect(policyCall?.[2]).toMatchObject({ tool: 'write', args: { path: canonicalPath, content: 'draft' } })
    } finally {
      transport.socket.mockImplementation(original!)
    }
  })
})
