import { describe, expect, it } from 'vitest'

import { runEventSchema, type RunEvent } from '../sessions/contracts'
import { TODO_GUIDANCE, todoOf, todoTool, describeTodo } from './todo'

const event = (sequence: number, payload: unknown, type: RunEvent['type'] = 'todo.updated'): RunEvent => ({ id: `e${sequence}`, runId: 'r', sessionId: 's', sequence, timestamp: '2026-10-22T00:00:00.000Z', type, payload })

describe('the todo list', () => {
  it('replaces the whole list and reads back the latest one', () => {
    const events = [event(0, { items: [{ text: 'a', status: 'pending' }] }), event(1, { items: [{ text: 'b', status: 'completed' }] })]
    expect(todoOf(events)).toEqual([{ text: 'b', status: 'completed' }])
    expect(todoOf([])).toEqual([])
    expect(describeTodo([])).toBe('The todo list is empty.')
  })

  it('reads the pre-rename event so an old run keeps its list', () => {
    const legacy = [event(0, { items: [{ text: 'old', status: 'completed' }] }, 'checklist.updated'), event(1, { items: [{ text: 'new', status: 'pending' }] })]
    expect(todoOf(legacy)).toEqual([{ text: 'new', status: 'pending' }])
    expect(todoOf([event(0, { items: [{ text: 'old', status: 'completed' }] }, 'checklist.updated')])).toEqual([{ text: 'old', status: 'completed' }])
    expect(runEventSchema.safeParse(event(0, { items: [{ text: 'a', status: 'pending' }] }, 'checklist.updated')).success).toBe(true)
  })

  it('validates the event payload', () => {
    expect(runEventSchema.safeParse(event(0, { items: [{ text: 'a', status: 'pending' }] })).success).toBe(true)
    expect(runEventSchema.safeParse(event(0, { items: [{ text: 'a', status: 'done' }] })).success).toBe(false)
    expect(runEventSchema.safeParse(event(0, { items: Array.from({ length: 51 }, () => ({ text: 'a', status: 'pending' })) })).success).toBe(false)
  })

  it('emits one todo event per write and refuses a malformed list without emitting', async () => {
    const emitted: { type: string; payload: unknown }[] = []
    const tool = todoTool({ emit: (type, payload) => void emitted.push({ type, payload }) })
    expect(tool.name).toBe('todo_write')
    expect(tool.readOnly).toBe(true)
    expect(tool.description).toContain('before your first other tool call')
    expect(tool.description).toContain(TODO_GUIDANCE)
    expect(tool.description).toContain('Before your final reply, write one final update')
    expect(await tool.execute({ items: 'nope' })).toContain('whole todo list')
    expect(await tool.execute({ items: [{ text: 'x'.repeat(501), status: 'pending' }] })).toContain('Every step needs text')
    expect(await tool.execute({ items: [{ text: '  Ship it  ', status: 'pending' }] })).toBe('[ ] Ship it')
    expect(emitted).toEqual([{ type: 'todo.updated', payload: { items: [{ text: 'Ship it', status: 'pending' }] } }])
  })
})
