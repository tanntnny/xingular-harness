// The one explicit way to end a reply while todo items are still open (ADR-0069). A reply whose
// todo list is complete simply ends; a reply with open items either keeps working or calls
// `finish` with `blocked` or `needs_decision` and names what the person must do. `done` is refused
// while the list still holds open items. It only changes run state, so it stays callable in plan mode.
import type { TodoItem } from '../sessions/contracts'
import type { StopGateState } from '../sessions/stopGate'
import type { ToolSpec } from './types'

export const FINISH = 'finish'
export const FINISH_STATUSES = ['done', 'blocked', 'needs_decision'] as const
export type FinishStatus = typeof FINISH_STATUSES[number]
export const MAX_FINISH_TEXT = 500

/** What a reply declared about how it ends. */
export interface FinishRecord {
  status: FinishStatus
  /** Why the work cannot continue; empty for `done`. */
  reason: string
  /** What the person must do or decide; optional. */
  needs: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The todo items a reply has not finished. */
export function openItems(todo: readonly TodoItem[]): TodoItem[] {
  return todo.filter((item) => item.status !== 'completed')
}

/** The finish call as the model sent it, or one line saying what to fix. */
export function checkFinish(input: unknown, todo: readonly TodoItem[]): { ok: true; value: FinishRecord } | { ok: false; error: string } {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const status = record.status
  if (!FINISH_STATUSES.includes(status as FinishStatus)) return { ok: false, error: 'status is done, blocked or needs_decision.' }
  const reason = text(record.reason)
  const needs = text(record.needs)
  if (reason.length > MAX_FINISH_TEXT || needs.length > MAX_FINISH_TEXT) return { ok: false, error: `Keep reason and needs to ${MAX_FINISH_TEXT} characters each.` }
  if (status === 'done') {
    const open = openItems(todo)
    if (open.length) {
      return {
        ok: false,
        error: `Not finished: ${open.length} todo item${open.length === 1 ? ' is' : 's are'} still open — ${open.map((item) => item.text).join('; ')}. ` +
          'Do them, and mark each completed only after it is done and checked. If one truly cannot continue without the person, call finish with blocked or needs_decision and name why.'
      }
    }
    return { ok: true, value: { status, reason: '', needs: '' } }
  }
  if (!reason) return { ok: false, error: `finish with ${status as string} needs a reason: what stops the work, in one or two sentences.` }
  return { ok: true, value: { status: status as FinishStatus, reason, needs } }
}

export function finishTool(state: StopGateState): ToolSpec {
  return {
    name: FINISH,
    label: 'Finish the work',
    description:
      'Declare how this reply ends when its todo list still has open items. A reply whose todo items are all completed simply ends; one that ends with open items is sent back to you to keep working. ' +
      'Call finish with status blocked when something outside your reach stops the work (missing access, a failing service, a required secret), or needs_decision when only the person can choose (a deploy, money, remote data, a product choice). ' +
      'Give the reason in one or two sentences and, in needs, exactly what the person must do or decide. status done is refused while any todo item is open. ' +
      'Never call it to pause work you can still do, to report progress, or because the task is long. It does not write your reply: after it, write the final reply for the person.',
    parameters: (Type) =>
      Type.Object({
        status: Type.Union([Type.Literal('done'), Type.Literal('blocked'), Type.Literal('needs_decision')]),
        reason: Type.Optional(Type.String({ description: 'Why the work cannot continue now (required unless done; max 500 characters)' })),
        needs: Type.Optional(Type.String({ description: 'What the person must do or decide to unblock it (max 500 characters)' }))
      }),
    readOnly: true,
    planModeSafe: () => true,
    execute: async (input) => {
      const checked = checkFinish(input, state.todo)
      if (!checked.ok) return checked.error
      state.finish = checked.value
      if (checked.value.status === 'done') return 'Recorded: the work is done. Write the final reply now.'
      return `Recorded: ${checked.value.status === 'blocked' ? 'blocked' : 'needs your decision'} — ${checked.value.reason} ` +
        'Write the final reply: what is done, then `## What would make this complete` with the remaining steps in order, naming what only the person can do.'
    }
  }
}
