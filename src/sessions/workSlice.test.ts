import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSliceState,
  DEFAULT_SLICE_POLICY,
  looksLikeCheck,
  parseWorkSlice,
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
  const call = (name: string, event: unknown = {}): unknown => handlers.get(name)!(event)
  return { call, state, start: () => call('agent_start') }
}

const toolCall = (toolName: string, input: Record<string, unknown> = {}): unknown => ({ toolName, input })

afterEach(() => vi.unstubAllEnvs())

describe('work slice policy', () => {
  it('uses the foundation defaults and accepts bounded overrides', () => {
    expect(parseWorkSlice(undefined)).toEqual(DEFAULT_SLICE_POLICY)
    expect(DEFAULT_SLICE_POLICY).toMatchObject({ enabled: true, maxToolCalls: 160, maxMinutes: 40, maxNewTokens: 320_000, maxSlices: 8, continue: true })
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
    // The default cap is a generous safety net, well beyond a few large reads.
    expect(sliceLimitReached(policy(), state)).toBeNull()
    state.tokens = 320_000
    expect(sliceLimitReached(policy(), state)).toBe('320k new tokens')
    state.tokens = 0
    state.startedAt = Date.now() - 21 * 60_000
    expect(sliceLimitReached(policy({ maxMinutes: 20 }), state)).toBe('20 minutes')
    // The defaults allow four times as long before a checkpoint.
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
  it('refuses the call past the budget, asks for a checkpoint, then ends the reply', () => {
    const guard = guardHarness(policy({ maxToolCalls: 2 }))
    guard.start()
    expect(guard.call('tool_call', toolCall('read', { path: 'a' }))).toBeUndefined()
    const refusal = guard.call('tool_call', toolCall('read', { path: 'b' })) as { block: boolean; reason: string }
    expect(refusal.block).toBe(true)
    expect(refusal.reason).toContain('checkpoint_write')
    expect(guard.state.endedBy).toBe('budget')
    expect(guard.call('tool_call', toolCall('read', { path: 'c' }))).toMatchObject({ block: true, terminate: true })
  })

  it('lets the checkpoint through, even as the very first call past the budget', () => {
    const guard = guardHarness(policy({ maxToolCalls: 1 }))
    guard.start()
    guard.call('tool_call', toolCall('read', { path: 'a' }))
    expect(guard.call('tool_call', toolCall('checkpoint_write'))).toBeUndefined()
    expect(guard.state.endedBy).toBe('budget')
    expect(guard.call('tool_call', toolCall('read', { path: 'b' }))).toMatchObject({ terminate: true })
  })

  it('names a repeated call once, then ends the reply', () => {
    const guard = guardHarness(policy())
    guard.start()
    expect(guard.call('tool_call', toolCall('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('bash', { command: 'npm test' }))).toBeUndefined()
    const note = guard.call('tool_call', toolCall('bash', { command: 'npm test' })) as { block: boolean; reason: string }
    expect(note.block).toBe(true)
    expect(note.reason).toContain('repeating work')
    expect(guard.state.endedBy).toBeNull()
    expect(guard.call('tool_call', toolCall('bash', { command: 'npm test' }))).toMatchObject({ terminate: true })
    expect(guard.state.endedBy).toBe('stuck')
  })

  it('does not flag three different checklist updates in one reply', () => {
    // The person follows progress from the checklist, so a reply rewrites it as steps complete.
    const guard = guardHarness(policy())
    guard.start()
    const checklist = (status: string) => ({ items: [{ text: 'Read the plan', status }, { text: 'Land the fix', status: 'pending' }] })
    expect(guard.call('tool_call', toolCall('checklist_write', checklist('pending')))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('checklist_write', checklist('in_progress')))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('checklist_write', checklist('completed')))).toBeUndefined()
    expect(guard.state.endedBy).toBeNull()
  })

  it('flags three identical checklist updates once, then ends the reply', () => {
    const guard = guardHarness(policy())
    guard.start()
    const same = { items: [{ text: 'One step', status: 'in_progress' }] }
    expect(guard.call('tool_call', toolCall('checklist_write', same))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('checklist_write', same))).toBeUndefined()
    const note = guard.call('tool_call', toolCall('checklist_write', same)) as { block: boolean; reason: string }
    expect(note.reason).toContain('repeating work')
    expect(guard.state.endedBy).toBeNull()
    expect(guard.call('tool_call', toolCall('checklist_write', same))).toMatchObject({ terminate: true })
    expect(guard.state.endedBy).toBe('stuck')
  })

  it('starts the repetition counts fresh in each reply', () => {
    const guard = guardHarness(policy())
    const read = { path: 'src/a.ts' }
    guard.start()
    guard.call('tool_call', toolCall('read', read))
    guard.call('tool_call', toolCall('read', read))
    guard.start()
    expect(guard.call('tool_call', toolCall('read', read))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('read', read))).toBeUndefined()
    const note = guard.call('tool_call', toolCall('read', read)) as { block: boolean; reason: string }
    // Counted inside this reply, not carried over from the one before.
    expect(note.reason).toContain('steps ending at 3')
    expect(guard.state.endedBy).toBeNull()
  })

  it('starts the nudge fresh in each reply', () => {
    const guard = guardHarness(policy())
    const command = { command: 'npm test' }
    guard.start()
    for (let attempt = 0; attempt < 3; attempt += 1) guard.call('tool_call', toolCall('bash', command))
    expect(guard.state.endedBy).toBeNull()
    guard.start()
    guard.call('tool_call', toolCall('bash', command))
    guard.call('tool_call', toolCall('bash', command))
    const note = guard.call('tool_call', toolCall('bash', command)) as { block: boolean; terminate?: boolean }
    expect(note.block).toBe(true)
    expect(note.terminate).toBeUndefined()
    expect(guard.state.endedBy).toBeNull()
    expect(guard.call('tool_call', toolCall('bash', command))).toMatchObject({ terminate: true })
    expect(guard.state.endedBy).toBe('stuck')
  })

  it('counts edits and failing checks per reply', () => {
    const guard = guardHarness(policy())
    const edit = (step: number) => ({ path: 'src/a.ts', oldText: `old ${step}`, newText: `new ${step}` })
    guard.start()
    for (let step = 0; step < 4; step += 1) guard.call('tool_call', toolCall('edit', edit(step)))
    guard.start()
    for (let step = 0; step < 4; step += 1) {
      const result = guard.call('tool_call', toolCall('edit', edit(step))) as { terminate?: boolean } | undefined
      expect(result?.terminate).toBeUndefined()
    }
    expect(guard.state.endedBy).toBeNull()

    const check = { command: 'npx vitest run src/a.test.ts' }
    guard.start()
    guard.call('tool_result', { toolName: 'bash', isError: true, input: check })
    guard.call('tool_result', { toolName: 'bash', isError: true, input: check })
    expect((guard.call('tool_call', toolCall('bash', check)) as { reason: string }).reason).toContain('failed 2 times')
    guard.start()
    guard.call('tool_result', { toolName: 'bash', isError: true, input: check })
    expect(guard.call('tool_call', toolCall('bash', check))).toBeUndefined()
  })

  it('treats the same arguments in a different order as the same call', () => {
    const guard = guardHarness(policy())
    guard.start()
    expect(guard.call('tool_call', toolCall('read', { path: 'src/a.ts', offset: 0 }))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('read', { offset: 0, path: 'src/a.ts' }))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('read', { path: 'src/a.ts', offset: 0 }))).toMatchObject({ block: true })
  })

  it('still names a tool called three times with no arguments', () => {
    const guard = guardHarness(policy())
    guard.start()
    expect(guard.call('tool_call', toolCall('get_capabilities'))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('get_capabilities'))).toBeUndefined()
    expect(guard.call('tool_call', toolCall('get_capabilities'))).toMatchObject({ block: true })
  })

  it('does not count waiting for a subagent as a loop', () => {
    const guard = guardHarness(policy())
    guard.start()
    for (let attempt = 0; attempt < 5; attempt += 1) expect(guard.call('tool_call', toolCall('wait_subagents'))).toBeUndefined()
    expect(guard.state.endedBy).toBeNull()
  })

  it('names a check that keeps failing', () => {
    const guard = guardHarness(policy())
    guard.start()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      guard.call('tool_result', { toolName: 'bash', isError: true, input: { command: 'npx vitest run src/a.test.ts' } })
    }
    const note = guard.call('tool_call', toolCall('bash', { command: 'npx vitest run src/a.test.ts' })) as { block: boolean; reason: string }
    expect(note.reason).toContain('failed 2 times')
  })

  it('resets the repetition count when a check passes', () => {
    const guard = guardHarness(policy())
    guard.start()
    guard.call('tool_call', toolCall('bash', { command: 'npm test' }))
    guard.call('tool_call', toolCall('bash', { command: 'npm test' }))
    guard.call('tool_result', { toolName: 'bash', isError: false, input: { command: 'npm test' } })
    expect(guard.call('tool_call', toolCall('bash', { command: 'npm test' }))).toBeUndefined()
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

  it('recognises the commands that count as a check', () => {
    expect(looksLikeCheck('npm test')).toBe(true)
    expect(looksLikeCheck('npx vitest run src/a.test.ts')).toBe(true)
    expect(looksLikeCheck('cd ../App && cargo test')).toBe(true)
    expect(looksLikeCheck('git status --short')).toBe(false)
    expect(looksLikeCheck('rg -n foo src')).toBe(false)
  })
})
