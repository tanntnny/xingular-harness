import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent, RunRecord } from '../sessions/contracts'
import type { ActiveRun } from '../sessions/registry'
import { TerminalController, type ControllerHooks } from './controller'
import { REPLY_STALL_MS, TOOL_STALL_MS } from './stallWatch'

function setup() {
  const interrupt = vi.fn(async () => {})
  const run = { runId: 'parent', finished: false, emit: vi.fn(), onInterrupt: vi.fn(), finish: vi.fn(), requestAnswer: vi.fn(), requestApproval: vi.fn() } as unknown as ActiveRun
  const hooks = {
    sessionId: 's1',
    nativeSessionId: null,
    begin: () => run,
    telemetry: vi.fn(),
    interrupt,
    policy: vi.fn(),
    workspaceRoot: () => '/tmp'
  } as unknown as ControllerHooks
  const controller = new TerminalController(hooks)
  return { controller, interrupt }
}

let sequence = 0
function event(type: RunEvent['type'], runId: string, payload: Record<string, unknown> = {}): RunEvent {
  return { id: `e${++sequence}`, runId, sessionId: runId, sequence, timestamp: new Date().toISOString(), type, payload } as RunEvent
}

const child = (id: string, status = 'running'): RunRecord => ({ id, parentRunId: 'parent', relation: 'subagent', status, goal: 'research', startedAt: new Date().toISOString(), endedAt: null } as unknown as RunRecord)

beforeEach(() => {
  vi.useFakeTimers()
  sequence = 0
})
afterEach(() => vi.useRealTimers())

describe('a terminal reply that waits for subagents', () => {
  it('is not cut short while its child keeps producing events, however long the wait', async () => {
    const { controller, interrupt } = setup()
    await controller.accept('begin', { text: 'go' })
    await controller.accept('tool', { phase: 'start', id: 'w1', name: 'wait_subagents' })
    for (let minutes = 0; minutes < 40; minutes += 5) {
      controller.observeSubagent('parent', child('c1'), event('tool.completed', 'c1', { toolCallId: `t${minutes}` }))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    }
    expect(interrupt).not.toHaveBeenCalled()
    expect(await controller.accept('poll', {})).toEqual({ command: null })
  })

  it('ends a quiet child on its own clock and leaves the parent running', async () => {
    const { controller, interrupt } = setup()
    await controller.accept('begin', { text: 'go' })
    await controller.accept('tool', { phase: 'start', id: 'w1', name: 'wait_subagents' })
    controller.observeSubagent('parent', child('c1'), event('usage.updated', 'c1'))
    // Heartbeats prove the process lives, not that the child works.
    for (let elapsed = 0; elapsed < REPLY_STALL_MS + 60_000; elapsed += 30_000) {
      controller.observeSubagent('parent', child('c1'), event('heartbeat', 'c1', { steps: 1 }))
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(interrupt).toHaveBeenCalledWith('c1', { reason: 'stalled', code: 'stalled' })
    expect(await controller.accept('poll', {})).toEqual({ command: null })
  })

  it('lets a child run one tool as long as a reply may, then ends it', async () => {
    const { controller, interrupt } = setup()
    await controller.accept('begin', { text: 'go' })
    await controller.accept('tool', { phase: 'start', id: 'w1', name: 'wait_subagents' })
    controller.observeSubagent('parent', child('c1'), event('tool.started', 'c1', { toolCallId: 't1', name: 'bash' }))
    await vi.advanceTimersByTimeAsync(TOOL_STALL_MS - 60_000)
    expect(interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(interrupt).toHaveBeenCalledWith('c1', { reason: 'stalled', code: 'stalled' })
  })

  it('takes the parent back under its own watch once a child ignores the stop', async () => {
    const { controller } = setup()
    await controller.accept('begin', { text: 'go' })
    await controller.accept('tool', { phase: 'start', id: 'w1', name: 'wait_subagents' })
    controller.observeSubagent('parent', child('c1'), event('usage.updated', 'c1'))
    await vi.advanceTimersByTimeAsync(TOOL_STALL_MS + 6 * 60_000)
    expect(await controller.accept('poll', {})).toEqual({ command: { type: 'interrupt' } })
  })

  it('still ends a reply that is silent without any child', async () => {
    const { controller } = setup()
    await controller.accept('begin', { text: 'go' })
    await vi.advanceTimersByTimeAsync(REPLY_STALL_MS + 31_000)
    expect(await controller.accept('poll', {})).toEqual({ command: { type: 'interrupt' } })
  })

  it('forgets a child once it settles', async () => {
    const { controller, interrupt } = setup()
    await controller.accept('begin', { text: 'go' })
    controller.observeSubagent('parent', child('c1'), event('usage.updated', 'c1'))
    controller.observeSubagent('parent', child('c1', 'completed'), event('completed', 'c1'))
    await vi.advanceTimersByTimeAsync(REPLY_STALL_MS + 31_000)
    expect(interrupt).not.toHaveBeenCalled()
  })
})
