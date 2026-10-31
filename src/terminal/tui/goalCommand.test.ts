import { describe, expect, it, vi } from 'vitest'

import { GoalController } from '../../sessions/goal'
import { runGoalCommand, type GoalCommandDeps } from './goalCommand'

function deps(overrides: Partial<GoalCommandDeps> = {}) {
  const controller = new GoalController()
  const calls: string[] = []
  const value: GoalCommandDeps = {
    controller,
    idle: () => true,
    start: vi.fn(async (content: string) => void calls.push(`start:${content}`)),
    steer: vi.fn(async (content: string) => void calls.push(`steer:${content}`)),
    note: vi.fn(async (content: string) => void calls.push(`note:${content}`)),
    interrupt: vi.fn(async () => void calls.push('interrupt')),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => 'A better objective'),
    ...overrides
  }
  return { ...value, calls }
}

describe('/goal in the terminal (ADR-0072)', () => {
  it('shows no goal, then sets one and starts work at once with who set it and the audit prompt', async () => {
    const host = deps()
    expect(await runGoalCommand('', host)).toContain('No goal is currently set.')
    const message = await runGoalCommand('--rounds 12 port the API', host)
    expect(message).toBe('Goal active\nObjective: port the API')
    expect(host.controller.get()).toMatchObject({ objective: 'port the API', status: 'active', limits: { rounds: 12, hours: 8 } })
    expect(host.start).toHaveBeenCalledTimes(1)
    const started = vi.mocked(host.start).mock.calls[0][0]
    expect(started).toContain('User set the goal: "port the API"')
    expect(started).toContain('Continue working toward the active thread goal.')
    expect(await runGoalCommand('', host)).toContain('Status: active')
  })

  it('asks before replacing an unfinished goal, and keeps it when declined', async () => {
    const host = deps()
    await runGoalCommand('first', host)
    host.confirm = vi.fn(async () => false)
    expect(await runGoalCommand('second', host)).toBe('Kept the current goal.')
    expect(host.controller.get()?.objective).toBe('first')
    host.confirm = vi.fn(async () => true)
    await runGoalCommand('second', host)
    expect(host.confirm).toHaveBeenCalledWith('Replace goal?', expect.stringContaining('first'))
    expect(host.controller.get()?.objective).toBe('second')
    // A finished goal is replaced without asking.
    host.controller.accept()
    host.confirm = vi.fn(async () => false)
    await runGoalCommand('third', host)
    expect(host.confirm).not.toHaveBeenCalled()
    expect(host.controller.get()?.objective).toBe('third')
  })

  it('stops a running reply before starting a goal, and steers an edit into a running reply', async () => {
    const host = deps({ idle: () => false })
    await runGoalCommand('port the API', host)
    expect(host.calls[0]).toBe('interrupt')
    await runGoalCommand('edit', host)
    expect(host.input).toHaveBeenCalledWith('Edit goal', 'port the API')
    expect(host.controller.get()?.objective).toBe('A better objective')
    expect(host.steer).toHaveBeenCalledTimes(1)
    expect(vi.mocked(host.steer).mock.calls[0][0]).toContain('The active thread goal objective was edited by the user.')
  })

  it('pauses (and records the person\'s word), resumes, and clears', async () => {
    const host = deps()
    await runGoalCommand('port the API', host)
    host.calls.length = 0
    expect(await runGoalCommand('pause', host)).toContain('Goal paused')
    expect(host.controller.get()?.status).toBe('paused')
    expect(host.calls).toEqual(['note:User set goal status: "paused".'])
    expect(await runGoalCommand('resume', host)).toBe('Goal active')
    expect(host.controller.get()?.status).toBe('active')
    expect(host.calls.at(-1)).toContain('User set goal status: "active".')
    expect(await runGoalCommand('clear', host)).toBe('Goal cleared')
    expect(host.controller.get()).toBeNull()
    expect(host.calls.at(-1)).toBe('note:User cleared the goal.')
    expect(await runGoalCommand('clear', host)).toBe('No goal to clear.')
    expect(await runGoalCommand('pause', host)).toBe('No goal to pause.')
    expect(await runGoalCommand('resume', host)).toBe('No goal to resume.')
  })

  it('reports a bad request as text', async () => {
    const host = deps()
    expect(await runGoalCommand('--hours 0 x', host)).toContain('Usage: /goal')
    expect(await runGoalCommand('x'.repeat(4_100), host)).toContain('the limit is 4000')
    await runGoalCommand('port the API', host)
    host.controller.accept()
    expect(await runGoalCommand('resume', host)).toContain('The goal is complete.')
  })
})
