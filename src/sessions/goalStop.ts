// The goal part of a stop: a /goal that ended blocked, paused or at a limit leaves work for the
// person, and its checkpoint's done/next comes from the reply's todo list. An ordinary reply has no
// gate and settles as it ends (ADR-0075).
import { MAX_CHECKPOINT_DONE, type Checkpoint, type TodoItem } from './contracts'
import type { GoalState } from './goal'

/** The todo items a reply has not finished. */
export function openItems(todo: readonly TodoItem[]): TodoItem[] {
  return todo.filter((item) => item.status !== 'completed')
}

/** How a settled reply ended when its goal is not done; `null` when it is. */
export type StopOutcome =
  | { code: 'needs_person'; reason: string; open: TodoItem[] }
  | { code: 'unfinished'; reason: string; open: TodoItem[] }

/**
 * `goal` is the session's /goal, when it has one: a goal that ended blocked needs the person, and
 * one that ended on a limit or a pause leaves work (ADR-0072).
 */
export function goalStopOutcome(todo: readonly TodoItem[], goal?: GoalState | null): StopOutcome | null {
  const open = openItems(todo)
  if (goal?.status === 'blocked') return { code: 'needs_person', reason: goal.lastReason || 'The goal is blocked.', open }
  if (goal && (goal.status === 'budget_limited' || goal.status === 'usage_limited' || goal.status === 'paused')) {
    return { code: 'unfinished', reason: goal.lastReason || `The goal is ${goal.status.replace('_', ' ')}.`, open }
  }
  return null
}

/** What a checkpoint learns from the reply's todo list and the goal. */
export function handoffFields(todo: readonly TodoItem[], goal?: GoalState | null): Pick<Checkpoint, 'done' | 'next'> & { blocked?: string } {
  const next = openItems(todo)[0]?.text || ''
  const blocked = goal?.status === 'blocked' ? (goal.lastReason || 'The goal is blocked.').slice(0, 500) : ''
  return {
    done: todo.filter((item) => item.status === 'completed').slice(0, MAX_CHECKPOINT_DONE).map((item) => ({ item: item.text.slice(0, 300), evidence: [] })),
    next: next.slice(0, 500),
    ...(blocked ? { blocked } : {})
  }
}

/** Why a checkpoint written for a stop outcome was written. */
export const stopCheckpointReason = (outcome: StopOutcome): Checkpoint['reason'] => outcome.code === 'needs_person' ? 'requested' : 'stuck'

/** The summary a stop outcome's checkpoint falls back to when the reply left no text. */
export function stopSummary(outcome: StopOutcome): string {
  if (outcome.code === 'needs_person') return `The reply stopped for the person: ${outcome.reason}`.slice(0, 1_200)
  if (outcome.reason) return `The reply ended with work left: ${outcome.reason}`.slice(0, 1_200)
  return `The reply ended with ${outcome.open.length} open todo item${outcome.open.length === 1 ? '' : 's'}.`
}
