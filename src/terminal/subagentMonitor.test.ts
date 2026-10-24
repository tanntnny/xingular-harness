import { describe, expect, it } from 'vitest'

import type { RunEvent } from '../sessions/contracts'
import { SubagentMonitor, type TerminalSubagentRun } from './subagentMonitor'

function run(id: string, parentRunId: string, startedAt: string, extra: Partial<TerminalSubagentRun> = {}): TerminalSubagentRun {
  return {
    id, parentRunId, relation: 'subagent', goal: `Task ${id}`, status: 'running', startedAt, endedAt: null, ...extra
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
})
