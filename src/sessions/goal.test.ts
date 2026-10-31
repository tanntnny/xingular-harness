import { describe, expect, it } from 'vitest'

import {
  GoalController,
  GoalError,
  budgetLimitPrompt,
  continuationPrompt,
  formatElapsed,
  goalFooter,
  goalSummary,
  goalTools,
  objectiveUpdatedPrompt,
  parseGoalCommand,
  provenanceText,
  GOAL_STRIKES
} from './goal'

const clock = () => {
  let at = 1_000_000
  return { now: () => at, advance: (seconds: number) => { at += seconds * 1000 } }
}

describe('goal state (ADR-0072)', () => {
  it('starts active with default caps and counts a round\'s wall time only while it runs', () => {
    const time = clock()
    const goal = new GoalController({ now: time.now })
    const set = goal.set('  Port the API  ')
    expect(set).toMatchObject({ objective: 'Port the API', status: 'active', rounds: 0, limits: { rounds: 30, hours: 8 }, claimed: false })
    goal.beginRound()
    time.advance(125)
    goal.endRound()
    time.advance(3_600) // idle gap: not billed
    expect(goal.get()?.timeUsedSeconds).toBe(125)
  })

  it('refuses an empty or over-long objective with Codex\'s messages', () => {
    const goal = new GoalController()
    expect(() => goal.set('   ')).toThrow('goal objective must not be empty')
    expect(() => goal.set('x'.repeat(4_001))).toThrow('goal objective must be at most 4000 characters')
    expect(() => goal.update('complete')).toThrow('cannot update goal because this thread has no goal')
  })

  it('lets the model claim complete, report blocked or pause, and nothing else', () => {
    const goal = new GoalController()
    goal.set('Do it')
    for (const status of ['active', 'budget_limited', 'usage_limited']) {
      expect(() => goal.update(status)).toThrow(/controlled by the user or system/)
    }
    expect(() => goal.update('done')).toThrow(GoalError)
    const claim = goal.update('complete')
    expect(JSON.parse(claim.text)).toMatchObject({ claim: 'recorded', goal: { status: 'active' } })
    expect(goal.get()).toMatchObject({ status: 'active', claimed: true })
    goal.update('blocked')
    expect(goal.get()).toMatchObject({ status: 'blocked', claimed: false })
  })

  it('accepts or rejects a checked claim', () => {
    const goal = new GoalController()
    goal.set('Do it')
    goal.update('complete')
    expect(goal.reject('No test output.')).toMatchObject({ status: 'active', claimed: false, lastReason: 'No test output.' })
    goal.update('complete')
    expect(goal.accept('Tests pass.')).toMatchObject({ status: 'complete', claimed: false })
  })

  it('keeps a budget limit above a pause, and resumes only on the person\'s word', () => {
    const goal = new GoalController()
    goal.set('Do it', { rounds: 1 })
    goal.limit('budget_limited', 'cap')
    expect(goal.update('paused').goal.status).toBe('budget_limited')
    expect(goal.pause()?.status).toBe('budget_limited')
    expect(goal.resume().status).toBe('active')
    expect(goal.pause()?.status).toBe('paused')
  })

  it('blocks after three automatic rounds without activity, or three with only failed commands', () => {
    const idle = new GoalController()
    idle.set('Do it')
    expect(idle.settleRound({ activity: false, failedCommands: false })).toBeNull()
    expect(idle.settleRound({ activity: false, failedCommands: false })).toBeNull()
    expect(idle.settleRound({ activity: false, failedCommands: false })).toBe('blocked')
    expect(GOAL_STRIKES).toBe(3)

    const recovering = new GoalController()
    recovering.set('Do it')
    recovering.settleRound({ activity: false, failedCommands: false })
    recovering.settleRound({ activity: true, failedCommands: false }) // activity resets the count
    recovering.settleRound({ activity: false, failedCommands: false })
    expect(recovering.settleRound({ activity: false, failedCommands: false })).toBeNull()

    const failing = new GoalController()
    failing.set('Do it')
    for (let round = 1; round < 3; round += 1) expect(failing.settleRound({ activity: true, failedCommands: true })).toBeNull()
    expect(failing.settleRound({ activity: true, failedCommands: true })).toBe('blocked')

    const error = new GoalController()
    error.set('Do it')
    expect(error.settleRound({ activity: true, failedCommands: false, error: true })).toBe('blocked')
    const usage = new GoalController()
    usage.set('Do it')
    expect(usage.settleRound({ activity: true, failedCommands: false, usageLimit: true })).toBe('usage_limited')
  })

  it('reports being over its round or hour cap', () => {
    const time = clock()
    const goal = new GoalController({ now: time.now })
    goal.set('Do it', { rounds: 2, hours: 1 })
    expect(goal.overLimit()).toBe(false)
    goal.nextRound()
    goal.nextRound()
    expect(goal.overLimit()).toBe(true)
    goal.set('Again', { rounds: 5, hours: 1 })
    goal.beginRound()
    time.advance(3_601)
    goal.endRound()
    expect(goal.overLimit()).toBe(true)
  })

  it('tells every listener and the persister about each change', () => {
    const seen: (string | null)[] = []
    const heard: (string | null)[] = []
    const goal = new GoalController({ onChange: (state) => void seen.push(state?.status ?? null) })
    const stop = goal.subscribe((state) => void heard.push(state?.status ?? null))
    goal.set('Do it')
    goal.pause()
    stop()
    goal.clear()
    expect(seen).toEqual(['active', 'paused', null])
    expect(heard).toEqual(['active', 'paused'])
  })
})

describe('goal prompts and tools', () => {
  const state = () => {
    const goal = new GoalController()
    return goal.set('Ship <b>v2</b> & test')
  }

  it('renders Codex\'s continuation audit with the objective escaped as data, and rounds in place of tokens', () => {
    const text = continuationPrompt(state())
    expect(text).toContain('Continue working toward the active thread goal.')
    expect(text).toContain('<objective>\nShip &lt;b&gt;v2&lt;/b&gt; &amp; test\n</objective>')
    expect(text).toContain('Rounds used: 0 of 30')
    expect(text).toContain('Time used: 0s of 8h 0m')
    expect(text).toContain('treat completion as unproven')
    expect(text).toContain('Do not call update_goal with status "blocked" the first time a blocker appears.')
    expect(text).toContain('at least three consecutive goal turns')
    expect(text).not.toContain('update_plan')
    expect(text).not.toContain('{{')
    expect(text).not.toContain('token')
  })

  it('renders the cap and edit prompts', () => {
    expect(budgetLimitPrompt(state())).toContain('reached its round or time limit')
    expect(budgetLimitPrompt(state())).toContain('leave the user with a clear next step')
    expect(objectiveUpdatedPrompt(state())).toContain('<untrusted_objective>')
    expect(objectiveUpdatedPrompt(state())).not.toContain('{{')
  })

  it('has two tools, with Codex\'s guardrail text, and reports errors to the model', async () => {
    const goal = new GoalController()
    const [get, update] = goalTools(() => goal)
    expect([get.name, update.name]).toEqual(['get_goal', 'update_goal'])
    expect(update.description).toContain('`paused` only at the user\'s explicit request')
    expect(update.description).toContain('Do not use `blocked` merely because the work is hard')
    expect(JSON.parse(await get.execute({}) as string)).toEqual({ goal: null })
    expect(await update.execute({ status: 'complete' })).toBe('cannot update goal because this thread has no goal')
    goal.set('Do it')
    expect(await update.execute({ status: 'active' })).toContain('controlled by the user or system')
    expect(JSON.parse(await update.execute({ status: 'complete' }) as string)).toMatchObject({ claim: 'recorded' })
    expect(JSON.parse(await get.execute({}) as string).goal).toMatchObject({ objective: 'Do it', status: 'active', rounds: 0 })
  })
})

describe('the person\'s /goal', () => {
  it('parses subcommands only as the whole text, and caps from flags', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'show' })
    expect(parseGoalCommand(' Pause ')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand('resume')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalCommand('edit')).toEqual({ kind: 'edit', objective: null })
    expect(parseGoalCommand('pause now and think')).toEqual({ kind: 'set', objective: 'pause now and think', limits: {} })
    expect(parseGoalCommand('--rounds 10 --hours=2.5 port the API')).toEqual({ kind: 'set', objective: 'port the API', limits: { rounds: 10, hours: 2.5 } })
    expect(parseGoalCommand('--rounds 0 x')).toMatchObject({ kind: 'error' })
    expect(parseGoalCommand('--rounds 5')).toMatchObject({ kind: 'error' })
    expect(parseGoalCommand('x'.repeat(4_001))).toMatchObject({ kind: 'error' })
  })

  it('formats elapsed time and the status text like Codex', () => {
    expect(['59s', '1m', '1h 30m', '2d 23h 42m']).toEqual([59, 60, 5_400, 3 * 86_400 - 1_080].map(formatElapsed))
    expect(goalSummary(null)).toContain('No goal is currently set.')
    const goal = new GoalController()
    goal.set('Do it')
    const summary = goalSummary(goal.get())
    expect(summary).toContain('Status: active')
    expect(summary).toContain('Objective: Do it')
    expect(summary).toContain('Commands: /goal edit, /goal pause, /goal clear')
    goal.pause()
    expect(goalSummary(goal.get())).toContain('Commands: /goal edit, /goal resume, /goal clear')
  })

  it('labels the footer for each status', () => {
    const goal = new GoalController()
    expect(goalFooter(null)).toBeNull()
    goal.set('Do it')
    expect(goalFooter(goal.get())).toBe('Pursuing goal (0s, round 0/30)')
    goal.pause()
    expect(goalFooter(goal.get())).toBe('Goal paused (/goal resume)')
    goal.limit('blocked')
    expect(goalFooter(goal.get())).toBe('Goal stalled (/goal resume)')
    goal.limit('usage_limited')
    expect(goalFooter(goal.get())).toBe('Goal hit usage limits (/goal resume)')
    goal.limit('budget_limited')
    expect(goalFooter(goal.get())).toBe('Goal unmet (0/30 rounds, 0s)')
    goal.accept()
    expect(goalFooter(goal.get())).toBe('Goal achieved (0s)')
  })

  it('records who changed the goal, omitting an objective too long to quote', () => {
    const goal = new GoalController()
    const short = goal.set('Do it')
    expect(provenanceText('set', short)).toBe('User set the goal: "Do it"')
    expect(provenanceText('paused', short)).toBe('User set goal status: "paused".')
    expect(provenanceText('cleared', null)).toBe('User cleared the goal.')
    const long = goal.set('y'.repeat(800))
    expect(provenanceText('set', long)).toBe('User set the goal: [objective omitted; exceeds the evidence limit].')
  })
})
