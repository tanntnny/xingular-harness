import { describe, expect, it } from 'vitest'

import type { TodoItem } from './contracts'
import type { GoalState } from './goal'
import { goalStopOutcome, handoffFields, stopCheckpointReason, stopSummary } from './goalStop'

const goal = (status: GoalState['status'], lastReason: string): GoalState => ({
  goalId: 'g', objective: 'x', status, limits: { rounds: 30, hours: 8 }, rounds: 3, timeUsedSeconds: 0,
  createdAt: 0, updatedAt: 0, claimed: false, lastReason
})

const todo: TodoItem[] = [
  { text: 'Port the health route', status: 'completed' },
  { text: 'Port the courses route', status: 'in_progress' },
  { text: 'Shadow-compare both', status: 'pending' }
]

describe('goal stops (ADR-0072, ADR-0075)', () => {
  it('ends a reply for the person when its goal is blocked, and leaves work when a goal is limited', () => {
    expect(goalStopOutcome(todo, goal('blocked', 'The deploy key is missing.'))).toMatchObject({ code: 'needs_person', reason: 'The deploy key is missing.' })
    expect(goalStopOutcome(todo, goal('budget_limited', 'The goal reached its limit.'))).toMatchObject({ code: 'unfinished' })
    expect(goalStopOutcome(todo, goal('usage_limited', ''))).toMatchObject({ code: 'unfinished' })
    expect(goalStopOutcome(todo, goal('paused', ''))).toMatchObject({ code: 'unfinished' })
  })

  it('does not stop a reply for an active, complete or absent goal, even with open todo items', () => {
    expect(goalStopOutcome(todo, goal('complete', ''))).toBeNull()
    expect(goalStopOutcome(todo, goal('active', ''))).toBeNull()
    expect(goalStopOutcome(todo, null)).toBeNull()
    expect(goalStopOutcome([], goal('blocked', 'The deploy key is missing.'))).toMatchObject({ code: 'needs_person' })
  })

  it('builds the handoff from the todo list and the blocked goal', () => {
    const blocked = handoffFields(todo, goal('blocked', 'The deploy key is missing.'))
    expect(blocked.next).toBe('Port the courses route')
    expect(blocked.done).toEqual([{ item: 'Port the health route', evidence: [] }])
    expect(blocked.blocked).toBe('The deploy key is missing.')
    expect(handoffFields(todo, null)).not.toHaveProperty('blocked')
  })

  it('summarises the stop and picks the checkpoint reason', () => {
    const blocked = goalStopOutcome(todo, goal('blocked', 'The deploy key is missing.'))!
    expect(stopSummary(blocked)).toBe('The reply stopped for the person: The deploy key is missing.')
    expect(stopCheckpointReason(blocked)).toBe('requested')
    const limited = goalStopOutcome(todo, goal('paused', ''))!
    expect(stopSummary(limited)).toBe('The reply ended with work left: The goal is paused.')
    expect(stopCheckpointReason(limited)).toBe('stuck')
  })
})
