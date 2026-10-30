// The stop gate (ADR-0069): a reply the model ends while its todo list still holds open items is
// sent back to it, up to a cap, instead of settling as `completed`. A reply may still end with open
// items, but only by declaring it with `finish` (blocked / needs_decision), or when the gate has
// nudged as often as it may, or when a nudge produced no work. Every decision is deterministic:
// it reads the reply's own todo list and finish record, never a model judgment.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { FINISH, openItems, type FinishRecord } from '../tools/finish'
import { TODO_WRITE } from '../tools/todo'
import { validatedTodo } from './compactionCheckpoint'
import { MAX_CHECKPOINT_DONE, type Checkpoint, type TodoItem } from './contracts'

export const STOP_GATE_EXTENSION = 'stop-gate'
export const STOP_GATE_CUSTOM_TYPE = 'xingular-stop-gate'
/** Nudges per reply before the reply is handed back to the person as unfinished. */
export const MAX_STOP_GATE_NUDGES = 3

/** What the gate knows about the live reply. One object is shared with the `finish` tool. */
export interface StopGateState {
  /** The reply's todo list as the model last wrote it (or as a continued run inherited it). */
  todo: TodoItem[]
  /** How the reply declared it ends, if it called `finish`. */
  finish: FinishRecord | null
  /** Nudges sent in this reply. */
  nudges: number
  /** Tool calls other than todo_write and finish since the last nudge. */
  callsSinceNudge: number
}

export function createStopGateState(initialTodo: readonly TodoItem[] = []): StopGateState {
  return { todo: validatedTodo(initialTodo) ?? [], finish: null, nudges: 0, callsSinceNudge: 0 }
}

/** A new reply starts from the inherited todo list, with no finish record and no nudges. */
export function resetStopGateState(state: StopGateState, initialTodo: readonly TodoItem[] = []): void {
  state.todo = validatedTodo(initialTodo) ?? []
  state.finish = null
  state.nudges = 0
  state.callsSinceNudge = 0
}

/** How a settled reply ended when its work is not done; `null` when nothing is left open. */
export type StopOutcome =
  | { code: 'needs_person'; finish: FinishRecord; open: TodoItem[] }
  | { code: 'unfinished'; open: TodoItem[] }

export function stopOutcome(state: StopGateState): StopOutcome | null {
  const open = openItems(state.todo)
  if (!open.length) return null
  if (state.finish && state.finish.status !== 'done') return { code: 'needs_person', finish: state.finish, open }
  return { code: 'unfinished', open }
}

/** What a checkpoint learns from the reply's todo list and `finish` declaration. */
export function handoffFields(state?: StopGateState | null): Pick<Checkpoint, 'done' | 'next'> & { blocked?: string } {
  const todo = state?.todo ?? []
  const next = openItems(todo)[0]?.text ?? ''
  const declared = state?.finish && state.finish.status !== 'done' ? state.finish : null
  const blocked = declared ? [declared.reason, declared.needs ? `Needs: ${declared.needs}` : ''].filter(Boolean).join(' ').slice(0, 500) : ''
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
  return outcome.code === 'needs_person'
    ? `The reply stopped for the person: ${outcome.finish.reason}`.slice(0, 1_200)
    : `The reply ended with ${outcome.open.length} open todo item${outcome.open.length === 1 ? '' : 's'}.`
}

/** The text the model reads when its reply is sent back. */
export function nudgeText(count: number, max: number, open: readonly TodoItem[]): string {
  const list = open.slice(0, 12).map((item) => `- ${item.text}`).join('\n')
  const more = open.length > 12 ? `\n- …and ${open.length - 12} more` : ''
  return [
    `Harness stop gate (${count}/${max}): your reply ended with ${open.length} open todo item${open.length === 1 ? '' : 's'} and nothing declared blocked:`,
    `${list}${more}`,
    'Continue with the next open item now. Mark an item completed only after it is done and checked.',
    'If an item truly cannot continue without the person (a decision, a secret, a deploy, missing access), call finish with status needs_decision or blocked and name exactly what is needed.'
  ].join('\n')
}

export interface StopGateOptions {
  state: StopGateState
  /** The todo list a continued run inherits; each new reply starts from it. */
  initialTodo?: readonly TodoItem[]
  /** Whether the gate applies to the current reply; a function follows the terminal's live plan switch. */
  active?: () => boolean
  /** True when the work-slice guard ended this reply: the gate stays silent and the slice hands off. */
  sliceEnded?: () => boolean
  /** True when the reply already failed (a provider error): nothing to continue. */
  failed?: () => boolean
  max?: number
  /** Called once per nudge, for the run record. */
  onNudge?: (count: number, open: TodoItem[]) => void
}

export function stopGate(options: StopGateOptions): (pi: ExtensionAPI) => void {
  const { state } = options
  const max = options.max ?? MAX_STOP_GATE_NUDGES
  return (pi) => {
    // Pi emits agent_start again for every continuation, so a reply resets only on a person's message.
    pi.on('before_agent_start', (event) => {
      if (event.messageType !== undefined && event.messageType !== 'user') return
      resetStopGateState(state, options.initialTodo)
    })
    pi.on('tool_call', (event) => {
      if (event.toolName !== TODO_WRITE && event.toolName !== FINISH) state.callsSinceNudge += 1
    })
    pi.on('tool_result', (event) => {
      if (event.toolName !== TODO_WRITE || event.isError) return
      const items = validatedTodo((event.input as { items?: unknown } | undefined)?.items)
      if (items) state.todo = items
    })
    pi.on('agent_before_settle', (event, ctx) => {
      if (event.outcome !== 'completed' || event.continue || ctx?.signal?.aborted) return
      if (options.active && !options.active()) return
      if (options.sliceEnded?.() || options.failed?.()) return
      const open = openItems(state.todo)
      if (!open.length) return
      if (state.finish && state.finish.status !== 'done') return
      if (state.nudges >= max) return
      // A nudge that produced no work will not be followed by one that does: hand it back.
      if (state.nudges > 0 && state.callsSinceNudge === 0) return
      state.nudges += 1
      state.callsSinceNudge = 0
      options.onNudge?.(state.nudges, open)
      return {
        entries: [...event.entries, { type: 'custom_message', customType: STOP_GATE_CUSTOM_TYPE, content: nudgeText(state.nudges, max, open), display: true }],
        continue: true
      }
    })
  }
}
