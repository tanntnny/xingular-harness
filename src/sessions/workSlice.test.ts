import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSliceState,
  DEFAULT_SLICE_POLICY,
  parseWorkSlice,
  SLICE_CONTINUE_CUSTOM_TYPE,
  sliceContinuation,
  type SliceContinuationOptions,
  sliceLimitReached,
  WorkSliceError,
  workSliceGuard,
  type SlicePolicy
} from './workSlice'

const policy = (overrides: Partial<SlicePolicy> = {}): SlicePolicy => ({ ...DEFAULT_SLICE_POLICY, ...overrides })

/** The guard as Pi calls it, without a Pi session. */
function guardHarness(limits: SlicePolicy, state = createSliceState(limits)) {
  const handlers = new Map<string, (event: unknown) => unknown>()
  workSliceGuard({ policy: limits, state })({
    on: (name: string, handler: (event: unknown) => unknown) => {
      handlers.set(name, handler)
    }
  } as never)
  const call = (name: string, event: unknown = {}): unknown => handlers.get(name)?.(event)
  return { call, state, start: () => call('before_agent_start', { messageType: 'user' }) }
}

const toolCall = (toolName: string, input: Record<string, unknown> = {}): unknown => ({ toolName, input })

afterEach(() => vi.unstubAllEnvs())

describe('work slice policy', () => {
  it('uses the foundation defaults and accepts bounded overrides', () => {
    expect(parseWorkSlice(undefined)).toEqual(DEFAULT_SLICE_POLICY)
    expect(DEFAULT_SLICE_POLICY).toMatchObject({ enabled: true, maxToolCalls: 320, maxMinutes: 60, maxNewTokens: 0, maxSlices: 8, continue: true })
    expect(parseWorkSlice({ maxToolCalls: 10, maxMinutes: 5, maxNewTokens: 20_000, maxSlices: 2, continue: false })).toEqual({
      enabled: true, maxToolCalls: 10, maxMinutes: 5, maxNewTokens: 20_000, maxSlices: 2, continue: false
    })
    expect(parseWorkSlice({ maxToolCalls: 0 }).maxToolCalls).toBe(0)
  })

  it('can be turned off for a run or at launch', () => {
    expect(parseWorkSlice({ enabled: false }).enabled).toBe(false)
    expect(() => parseWorkSlice({ enabled: 'no' })).toThrow(WorkSliceError)
    vi.stubEnv('XINGULAR_WORK_SLICE', 'off')
    expect(parseWorkSlice(undefined).enabled).toBe(false)
    // An explicit per-run policy wins over the launch default.
    expect(parseWorkSlice({ maxToolCalls: 5 }).enabled).toBe(true)
  })

  it('refuses values a run cannot honour', () => {
    for (const input of [{ maxToolCalls: 1.5 }, { maxToolCalls: -1 }, { maxToolCalls: 5_000 }, { maxSlices: 0.5 }, { continue: 'yes' }, { unknown: 1 }, 7]) {
      expect(() => parseWorkSlice(input)).toThrow(WorkSliceError)
    }
  })

  it('names the limit a reply reached', () => {
    const state = createSliceState(policy({ maxToolCalls: 3 }))
    state.steps = 3
    expect(sliceLimitReached(policy({ maxToolCalls: 3 }), state)).toBe('3 tool calls')
    state.steps = 1
    state.tokens = 60_000
    expect(sliceLimitReached(policy({ maxNewTokens: 60_000 }), state)).toBe('60k new tokens')
    // No token cap by default: the tool calls and the clock are the bound.
    expect(sliceLimitReached(policy(), state)).toBeNull()
    state.tokens = 1_000_000
    expect(sliceLimitReached(policy(), state)).toBeNull()
    state.tokens = 0
    state.startedAt = Date.now() - 21 * 60_000
    expect(sliceLimitReached(policy({ maxMinutes: 20 }), state)).toBe('20 minutes')
    // The defaults allow three times as long before a checkpoint.
    expect(sliceLimitReached(policy(), state)).toBeNull()
  })

  it('counts a reply and starts over at the next one', () => {
    const state = createSliceState(policy())
    const guard = guardHarness(policy(), state)
    guard.start()
    guard.call('tool_call', toolCall('read', { path: 'a' }))
    expect(state.steps).toBe(1)
    guard.start()
    expect(state.steps).toBe(0)
    expect(state.endedBy).toBeNull()
  })

  it('keeps one budget across the continuations of a reply', () => {
    // Pi emits agent_start for every continuation (a stop-gate nudge, delivered subagent results, a
    // plan repair); those are the same reply, so only a person's message starts a new slice.
    const state = createSliceState(policy())
    const guard = guardHarness(policy(), state)
    guard.start()
    guard.call('tool_call', toolCall('read', { path: 'a' }))
    guard.call('agent_start')
    guard.call('before_agent_start', { messageType: 'custom' })
    guard.call('tool_call', toolCall('read', { path: 'b' }))
    expect(state.steps).toBe(2)
    guard.call('before_agent_start', { messageType: 'user' })
    expect(state.steps).toBe(0)
  })

  it('does not end a reply that only re-sent a cached prefix (the "Confirm plan model support" thread)', () => {
    // The real usage of that thread: five requests, 52 238 new tokens, 63 k cached prefix.
    // Counting the prefix made the old guard stop after four requests with nothing done.
    const limits = policy({ maxNewTokens: 60_000, maxToolCalls: 100 })
    const guard = guardHarness(limits)
    guard.start()
    const requests: [number, number, number][] = [[12_757, 0, 88], [12_863, 0, 61], [293, 12_672, 171], [24_853, 12_800, 249], [630, 37_504, 273]]
    for (const [input, cacheRead, output] of requests) {
      guard.call('message_end', { message: { role: 'assistant', usage: { input, cacheRead, output } } })
      expect(guard.call('tool_call', toolCall('read', { path: `file-${input}-${cacheRead}` }))).toBeUndefined()
    }
    expect(guard.state.tokens).toBe(52_238)
    expect(guard.state.endedBy).toBeNull()
  })

  it('counts new tokens only, never the cached prefix', () => {
    const guard = guardHarness(policy())
    guard.start()
    guard.call('message_end', { message: { role: 'assistant', usage: { input: 1_000, cacheRead: 100_000, cacheWrite: 20, output: 10 } } })
    expect(guard.state.tokens).toBe(1_030)
  })
})

describe('work slice guard', () => {
  it('refuses the call past the budget, asks for a short report, then ends the reply', () => {
    const guard = guardHarness(policy({ maxToolCalls: 2 }))
    guard.start()
    expect(guard.call('tool_call', toolCall('read', { path: 'a' }))).toBeUndefined()
    const refusal = guard.call('tool_call', toolCall('read', { path: 'b' })) as { block: boolean; reason: string }
    expect(refusal.block).toBe(true)
    expect(refusal.reason).toContain('Stop using tools')
    // The harness writes the checkpoint itself (ADR-0069); the model is never asked for one.
    expect(refusal.reason).not.toContain('checkpoint_write')
    expect(guard.state.endedBy).toBe('budget')
    expect(guard.call('tool_call', toolCall('read', { path: 'c' }))).toMatchObject({ block: true, terminate: true })
  })

  it('lets a session name through, even as the very first call past the budget', () => {
    const guard = guardHarness(policy({ maxToolCalls: 1 }))
    guard.start()
    guard.call('tool_call', toolCall('read', { path: 'a' }))
    expect(guard.call('tool_call', toolCall('session_name', { name: 'Fix the guard' }))).toBeUndefined()
    expect(guard.state.endedBy).toBe('budget')
    expect(guard.call('tool_call', toolCall('read', { path: 'b' }))).toMatchObject({ terminate: true })
  })

  it('allows a long sequence of distinct reads', () => {
    const guard = guardHarness(policy())
    guard.start()
    for (let step = 0; step < 40; step += 1) {
      expect(guard.call('tool_call', toolCall('read', { path: `src/file-${step}.ts` }))).toBeUndefined()
    }
    expect(guard.state.endedBy).toBeNull()
  })

  it('does not flag three different todo updates in one reply', () => {
    // The person follows progress from the todo, so a reply rewrites it as steps complete.
    const guard = guardHarness(policy())
    guard.start()
    const todo = (status: string) => ({ items: [{ text: 'Read the plan', status }, { text: 'Land the fix', status: 'pending' }] })
    expect(guard.call('tool_call', toolCall('todo_write', todo('pending')))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('todo_write', todo('in_progress')))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('todo_write', todo('completed')))).toBeUndefined()
    expect(guard.state.endedBy).toBeNull()
  })

  it('counts todo updates toward the tool budget without treating them as handoffs', () => {
    const limits = policy({ maxToolCalls: 2 })
    const guard = guardHarness(limits)
    guard.start()
    expect(guard.call('tool_call', toolCall('todo_write'))).toBeUndefined()
    const refusal = guard.call('tool_call', toolCall('todo_write')) as { block: boolean; terminate?: boolean; reason: string }
    expect(refusal).toMatchObject({ block: true })
    expect(refusal.terminate).toBeUndefined()
    expect(refusal.reason).toContain('2 tool calls')
    expect(guard.state.endedBy).toBe('budget')
  })

  it('ends the reply when context compaction is thrashing', () => {
    const guard = guardHarness(policy())
    guard.start()
    guard.state.compactions = 3
    const ended = guard.call('tool_call', toolCall('read', { path: 'a' })) as { terminate: boolean; reason: string }
    expect(ended.terminate).toBe(true)
    expect(ended.reason).toContain('compaction')
    expect(guard.state.endedBy).toBe('compaction-thrash')
  })

  it('never refuses a call for repeating, however often it is made', () => {
    const guard = guardHarness(policy())
    guard.start()
    const read = { path: 'src/a.ts', offset: 0, limit: 20 }
    const check = { command: 'npm test' }
    const edit = (step: number) => ({ path: 'src/a.ts', oldText: `old ${step}`, newText: `new ${step}` })
    for (let step = 0; step < 6; step += 1) {
      expect(guard.call('tool_call', toolCall('read', read))).toBeUndefined()
      expect(guard.call('tool_call', toolCall('bash', check))).toBeUndefined()
      // A check that keeps failing is no reason to refuse the next attempt.
      guard.call('tool_result', { toolName: 'bash', isError: true, input: check })
      // Neither is editing the same path again and again.
      expect(guard.call('tool_call', toolCall('edit', edit(step)))).toBeUndefined()
      guard.call('tool_result', { toolName: 'edit', isError: false, input: edit(step) })
    }
    expect(guard.state.steps).toBe(18)
    expect(guard.state.endedBy).toBeNull()
  })
})

describe('XINGULAR_WORK_SLICE at launch', () => {
  it('accepts key=value pairs with the same bounds as a run policy', () => {
    vi.stubEnv('XINGULAR_WORK_SLICE', 'maxToolCalls=15, maxSlices=3,continue=true')
    expect(parseWorkSlice(undefined)).toEqual({ ...DEFAULT_SLICE_POLICY, maxToolCalls: 15, maxSlices: 3 })
    vi.stubEnv('XINGULAR_WORK_SLICE', 'maxToolCalls=0.5')
    expect(() => parseWorkSlice(undefined)).toThrow(WorkSliceError)
    vi.stubEnv('XINGULAR_WORK_SLICE', 'sometimes')
    expect(() => parseWorkSlice(undefined)).toThrow(WorkSliceError)
  })
})

/** The guard and the continuation together, as the terminal registers them, without a Pi session. */
function sliceHarness(limits: SlicePolicy, options: Partial<SliceContinuationOptions> = {}) {
  const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>()
  const api = { on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => { handlers.set(name, [...handlers.get(name) ?? [], handler]) } } as never
  const state = createSliceState(limits)
  const continued: Array<{ slice: number; steps: number; limit: string | null }> = []
  workSliceGuard({ policy: limits, state })(api)
  sliceContinuation({ policy: limits, state, onContinue: (ended) => continued.push(ended), ...options })(api)
  const call = (name: string, event: unknown = {}, ctx?: unknown): unknown => {
    let result: unknown
    for (const handler of handlers.get(name) ?? []) result = handler(event, ctx) ?? result
    return result
  }
  /** Runs `count` successful tool calls of `tool`. */
  const work = (count: number, tool = 'bash') => {
    const refusals: unknown[] = []
    for (let index = 0; index < count; index += 1) {
      const refusal = call('tool_call', { toolCallId: `c${index}`, toolName: tool, input: {} })
      if (refusal) refusals.push(refusal)
      else call('tool_result', { toolName: tool, isError: false })
    }
    return refusals
  }
  const settle = (extra: Record<string, unknown> = {}, ctx?: unknown) => call('agent_before_settle', { outcome: 'completed', entries: [], ...extra }, ctx) as { entries: Array<{ customType?: string; content?: string }>; continue: boolean } | undefined
  return { call, state, continued, work, settle, start: () => call('before_agent_start', { messageType: 'user' }) }
}

describe('work slice continuation', () => {
  const limits = policy({ maxToolCalls: 3, maxMinutes: 0, maxSlices: 3 })

  it('continues a reply that did work and reached its budget, up to the slice cap', () => {
    const run = sliceHarness(limits, { next: () => 'Migrate the admin pages' })
    run.start()
    expect(run.work(3)).toHaveLength(1)
    const first = run.settle()
    expect(first?.continue).toBe(true)
    expect(first?.entries.at(-1)?.customType).toBe(SLICE_CONTINUE_CUSTOM_TYPE)
    expect(first?.entries.at(-1)?.content).toContain('Slice 2 of up to 3')
    expect(first?.entries.at(-1)?.content).toContain('Migrate the admin pages')
    expect(run.continued).toEqual([{ slice: 1, steps: 3, limit: '3 tool calls' }])
    expect(run.state).toMatchObject({ slice: 2, steps: 0, endedBy: null, progressed: false })

    // The continuation is not a person's message, so the next slice keeps counting from slice 2.
    run.call('before_agent_start', { messageType: 'custom' })
    run.work(3)
    expect(run.settle()?.continue).toBe(true)
    expect(run.state.slice).toBe(3)
    run.work(3)
    expect(run.settle()).toBeUndefined()
    expect(run.state.endedBy).toBe('budget')

    // A person's message starts again at slice 1.
    run.start()
    expect(run.state.slice).toBe(1)
  })

  it('hands back a fruitless slice', () => {
    const run = sliceHarness(limits)
    run.start()
    run.work(3, 'read')
    expect(run.settle()).toBeUndefined()
    expect(run.continued).toEqual([])
  })

  it('does not continue a reply that ended for another reason or must stop', () => {
    const cases: Array<[string, Partial<SliceContinuationOptions>, Record<string, unknown>, unknown]> = [
      ['not at the budget', {}, {}, undefined],
      ['blocked by finish', { blocked: () => true }, {}, undefined],
      ['failed', { failed: () => true }, {}, undefined],
      ['in plan mode', { active: () => false }, {}, undefined],
      ['all todo items done', { todo: () => [{ status: 'completed' }] }, {}, undefined],
      ['already continuing', {}, { continue: true }, undefined],
      ['aborted', {}, {}, { signal: AbortSignal.abort() }]
    ]
    for (const [label, options, extra, ctx] of cases) {
      const run = sliceHarness(limits, options)
      run.start()
      run.work(label === 'not at the budget' ? 2 : 3)
      expect(run.settle(extra, ctx), label).toBeUndefined()
    }
  })

  it('keeps counting compactions across slices', () => {
    const run = sliceHarness(limits)
    run.start()
    run.state.compactions = 2
    run.work(3)
    expect(run.settle()?.continue).toBe(true)
    expect(run.state.compactions).toBe(2)
  })

  it('does nothing when continuation is off', () => {
    const run = sliceHarness({ ...limits, continue: false })
    run.start()
    run.work(3)
    expect(run.settle()).toBeUndefined()
  })
})
