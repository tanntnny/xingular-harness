import { describe, expect, it } from 'vitest'

import { runEventSchema, type RunEvent } from '../sessions/contracts'
import { checklistOf, checklistTool, describeChecklist } from './checklist'

const event = (sequence: number, payload: unknown): RunEvent => ({ id: `e${sequence}`, runId: 'r', sessionId: 's', sequence, timestamp: '2026-10-22T00:00:00.000Z', type: 'checklist.updated', payload })

describe('the checklist', () => {
  it('replaces the whole list and reads back the latest one', () => {
    const events = [event(0, { items: [{ text: 'a', status: 'pending' }] }), event(1, { items: [{ text: 'b', status: 'completed' }] })]
    expect(checklistOf(events)).toEqual([{ text: 'b', status: 'completed' }])
    expect(checklistOf([])).toEqual([])
    expect(describeChecklist([])).toBe('The checklist is empty.')
  })

  it('validates the event payload', () => {
    expect(runEventSchema.safeParse(event(0, { items: [{ text: 'a', status: 'pending' }] })).success).toBe(true)
    expect(runEventSchema.safeParse(event(0, { items: [{ text: 'a', status: 'done' }] })).success).toBe(false)
    expect(runEventSchema.safeParse(event(0, { items: Array.from({ length: 51 }, () => ({ text: 'a', status: 'pending' })) })).success).toBe(false)
  })

  it('emits one event per write and refuses a malformed list without emitting', async () => {
    const emitted: unknown[] = []
    const tool = checklistTool({ emit: (_type, payload) => void emitted.push(payload) })
    expect(tool.readOnly).toBe(true)
    expect(await tool.execute({ items: 'nope' })).toContain('whole checklist')
    expect(await tool.execute({ items: [{ text: 'x'.repeat(501), status: 'pending' }] })).toContain('Every step needs text')
    expect(await tool.execute({ items: [{ text: '  Ship it  ', status: 'pending' }] })).toBe('[ ] Ship it')
    expect(emitted).toEqual([{ items: [{ text: 'Ship it', status: 'pending' }] }])
  })
})
