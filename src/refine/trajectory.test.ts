import { expect, test } from 'vitest'
import type { RunEvent } from '../sessions/contracts'
import { renderEvents } from './trajectory'

function event(type: RunEvent['type'], payload: unknown): RunEvent {
  return { id: 'e', runId: 'r', sessionId: 's', sequence: 0, timestamp: '2026-01-01', type, payload }
}

test('renders refusal and interruption evidence, with code fallback for old events', () => {
  const text = renderEvents([
    event('tool.refused', { toolCallId: 't', name: 'write', code: 'plan_mode', reason: 'Read only' }),
    event('status.changed', { status: 'interrupted', reason: 'Budget reached', code: 'slice_budget' }),
    event('status.changed', { status: 'interrupted', code: 'stalled' }),
    event('status.changed', { status: 'interrupted' })
  ], { obsTrunc: 10000 })
  expect(text).toContain('[ERROR] write refused (plan_mode): Read only')
  expect(text).toContain('[ERROR] run interrupted: Budget reached')
  expect(text).toContain('[ERROR] run interrupted: stalled')
  expect(text.endsWith('[ERROR] run interrupted')).toBe(true)
})
