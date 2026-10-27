import { describe, expect, it } from 'vitest'

import type { RunEvent } from '../sessions/contracts'
import { MAIN_PROFILE, SubagentMonitor, type TerminalSubagentRun } from './subagentMonitor'

function run(id: string, parentRunId: string, startedAt: string, extra: Partial<TerminalSubagentRun> = {}): TerminalSubagentRun {
  return {
    id, parentRunId, relation: 'subagent', title: `Title ${id}`, goal: `Task ${id}`, status: 'running', startedAt, endedAt: null, ...extra
  }
}

function event(type: RunEvent['type'], sequence: number, payload: Record<string, unknown> = {}): RunEvent {
  return {
    id: `event-${sequence}`, runId: 'child', sessionId: 'child-session', sequence,
    timestamp: `2026-10-23T00:00:${String(sequence).padStart(2, '0')}.000Z`, type, payload
  } as RunEvent
}

describe('SubagentMonitor', () => {
  it('projects tool names without exposing summaries, arguments, or output', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    monitor.observe('parent', run('child', 'parent', '2026-10-23T00:00:00.000Z'), event('tool.started', 1, {
      toolCallId: 'call-1', name: 'read', summary: 'PRIVATE_SUMMARY src/auth.ts', input: '{"token":"PRIVATE_ARGUMENTS"}'
    }))

    expect(monitor.snapshot('parent')).toEqual([expect.objectContaining({
      id: 'child', goal: 'Task child', status: 'running', activity: 'read'
    })])
    const output = JSON.stringify(monitor.snapshot('parent'))
    expect(output).not.toContain('PRIVATE_SUMMARY')
    expect(output).not.toContain('PRIVATE_ARGUMENTS')
  })

  it('keeps the parent title when the child names its own session, and counts the todo', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    const child = run('child', 'parent', '2026-10-23T00:00:00.000Z', { title: 'Map the auth flow', profile: { name: 'worker', color: 'green' } })
    monitor.observe('parent', child, event('tool.started', 1, { toolCallId: 'n1', name: 'session_name', input: '{"name":"Fix   the login"}' }))
    expect(monitor.snapshot('parent')[0]).toMatchObject({ title: 'Map the auth flow', profile: { name: 'worker', color: 'green' }, todo: null })
    monitor.observe('parent', child, event('tool.completed', 2, { toolCallId: 'n1', name: 'session_name', ok: true }))
    monitor.observe('parent', child, event('todo.updated', 5, { items: [{ text: 'PRIVATE_STEP', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }] }))
    const row = monitor.snapshot('parent')[0]!
    expect(row).toMatchObject({ title: 'Map the auth flow', todo: { done: 1, total: 3 } })
    expect(JSON.stringify(row)).not.toContain('Fix the login')
    expect(JSON.stringify(row)).not.toContain('PRIVATE_STEP')
    monitor.observe('parent', child, event('todo.updated', 6, { items: [] }))
    expect(monitor.snapshot('parent')[0]?.todo).toBeNull()
    monitor.observe('parent', child, event('checklist.updated', 7, { items: [{ text: 'legacy', status: 'completed' }] }))
    expect(monitor.snapshot('parent')[0]?.todo).toEqual({ done: 1, total: 1 })
  })

  it('projects only safe cumulative usage and volatile runtime metadata', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    const child = run('child', 'parent', '2026-10-23T00:00:00.000Z', {
      accountLabel: 'Main', model: 'openai/gpt-5', effort: 'low'
    })
    monitor.observe('parent', child, event('usage.updated', 1, {
      provider: 'openai', model: 'gpt-5', inputTokens: 1_200, outputTokens: 300,
      cacheReadTokens: 800, cacheWriteTokens: 40, reasoningTokens: 120,
      costUsd: 0.004, costSource: 'estimate', requests: 2, contextTokens: 2_300, contextWindow: 128_000,
      request: { index: 2, reasoningSummary: 'PRIVATE_REASONING_SUMMARY' }
    }))

    const row = monitor.snapshot('parent')[0]!
    expect(row).toMatchObject({ accountLabel: 'Main', model: 'openai/gpt-5', effort: 'low' })
    expect(row.usage).toEqual({
      provider: 'openai', model: 'gpt-5', inputTokens: 1_200, outputTokens: 300,
      cacheReadTokens: 800, cacheWriteTokens: 40, reasoningTokens: 120,
      costUsd: 0.004, costSource: 'estimate', requests: 2, contextTokens: 2_300, contextWindow: 128_000
    })
    expect(JSON.stringify(row)).not.toContain('PRIVATE_REASONING_SUMMARY')
  })

  it('retains the latest completed tool name across status updates between polls', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    const child = run('child', 'parent', '2026-10-23T00:00:00.000Z')
    monitor.observe('parent', child, event('tool.started', 1, { toolCallId: 'call-1', name: 'read', summary: 'PRIVATE_SUMMARY' }))
    monitor.observe('parent', child, event('tool.completed', 2, { toolCallId: 'call-1', output: 'PRIVATE_OUTPUT' }))
    expect(monitor.snapshot('parent')[0]?.activity).toBe('read')

    monitor.observe('parent', child, event('status.changed', 3, { status: 'running' }))
    expect(monitor.snapshot('parent')[0]?.activity).toBe('read')
    expect(JSON.stringify(monitor.snapshot('parent'))).not.toContain('PRIVATE')
  })

  it('keeps descendants flat and in start order, then clears them with the parent run', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    monitor.observe('parent', run('later', 'parent', '2026-10-23T00:00:02.000Z'), event('started', 1))
    monitor.observe('parent', run('nested', 'later', '2026-10-23T00:00:01.000Z'), event('started', 2))

    expect(monitor.snapshot('parent').map(item => item.id)).toEqual(['nested', 'later'])
    expect(monitor.snapshot('other-parent')).toEqual([])
    monitor.clear('parent')
    expect(monitor.snapshot('parent')).toEqual([])
  })

  it('reports waiting and settled states instead of a stale tool activity', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    monitor.observe('parent', run('child', 'parent', '2026-10-23T00:00:00.000Z'), event('tool.started', 1, {
      toolCallId: 'call-1', name: 'bash', summary: 'Running checks'
    }))
    monitor.observe('parent', run('child', 'parent', '2026-10-23T00:00:00.000Z', { status: 'waiting_for_approval' }), event('status.changed', 2))
    expect(monitor.snapshot('parent')[0]).toMatchObject({ status: 'waiting_for_approval', activity: 'Waiting for approval' })

    monitor.observe('parent', run('child', 'parent', '2026-10-23T00:00:00.000Z', { status: 'completed', endedAt: '2026-10-23T00:00:03.000Z' }), event('completed', 3))
    expect(monitor.snapshot('parent')[0]).toMatchObject({ status: 'completed', activity: 'Completed' })
  })

  it('puts the main row first, folds the parent’s own events, and ignores a main row for another run', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('parent')
    monitor.observe('parent', run('child', 'parent', '2026-10-23T00:00:00.000Z'), event('tool.started', 1, { toolCallId: 'c1', name: 'grep' }))
    const main = run('parent', null as unknown as string, '2026-10-23T00:00:01.000Z', { relation: 'main', profile: MAIN_PROFILE })
    monitor.observe('parent', main, event('usage.updated', 2, { inputTokens: 10, outputTokens: 5, model: 'gpt-x', provider: 'openai' }))
    monitor.observe('parent', main, event('todo.updated', 3, { items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] }))
    monitor.observe('parent', run('other', null as unknown as string, '2026-10-23T00:00:02.000Z', { relation: 'main' }), event('tool.started', 4, { toolCallId: 'x', name: 'read' }))
    expect(monitor.snapshot('parent').map(row => row.id)).toEqual(['parent', 'child'])
    expect(monitor.snapshot('parent')[0]).toMatchObject({ relation: 'main', profile: MAIN_PROFILE, usage: { inputTokens: 10, model: 'gpt-x' }, todo: { done: 1, total: 2 } })
  })

  it('restores a saved parent and its children as they ended', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('earlier')
    monitor.restore('parent', [
      { run: run('parent', null as unknown as string, '2026-10-23T00:00:00.000Z', { relation: 'main', status: 'interrupted' }), events: [] },
      { run: run('child', 'parent', '2026-10-23T00:00:01.000Z', { status: 'interrupted' }), events: [event('tool.started', 1, { toolCallId: 'c1', name: 'edit' }), event('usage.updated', 2, { inputTokens: 3 })] }
    ])
    expect(monitor.snapshot('earlier')).toEqual([])
    expect(monitor.snapshot('parent')).toEqual([
      expect.objectContaining({ id: 'parent', relation: 'main', status: 'interrupted', activity: 'Interrupted' }),
      expect.objectContaining({ id: 'child', status: 'interrupted', activity: 'Interrupted', usage: { inputTokens: 3 } })
    ])
  })
})
