import { describe, expect, it } from 'vitest'

import { SubagentMonitor, type TerminalSubagentRun } from '../subagentMonitor'
import type { RunEvent } from '../../sessions/contracts'
import { commandDetail, workingPhase, type WorkingPhaseInput } from './workingPhase'

const now = Date.parse('2026-11-01T16:30:00.000Z')
const input = (extra: Partial<WorkingPhaseInput> = {}): WorkingPhaseInput => ({ now, tools: new Map(), subagents: [], retry: null, progressAt: now - 1_000, ...extra })
const child = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', parentRunId: 'p', relation: 'subagent', title: 'Trace steering', goal: null, status: 'running', startedAt: '2026-11-01T16:11:41.000Z', endedAt: null,
  activity: 'Read', usage: null, todo: null, lastEventAt: '2026-11-01T16:29:48.000Z', ...extra
}) as WorkingPhaseInput['subagents'][number]

describe('the working phase', () => {
  it('leaves the verb alone while the reply is plainly working', () => {
    expect(workingPhase(input())).toBeNull()
    expect(workingPhase(input({ tools: new Map([['t', { name: 'read', at: now - 2_000 }]]) }))).toBeNull()
  })

  it('names the command a lone long tool runs, and offers Esc after five minutes', () => {
    const detail = 'impeccable live-poll'
    expect(workingPhase(input({ tools: new Map([['a', { name: 'bash', at: now - 83_000, detail }]]) }))).toBe('Running Bash: impeccable live-poll · 1m 23s')
    expect(workingPhase(input({ tools: new Map([['a', { name: 'bash', at: now - 600_000, detail }]]) }))).toBe('Running Bash: impeccable live-poll · 10m · Esc to stop')
    expect(workingPhase(input({ tools: new Map([['a', { name: 'bash', at: now - 83_000, detail }], ['b', { name: 'bash', at: now - 83_000, detail: 'ls' }]]) }))).toBe('Running Bash ×2 · 1m 23s')
  })

  it('shortens a command to what a person recognises', () => {
    expect(commandDetail({ command: '"/Users/tanny/.agents/skills/impeccable/scripts/impeccable" live-poll' })).toBe('impeccable live-poll')
    expect(commandDetail({ command: 'a'.repeat(80) })).toHaveLength(48)
    expect(commandDetail({})).toBeUndefined()
  })

  it('names a wait on subagents and how recently they did anything', () => {
    const tools = new Map([['w', { name: 'wait_subagents', at: now - 900_000 }]])
    expect(workingPhase(input({ tools, subagents: [child()] }))).toBe('Waiting on 1 subagent · last activity 12s ago (Read)')
    expect(workingPhase(input({ tools, subagents: [child({ lastEventAt: '2026-11-01T16:29:57.000Z' }), child({ id: 'c2' })] }))).toBe('Waiting on 2 subagents · Read')
    expect(workingPhase(input({ tools, subagents: [] }))).toBe('Waiting on subagents')
  })

  it('tells a quiet child from a busy one', () => {
    const tools = new Map([['w', { name: 'wait_subagents', at: now - 900_000 }]])
    expect(workingPhase(input({ tools, subagents: [child({ lastEventAt: '2026-11-01T16:26:50.000Z' })] }))).toContain('last activity 3m 10s ago')
  })

  it('says it waits on a worker once the model has answered, not that the model is slow', () => {
    const answered = { answered: true, progressAt: now - 6 * 60_000 }
    expect(workingPhase(input({ ...answered, subagents: [child()] }))).toBe('Waiting on 1 subagent · last activity 12s ago (Read)')
    expect(workingPhase(input({ ...answered, subagents: [child({ status: 'completed' })] }))).toBeNull()
    expect(workingPhase(input({ ...answered }))).toBeNull()
  })

  it('names a long tool once, or its count when several of one kind run', () => {
    const at = now - 83_000
    expect(workingPhase(input({ tools: new Map([['a', { name: 'bash', at }]]) }))).toBe('Running Bash · 1m 23s')
    expect(workingPhase(input({ tools: new Map([['a', { name: 'web_fetch', at }], ['b', { name: 'web_fetch', at: at + 5_000 }]]) }))).toBe('Running WebFetch ×2 · 1m 23s')
  })

  it('says when the model has not answered, and when Esc is the way out', () => {
    expect(workingPhase(input({ progressAt: now - 75_000 }))).toBe('Waiting for the model · no output for 1m 15s')
    expect(workingPhase(input({ progressAt: now - 6 * 60_000 }))).toBe('No progress for 6m · Esc to stop')
  })

  it('counts down a retry, and keeps it until the request runs again', () => {
    const retry = { attempt: 2, maxAttempts: 8, retryAt: now + 4_200, error: 'Connection error.' }
    expect(workingPhase(input({ retry, progressAt: now - 600_000 }))).toBe('Reconnecting 2/8 · retry in 5s · Connection error.')
    expect(workingPhase(input({ retry: { ...retry, retryAt: now - 1 } }))).toBe('Reconnecting 2/8 · Connection error.')
  })

  it('reads the real incident: a parent waiting on a child that kept working', () => {
    const monitor = new SubagentMonitor()
    monitor.begin('p')
    const run: TerminalSubagentRun = { id: 'c1', parentRunId: 'p', relation: 'subagent', title: 'Trace', goal: null, status: 'running', startedAt: '2026-11-01T16:11:41.000Z', endedAt: null }
    const event = (type: string, sequence: number, timestamp: string, payload: Record<string, unknown> = {}) => ({ id: `e${sequence}`, runId: 'c1', sessionId: 'c1', sequence, timestamp, type, payload }) as RunEvent
    monitor.observe('p', run, event('tool.started', 1, '2026-11-01T16:29:40.000Z', { toolCallId: 't', name: 'read' }))
    monitor.observe('p', run, event('heartbeat', 2, '2026-11-01T16:29:50.000Z', { steps: 1 }))
    const subagents = monitor.snapshot('p')
    expect(subagents[0]?.lastEventAt).toBe('2026-11-01T16:29:40.000Z')
    const tools = new Map([['w', { name: 'wait_subagents', at: Date.parse('2026-11-01T16:15:18.750Z') }]])
    expect(workingPhase(input({ tools, subagents }))).toBe('Waiting on 1 subagent · last activity 20s ago (Read)')
  })
})
