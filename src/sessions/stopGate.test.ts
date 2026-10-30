import { describe, expect, it } from 'vitest'

import { createStopGateState, handoffFields, MAX_STOP_GATE_NUDGES, nudgeText, stopGate, stopOutcome, type StopGateOptions } from './stopGate'
import type { TodoItem } from './contracts'

type Settle = { continue?: boolean; entries?: { type: string; customType?: string; content?: string; display?: boolean }[] } | undefined

/** The gate as Pi calls it, without a Pi session. */
function gateHarness(options: Partial<StopGateOptions> = {}) {
  const state = options.state ?? createStopGateState(options.initialTodo)
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>()
  const nudges: number[] = []
  stopGate({ ...options, state, onNudge: (count) => void nudges.push(count) })({
    on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers.set(name, handler)
    }
  } as never)
  const call = (name: string, event: unknown, ctx: unknown = {}): unknown => handlers.get(name)?.(event, ctx)
  return {
    state,
    nudges,
    start: (messageType = 'user') => call('before_agent_start', { messageType }),
    todo: (items: TodoItem[] | unknown[], isError = false) => call('tool_result', { toolName: 'todo_write', isError, input: { items } }),
    tool: (toolName: string) => call('tool_call', { toolName }),
    settle: (event: Partial<{ outcome: string; continue: boolean; entries: unknown[] }> = {}, ctx: unknown = {}) =>
      call('agent_before_settle', { outcome: 'completed', continue: false, entries: [], ...event }, ctx) as Settle
  }
}

const open: TodoItem[] = [{ text: 'Port the health route', status: 'completed' }, { text: 'Port the courses route', status: 'in_progress' }, { text: 'Shadow-compare both', status: 'pending' }]

describe('stop gate', () => {
  it('sends back a reply that ends with open items, naming them', () => {
    const gate = gateHarness()
    gate.start()
    gate.todo(open)
    gate.tool('edit')
    const result = gate.settle({ entries: [{ type: 'custom', customType: 'earlier' }] })
    expect(result?.continue).toBe(true)
    // Earlier handlers' entries are kept; the nudge is appended after them.
    expect(result?.entries?.map((entry) => entry.customType)).toEqual(['earlier', 'xingular-stop-gate'])
    const nudge = result!.entries![1]
    expect(nudge).toMatchObject({ type: 'custom_message', display: true })
    expect(nudge.content).toContain('2 open todo items')
    expect(nudge.content).toContain('- Port the courses route\n- Shadow-compare both')
    expect(nudge.content).not.toContain('Port the health route')
    expect(gate.nudges).toEqual([1])
  })

  it('stays silent when nothing is open, or the list was never written', () => {
    const gate = gateHarness()
    gate.start()
    expect(gate.settle()).toBeUndefined()
    gate.todo([{ text: 'Answer the question', status: 'completed' }])
    expect(gate.settle()).toBeUndefined()
    expect(stopOutcome(gate.state)).toBeNull()
  })

  it('stays silent for an aborted or failed reply, a slice the guard ended, or another continuation', () => {
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
      expect(gate.settle(event, ctx)).toBeUndefined()
      expect(gate.nudges).toEqual([])
    }
  })

  it('stays silent once the reply declared a blocker with finish', () => {
    const gate = gateHarness()
    gate.start()
    gate.todo(open)
    gate.state.finish = { status: 'needs_decision', reason: 'The cutover changes a production route.', needs: '' }
    expect(gate.settle()).toBeUndefined()
    expect(stopOutcome(gate.state)).toMatchObject({ code: 'needs_person' })
  })

  it('nudges at most the cap, and never after a nudge that produced no work', () => {
    const capped = gateHarness()
    capped.start()
    capped.todo(open)
    for (let nudge = 1; nudge <= MAX_STOP_GATE_NUDGES; nudge += 1) {
      capped.tool('bash')
      expect(capped.settle()?.continue).toBe(true)
    }
    capped.tool('bash')
    expect(capped.settle()).toBeUndefined()
    expect(capped.nudges).toEqual([1, 2, 3])
    expect(stopOutcome(capped.state)).toMatchObject({ code: 'unfinished' })

    const idle = gateHarness()
    idle.start()
    idle.todo(open)
    expect(idle.settle()?.continue).toBe(true)
    // Rewriting the todo list or calling finish is not work.
    idle.tool('todo_write')
    idle.tool('finish')
    expect(idle.settle()).toBeUndefined()
  })

  it('resets on a person\'s message only, starting from the inherited list', () => {
    const inherited: TodoItem[] = [{ text: 'Resume the port', status: 'in_progress' }]
    const gate = gateHarness({ initialTodo: inherited })
    gate.start()
    expect(gate.state.todo).toEqual(inherited)
    gate.tool('read')
    expect(gate.settle()?.continue).toBe(true)
    // Pi's own continuation is not a new reply: the nudge count stays.
    gate.start('custom')
    expect(gate.state.nudges).toBe(1)
    gate.start('user')
    expect(gate.state.nudges).toBe(0)
    expect(gate.state.todo).toEqual(inherited)
  })

  it('ignores a todo write that failed or does not validate', () => {
    const gate = gateHarness()
    gate.start()
    gate.todo(open)
    gate.todo([{ text: 'x', status: 'completed' }], true)
    gate.todo([{ text: '', status: 'done' }])
    expect(gate.state.todo).toEqual(open)
  })

  it('hands the checkpoint the todo list and the declared blocker', () => {
    const state = createStopGateState(open)
    expect(handoffFields(state)).toEqual({ done: [{ item: 'Port the health route', evidence: [] }], next: 'Port the courses route' })
    state.finish = { status: 'blocked', reason: 'No staging database.', needs: 'Create one.' }
    expect(handoffFields(state).blocked).toBe('No staging database. Needs: Create one.')
    expect(handoffFields(null)).toEqual({ done: [], next: '' })
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
