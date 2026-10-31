import { describe, expect, it, vi } from 'vitest'

import { createStopGateState, handoffFields, MAX_STOP_GATE_NUDGES, nudgeText, sessionCheckModel, stopGate, stopGateNotice, stopOutcome, type StopGateEvent, type StopGateOptions } from './stopGate'
import type { GoalState } from './goal'
import type { TodoItem } from './contracts'

type Settle = { continue?: boolean; entries?: { type: string; customType?: string; content?: string; display?: boolean }[] } | undefined

/** The gate as Pi calls it, without a Pi session. */
function gateHarness(options: Partial<StopGateOptions> = {}) {
  const state = options.state ?? createStopGateState(options.initialTodo)
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>()
  const events: StopGateEvent[] = []
  stopGate({ ...options, state, onEvent: (event) => void events.push(event) })({
    on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers.set(name, handler)
    }
  } as never)
  const call = (name: string, event: unknown, ctx: unknown = {}): unknown => handlers.get(name)?.(event, ctx)
  return {
    state,
    events,
    start: (prompt = 'Implement the handoff', messageType = 'user') => call('before_agent_start', { messageType, prompt }),
    todo: (items: TodoItem[] | unknown[], isError = false) => call('tool_result', { toolName: 'todo_write', isError, input: { items } }),
    tool: (toolName: string) => call('tool_call', { toolName }),
    settle: async (event: Partial<{ outcome: string; continue: boolean; entries: unknown[]; context: unknown }> = {}, ctx: unknown = {}) =>
      await call('agent_before_settle', { outcome: 'completed', continue: false, entries: [], context: { llmMessages: [] }, ...event }, ctx) as Settle
  }
}

const open: TodoItem[] = [{ text: 'Port the health route', status: 'completed' }, { text: 'Port the courses route', status: 'in_progress' }, { text: 'Shadow-compare both', status: 'pending' }]

describe('stop gate: the todo layer', () => {
  it('sends back a reply that ends with open items, naming them', async () => {
    const gate = gateHarness()
    gate.start()
    gate.todo(open)
    gate.tool('edit')
    const result = await gate.settle({ entries: [{ type: 'custom', customType: 'earlier' }] })
    expect(result?.continue).toBe(true)
    expect(result?.entries?.map((entry) => entry.customType)).toEqual(['earlier', 'xingular-stop-gate'])
    const nudge = result!.entries![1]
    expect(nudge).toMatchObject({ type: 'custom_message', display: true })
    expect(nudge.content).toContain('- Port the courses route\n- Shadow-compare both')
    expect(nudge.content).not.toContain('Port the health route')
    expect(nudge.content).not.toContain('finish')
    expect(gate.events).toEqual([{ kind: 'todo', count: 1, open: open.slice(1) }])
  })

  it('stays silent for an aborted or failed reply, a slice the guard ended, a plan, or another continuation', async () => {
    for (const [options, event, ctx] of [
      [{}, { outcome: 'aborted' }, {}],
      [{}, { outcome: 'error' }, {}],
      [{}, {}, { signal: { aborted: true } }],
      [{}, { continue: true }, {}],
      [{ sliceEnded: () => true }, {}, {}],
      [{ failed: () => true }, {}, {}],
      [{ active: () => false }, {}, {}]
    ] as [Partial<StopGateOptions>, Record<string, unknown>, unknown][]) {
      const gate = gateHarness(options)
      gate.start()
      gate.todo(open)
      gate.tool('edit')
      expect(await gate.settle(event, ctx)).toBeUndefined()
      expect(gate.events).toEqual([])
    }
  })

  it('nudges at most the cap, and never after a nudge that produced no work', async () => {
    const capped = gateHarness()
    capped.start()
    capped.todo(open)
    for (let nudge = 1; nudge <= MAX_STOP_GATE_NUDGES; nudge += 1) {
      capped.tool('bash')
      expect((await capped.settle())?.continue).toBe(true)
    }
    capped.tool('bash')
    expect(await capped.settle()).toBeUndefined()
    expect(stopOutcome(capped.state)).toMatchObject({ code: 'unfinished' })

    const idle = gateHarness()
    idle.start()
    idle.todo(open)
    expect((await idle.settle())?.continue).toBe(true)
    // Rewriting the todo list or naming the session is not work.
    idle.tool('todo_write')
    idle.tool('session_name')
    expect(await idle.settle()).toBeUndefined()
  })

  it('resets on a person\'s message only, starting from the inherited list', async () => {
    const inherited: TodoItem[] = [{ text: 'Resume the port', status: 'in_progress' }]
    const gate = gateHarness({ initialTodo: inherited })
    gate.start()
    expect(gate.state.todo).toEqual(inherited)
    gate.tool('read')
    expect((await gate.settle())?.continue).toBe(true)
    gate.start('Continue', 'custom')
    expect(gate.state.nudges).toBe(1)
    gate.start('Next request', 'user')
    expect(gate.state).toMatchObject({ nudges: 0, callsInReply: 0, request: 'Next request', todo: inherited })
  })

  it('ignores a todo write that failed or does not validate', () => {
    const gate = gateHarness()
    gate.start()
    gate.todo(open)
    gate.todo([{ text: 'x', status: 'completed' }], true)
    gate.todo([{ text: '', status: 'done' }])
    expect(gate.state.todo).toEqual(open)
  })
})

describe('stop gate: the rest', () => {
  it('asks the session\'s own model at low effort through Pi\'s registry', async () => {
    const streamSimple = vi.fn(() => ({ result: async () => ({ content: [{ type: 'text', text: '{"verdict":"done","reason":"ok"}' }], stopReason: 'stop', usage: { input: 1 } }) }))
    const model = { id: 'gpt-6-luna', provider: 'openai-codex', reasoning: true }
    const ask = sessionCheckModel({ model, modelRegistry: { streamSimple } })!
    const answer = await ask('system', 'user', new AbortController().signal)
    expect(answer.text).toContain('"verdict":"done"')
    expect(streamSimple).toHaveBeenCalledWith(model, expect.objectContaining({ systemPrompt: 'system' }), expect.objectContaining({ reasoning: 'low' }))
    expect(sessionCheckModel({})).toBeNull()
    // opencode-go rejects a request without a session id.
    const withSession = sessionCheckModel({ model, modelRegistry: { streamSimple }, sessionManager: { getSessionId: () => 'native-1' } })!
    await withSession('system', 'user', new AbortController().signal)
    expect(streamSimple).toHaveBeenLastCalledWith(model, expect.anything(), expect.objectContaining({ sessionId: 'native-1' }))
    const failing = sessionCheckModel({ model, modelRegistry: { streamSimple: () => ({ result: async () => ({ content: [], stopReason: 'error', errorMessage: 'quota' }) }) } })!
    await expect(failing('s', 'u', new AbortController().signal)).rejects.toThrow('quota')
  })

  it('names each nudge for the run record', () => {
    expect(stopGateNotice({ kind: 'todo', count: 1, open: open.slice(1) })).toBe('Stop gate 1: the reply ended with 2 open todo items; continuing.')
  })

  it('says the list is progress, not the limit of the work', () => {
    expect(nudgeText(1, 3, open)).toContain('The list shows progress; it is not the limit of the work.')
  })

  it('ends a reply for the person when its goal is blocked, and leaves work when a goal is limited (ADR-0072)', () => {
    const state = createStopGateState()
    const goal = (status: GoalState['status'], lastReason: string): GoalState => ({ goalId: 'g', objective: 'x', status, limits: { rounds: 30, hours: 8 }, rounds: 3, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0, claimed: false, lastReason })
    expect(stopOutcome(state, goal('blocked', 'The deploy key is missing.'))).toMatchObject({ code: 'needs_person', reason: 'The deploy key is missing.' })
    expect(handoffFields(state, goal('blocked', 'The deploy key is missing.')).blocked).toBe('The deploy key is missing.')
    expect(stopOutcome(state, goal('budget_limited', 'The goal reached its limit.'))).toMatchObject({ code: 'unfinished' })
    expect(stopOutcome(state, goal('paused', ''))).toMatchObject({ code: 'unfinished' })
    expect(stopOutcome(state, goal('complete', ''))).toBeNull()
    expect(stopOutcome(state, goal('active', ''))).toBeNull()
  })

  it('keeps a long open list readable', () => {
    const many = Array.from({ length: 15 }, (_, index): TodoItem => ({ text: `Step ${index + 1}`, status: 'pending' }))
    const text = nudgeText(2, 3, many)
    expect(text).toContain('(2/3)')
    expect(text).toContain('- Step 12')
    expect(text).not.toContain('- Step 13')
    expect(text).toContain('…and 3 more')
  })
})
