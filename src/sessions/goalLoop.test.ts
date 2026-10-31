import { describe, expect, it } from 'vitest'

import type { CheckModel } from './completionCheck'
import { GoalController } from './goal'
import { goalLoop, goalNotice, type GoalEvent, type GoalLoopOptions } from './goalLoop'

type Settle = { continue?: boolean; entries?: { type: string; customType?: string; content?: string; display?: boolean }[] } | undefined

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

/** The loop as Pi calls it, without a Pi session. */
function loopHarness(options: Partial<GoalLoopOptions> = {}, controller = new GoalController()) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>()
  const events: GoalEvent[] = []
  goalLoop({ ...options, controller, onEvent: (event) => void events.push(event) })({
    on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => { handlers.set(name, handler) }
  } as never)
  const call = (name: string, event: unknown, ctx: unknown = {}): unknown => handlers.get(name)?.(event, ctx)
  return {
    controller,
    events,
    /** A round begins and does some work. */
    round: (work: { tool?: string; failed?: boolean; text?: string } = { tool: 'bash' }) => {
      call('agent_start', {})
      if (work.tool) call('tool_call', { toolName: work.tool })
      if (work.tool) call('tool_result', { toolName: work.tool, isError: work.failed === true })
      if (work.text) call('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: work.text }] } })
    },
    settle: async (event: Partial<{ outcome: string; continue: boolean; entries: unknown[]; context: unknown }> = {}, ctx: unknown = {}) =>
      await call('agent_before_settle', { outcome: 'completed', continue: false, entries: [], context: { llmMessages: [], pendingMessages: [] }, ...event }, ctx) as Settle
  }
}

describe('goal loop (ADR-0072)', () => {
  it('does nothing without an active goal', async () => {
    const idle = loopHarness()
    idle.round()
    expect(await idle.settle()).toBeUndefined()
    const paused = loopHarness()
    paused.controller.set('Do it')
    paused.controller.pause()
    paused.round()
    expect(await paused.settle()).toBeUndefined()
  })

  it('continues a reply that would end with Codex\'s prompt, counting the round', async () => {
    const loop = loopHarness()
    loop.controller.set('Port the API')
    loop.round()
    const result = await loop.settle({ entries: [{ type: 'custom', customType: 'earlier' }] })
    expect(result?.continue).toBe(true)
    expect(result?.entries?.map((entry) => entry.customType)).toEqual(['earlier', 'xingular-goal'])
    expect(result!.entries![1]).toMatchObject({ type: 'custom_message', display: false })
    expect(result!.entries![1].content).toContain('<objective>\nPort the API\n</objective>')
    expect(result!.entries![1].content).toContain('Rounds used: 1 of 30')
    expect(loop.controller.get()?.rounds).toBe(1)
    expect(loop.events.map((event) => event.kind)).toEqual(['round'])
    expect(goalNotice(loop.events[0])).toBe('Goal round 1 of 30 starts.')
  })

  it('stays out of an aborted, failed or already continuing reply, a slice the guard ended, a plan, and a queued message', async () => {
    for (const [options, event, ctx] of [
      [{}, { outcome: 'aborted' }, {}],
      [{}, { outcome: 'error' }, {}],
      [{}, {}, { signal: { aborted: true } }],
      [{}, { continue: true }, {}],
      [{ sliceEnded: () => true }, {}, {}],
      [{ active: () => false }, {}, {}],
      [{}, { context: { llmMessages: [], pendingMessages: [{ role: 'user' }] } }, {}]
    ] as [Partial<GoalLoopOptions>, Record<string, unknown>, unknown][]) {
      const loop = loopHarness(options)
      loop.controller.set('Do it')
      loop.round()
      expect(await loop.settle(event, ctx)).toBeUndefined()
      expect(loop.controller.get()).toMatchObject({ status: 'active', rounds: 0 })
    }
  })

  it('blocks a goal whose reply failed, or hit a usage limit, instead of continuing', async () => {
    const failed = loopHarness({ failed: () => true })
    failed.controller.set('Do it')
    failed.round()
    expect(await failed.settle()).toBeUndefined()
    expect(failed.controller.get()?.status).toBe('blocked')
    const limited = loopHarness({ usageLimited: () => true })
    limited.controller.set('Do it')
    limited.round()
    expect(await limited.settle()).toBeUndefined()
    expect(limited.controller.get()?.status).toBe('usage_limited')
  })

  it('does not stop a goal for a round with no tool call when it wrote text (Codex removed that rule)', async () => {
    const loop = loopHarness()
    loop.controller.set('Do it')
    for (let round = 0; round < 6; round += 1) {
      loop.round({ text: 'Thinking about the next step.' })
      expect((await loop.settle())?.continue).toBe(true)
    }
    expect(loop.controller.get()?.status).toBe('active')
  })

  it('blocks after three rounds with nothing happening, and after three with only failed commands', async () => {
    const quiet = loopHarness()
    quiet.controller.set('Do it')
    for (let round = 1; round <= 2; round += 1) {
      quiet.round({})
      expect((await quiet.settle())?.continue).toBe(true)
    }
    quiet.round({})
    expect(await quiet.settle()).toBeUndefined()
    expect(quiet.controller.get()).toMatchObject({ status: 'blocked' })
    expect(quiet.events.at(-1)).toMatchObject({ kind: 'stopped', status: 'blocked' })

    const failing = loopHarness()
    failing.controller.set('Do it')
    for (let round = 1; round <= 2; round += 1) {
      failing.round({ tool: 'bash', failed: true })
      expect((await failing.settle())?.continue).toBe(true)
    }
    failing.round({ tool: 'bash', failed: true })
    expect(await failing.settle()).toBeUndefined()
    expect(failing.controller.get()?.status).toBe('blocked')
  })

  it('wraps a goal up once at its round cap, then lets the reply end', async () => {
    const loop = loopHarness()
    loop.controller.set('Do it', { rounds: 2 })
    loop.round()
    expect((await loop.settle())?.continue).toBe(true)
    loop.round()
    expect((await loop.settle())?.continue).toBe(true)
    loop.round()
    const wrap = await loop.settle()
    expect(wrap?.continue).toBe(true)
    expect(wrap!.entries![0].content).toContain('reached its round or time limit')
    expect(loop.controller.get()?.status).toBe('budget_limited')
    loop.round()
    expect(await loop.settle()).toBeUndefined()
  })

  describe('a completion claim', () => {
    const claimed = (loop: ReturnType<typeof loopHarness>) => {
      loop.controller.set('Port the API and show the tests passing')
      loop.round()
      loop.controller.update('complete')
    }
    const transcript = { llmMessages: [{ role: 'user', content: 'Continue working toward the active thread goal.' }, { role: 'assistant', content: [{ type: 'text', text: 'Ported; all 40 tests pass.' }] }], pendingMessages: [] }

    it('completes the goal when the check finds the objective met, and counts the check\'s request', async () => {
      const model = checkModel('{"verdict":"done","reason":"40 tests pass in the transcript.","next":""}')
      const recorded: unknown[] = []
      const loop = loopHarness({ check: () => model.ask, recordUsage: (message) => void recorded.push(message) })
      claimed(loop)
      expect(await loop.settle({ context: transcript })).toBeUndefined()
      expect(loop.controller.get()).toMatchObject({ status: 'complete', lastReason: '40 tests pass in the transcript.' })
      expect(model.asked[0].user).toContain('Port the API and show the tests passing')
      expect(model.asked[0].user).toContain('Ported; all 40 tests pass.')
      expect(model.asked[0].user).not.toContain('Continue working toward the active thread goal.')
      expect(recorded).toEqual([{ usage: { input: 10, output: 5 } }])
      expect(loop.events.map((event) => event.kind)).toEqual(['claim', 'stopped'])
    })

    it('sends the claim back with the check\'s reason and next step when the objective is unmet', async () => {
      const model = checkModel('{"verdict":"continue","reason":"No test output.","next":"Run the tests."}')
      const loop = loopHarness({ check: () => model.ask })
      claimed(loop)
      const result = await loop.settle({ context: transcript })
      expect(result?.continue).toBe(true)
      expect(result!.entries![0].content).toContain('The completion claim was checked and the objective is not met yet.')
      expect(result!.entries![0].content).toContain('Why: No test output.')
      expect(result!.entries![0].content).toContain('Next: Run the tests.')
      expect(result!.entries![0].content).toContain('Continue working toward the active thread goal.')
      expect(loop.controller.get()).toMatchObject({ status: 'active', claimed: false, rounds: 1, lastReason: 'No test output.' })
    })

    it('accepts the claim when there is no check model, an error or an unreadable answer', async () => {
      for (const options of [{}, { check: () => checkModel(new Error('quota')).ask }, { check: () => checkModel('no verdict here').ask }] as Partial<GoalLoopOptions>[]) {
        const loop = loopHarness(options)
        claimed(loop)
        expect(await loop.settle({ context: transcript })).toBeUndefined()
        expect(loop.controller.get()?.status).toBe('complete')
        expect(goalNotice(loop.events[0])).toContain('the claim stands')
      }
    })

    it('leaves a claim unjudged when the person interrupts', async () => {
      const loop = loopHarness({ check: () => checkModel().ask })
      claimed(loop)
      expect(await loop.settle({ context: transcript }, { signal: { aborted: true } })).toBeUndefined()
      expect(loop.controller.get()).toMatchObject({ status: 'active', claimed: true })
    })

    it('counts a rejected claim\'s round against the cap', async () => {
      const model = checkModel('{"verdict":"continue","reason":"x","next":"y"}')
      const loop = loopHarness({ check: () => model.ask })
      loop.controller.set('Do it', { rounds: 1 })
      loop.controller.nextRound()
      loop.round()
      loop.controller.update('complete')
      const result = await loop.settle({ context: transcript })
      expect(result!.entries![0].content).toContain('reached its round or time limit')
      expect(loop.controller.get()?.status).toBe('budget_limited')
    })
  })

  it('describes each event for the run record', () => {
    const goal = new GoalController().set('Do it')
    expect(goalNotice({ kind: 'claim', goal, verdict: { verdict: 'continue', reason: 'More to do.', next: '' } })).toBe('Goal claim check: not met yet — More to do.')
    expect(goalNotice({ kind: 'stopped', goal: { ...goal, status: 'budget_limited', lastReason: 'cap' }, status: 'budget_limited' })).toBe('Goal budget limited: cap')
  })
})
