import { describe, expect, it, vi } from 'vitest'

import type { CheckModel } from './completionCheck'
import { createStopGateState, handoffFields, MAX_STOP_GATE_NUDGES, nudgeText, sessionCheckModel, stopGate, stopGateNotice, stopOutcome, type StopGateEvent, type StopGateOptions } from './stopGate'
import type { TodoItem } from './contracts'

type Settle = { continue?: boolean; entries?: { type: string; customType?: string; content?: string; display?: boolean }[] } | undefined

/** A check model that answers from a queue, recording what it was asked. */
function checkModel(...answers: (string | Error)[]) {
  const asked: { system: string; user: string }[] = []
  const ask: CheckModel = async (system, user) => {
    asked.push({ system, user })
    const next = answers.shift() ?? '{"verdict":"done","reason":"ok","next":""}'
    if (next instanceof Error) throw next
    return { text: next, message: { usage: { input: 10, output: 5 } } }
  }
  return { ask, asked }
}

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
const closed: TodoItem[] = [{ text: 'Port the health route', status: 'completed' }, { text: 'Port the courses route', status: 'completed' }]

describe('stop gate: the todo layer', () => {
  it('sends back a reply that ends with open items, naming them, without asking a model', async () => {
    const model = checkModel()
    const gate = gateHarness({ check: () => model.ask })
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
    expect(model.asked).toHaveLength(0)
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

describe('stop gate: the completion check layer (ADR-0071)', () => {
  const transcript = { llmMessages: [{ role: 'user', content: 'Implement the handoff docs/handoffs/B.md' }, { role: 'assistant', content: [{ type: 'text', text: 'B0 is done. Should I start B1, or do you want to confirm the worktree first?' }] }] }

  it('sends back a reply whose closed list hides unfinished work, with the check\'s reason and next step', async () => {
    const model = checkModel('{"verdict":"continue","reason":"Only B0 of B0–B3 is done and the handoff answers the worktree question.","next":"Start B1: the Hono skeleton."}')
    const gate = gateHarness({ check: () => model.ask })
    gate.start('Implement the handoff docs/handoffs/B.md')
    gate.todo(closed)
    gate.tool('bash')
    const result = await gate.settle({ context: transcript })
    expect(result?.continue).toBe(true)
    const nudge = result!.entries![0]
    expect(nudge.customType).toBe('xingular-completion-check')
    expect(nudge.content).toContain('Completion check (1/3)')
    expect(nudge.content).toContain('Next: Start B1: the Hono skeleton.')
    // The check sees the request, the list and the reply, not the doer's prompt.
    expect(model.asked[0].user).toContain('Implement the handoff docs/handoffs/B.md')
    expect(model.asked[0].user).toContain('- [completed] Port the courses route')
    expect(model.asked[0].user).toContain('do you want to confirm the worktree first?')
    expect(gate.events.at(-1)).toMatchObject({ kind: 'check', count: 1, verdict: { verdict: 'continue' } })
  })

  it('ends a reply the check finds done, and counts the check\'s request', async () => {
    const recorded: unknown[] = []
    const model = checkModel('{"verdict":"done","reason":"All four routes are ported and tested.","next":""}')
    const gate = gateHarness({ check: () => model.ask })
    gate.state.recordUsage = (message) => void recorded.push(message)
    gate.start()
    gate.todo(closed)
    gate.tool('bash')
    expect(await gate.settle({ context: transcript })).toBeUndefined()
    expect(stopOutcome(gate.state)).toBeNull()
    expect(recorded).toEqual([{ usage: { input: 10, output: 5 } }])
  })

  it('lets the check, not the doer, decide that the person is needed', async () => {
    const model = checkModel('Here is my answer: {"verdict":"needs_person","reason":"Moving the route changes production; the person must approve the cutover.","next":""}')
    const gate = gateHarness({ check: () => model.ask })
    gate.start()
    gate.tool('bash')
    expect(await gate.settle({ context: transcript })).toBeUndefined()
    expect(stopOutcome(gate.state)).toMatchObject({ code: 'needs_person', reason: 'Moving the route changes production; the person must approve the cutover.' })
    expect(handoffFields(gate.state).blocked).toBe('Moving the route changes production; the person must approve the cutover.')
  })

  it('never checks a reply that did no work: a question gets its answer and ends', async () => {
    const model = checkModel()
    const gate = gateHarness({ check: () => model.ask })
    gate.start('What does B0 cover?')
    gate.tool('todo_write')
    expect(await gate.settle({ context: transcript })).toBeUndefined()
    expect(model.asked).toHaveLength(0)
  })

  it('fails open: no verdict leaves the reply as it was, and is recorded', async () => {
    for (const answer of ['I think it is mostly done.', new Error('rate limited')]) {
      const gate = gateHarness({ check: () => checkModel(answer).ask })
      gate.start()
      gate.tool('bash')
      expect(await gate.settle({ context: transcript })).toBeUndefined()
      expect(stopOutcome(gate.state)).toBeNull()
      expect(gate.events.at(-1)).toMatchObject({ kind: 'check', verdict: null })
    }
    const off = gateHarness({ check: null })
    off.start()
    off.tool('bash')
    expect(await off.settle()).toBeUndefined()
    expect(off.events).toEqual([])
  })

  it('shares the cap with the todo layer, and a check that said continue leaves the reply unfinished when the model stops anyway', async () => {
    const model = checkModel(
      '{"verdict":"continue","reason":"B1 remains.","next":"Start B1."}',
      '{"verdict":"continue","reason":"B2 remains.","next":"Start B2."}'
    )
    const gate = gateHarness({ check: () => model.ask })
    gate.start()
    gate.todo(open)
    gate.tool('edit')
    expect((await gate.settle())?.entries?.[0].customType).toBe('xingular-stop-gate')
    gate.todo(closed)
    gate.tool('edit')
    expect((await gate.settle({ context: transcript }))?.entries?.[0].customType).toBe('xingular-completion-check')
    gate.tool('edit')
    expect((await gate.settle({ context: transcript }))?.entries?.[0].content).toContain('(3/3)')
    gate.tool('edit')
    // The cap is reached: no fourth nudge and no fourth model call.
    expect(await gate.settle({ context: transcript })).toBeUndefined()
    expect(model.asked).toHaveLength(2)
    expect(stopOutcome(gate.state)).toMatchObject({ code: 'unfinished', reason: 'B2 remains.' })
    expect(handoffFields(gate.state).next).toBe('Start B2.')
  })

  it('does not ask again after a check nudge that produced no work', async () => {
    const model = checkModel('{"verdict":"continue","reason":"B1 remains.","next":"Start B1."}')
    const gate = gateHarness({ check: () => model.ask })
    gate.start()
    gate.tool('bash')
    expect((await gate.settle({ context: transcript }))?.continue).toBe(true)
    expect(await gate.settle({ context: transcript })).toBeUndefined()
    expect(model.asked).toHaveLength(1)
    expect(stopOutcome(gate.state)).toMatchObject({ code: 'unfinished' })
  })

  it('asks the session\'s own model at low effort through Pi\'s registry', async () => {
    const streamSimple = vi.fn(() => ({ result: async () => ({ content: [{ type: 'text', text: '{"verdict":"done","reason":"ok"}' }], stopReason: 'stop', usage: { input: 1 } }) }))
    const model = { id: 'gpt-6-luna', provider: 'openai-codex', reasoning: true }
    const ask = sessionCheckModel({ model, modelRegistry: { streamSimple } })!
    const answer = await ask('system', 'user', new AbortController().signal)
    expect(answer.text).toContain('"verdict":"done"')
    expect(streamSimple).toHaveBeenCalledWith(model, expect.objectContaining({ systemPrompt: 'system' }), expect.objectContaining({ reasoning: 'low' }))
    expect(sessionCheckModel({})).toBeNull()
    const failing = sessionCheckModel({ model, modelRegistry: { streamSimple: () => ({ result: async () => ({ content: [], stopReason: 'error', errorMessage: 'quota' }) }) } })!
    await expect(failing('s', 'u', new AbortController().signal)).rejects.toThrow('quota')
  })

  it('names each nudge and check for the run record', () => {
    expect(stopGateNotice({ kind: 'todo', count: 1, open: open.slice(1) })).toBe('Stop gate 1: the reply ended with 2 open todo items; continuing.')
    expect(stopGateNotice({ kind: 'check', count: 2, verdict: { verdict: 'continue', reason: 'B1 remains.', next: '' } })).toBe('Completion check 2: continue — B1 remains.')
    expect(stopGateNotice({ kind: 'check', count: 1, verdict: null, error: 'the completion check timed out' })).toContain('no verdict (the completion check timed out)')
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
