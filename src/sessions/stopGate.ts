// The stop gate (ADR-0069, ADR-0072): a reply may not quietly end while its own todo list still has
// open items. At Pi's `agent_before_settle` boundary the reply is sent back, with no model call,
// until the list is closed, up to a cap of nudges per reply and the no-progress rule. The list
// shows progress, not scope: a closed list is not proof that the request is done, and no layer
// here judges that (ADR-0072 removed the every-reply completion check; only a /goal checks a claim).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { TODO_WRITE } from '../tools/todo'
import { validatedTodo } from './compactionCheckpoint'
import { answerText, type CheckModel } from './completionCheck'
import { MAX_CHECKPOINT_DONE, type Checkpoint, type TodoItem } from './contracts'
import type { GoalState } from './goal'

export const STOP_GATE_EXTENSION = 'stop-gate'
export const STOP_GATE_CUSTOM_TYPE = 'xingular-stop-gate'
/** Nudges per reply before the reply is handed back to the person. */
export const MAX_STOP_GATE_NUDGES = 3
/** Calls that are bookkeeping, not work: they neither count as progress nor make a reply checkable. */
const BOOKKEEPING_TOOLS = new Set([TODO_WRITE, 'session_name'])

/** What the gate knows about the live reply. */
export interface StopGateState {
  /** The reply's todo list as the model last wrote it (or as a continued run inherited it). */
  todo: TodoItem[]
  /** The person's request this reply answers. */
  request: string
  /** Nudges sent in this reply. */
  nudges: number
  /** Work tool calls since the last nudge. */
  callsSinceNudge: number
  /** Work tool calls in this reply. */
  callsInReply: number
}

export function createStopGateState(initialTodo: readonly TodoItem[] = []): StopGateState {
  return { todo: validatedTodo(initialTodo) ?? [], request: '', nudges: 0, callsSinceNudge: 0, callsInReply: 0 }
}

/** A new reply starts from the inherited todo list, with no nudges. */
export function resetStopGateState(state: StopGateState, initialTodo: readonly TodoItem[] = [], request = ''): void {
  state.todo = validatedTodo(initialTodo) ?? []
  state.request = request
  state.nudges = 0
  state.callsSinceNudge = 0
  state.callsInReply = 0
}

/** The todo items a reply has not finished. */
export function openItems(todo: readonly TodoItem[]): TodoItem[] {
  return todo.filter((item) => item.status !== 'completed')
}

/** How a settled reply ended when its work is not done; `null` when it is. */
export type StopOutcome =
  | { code: 'needs_person'; reason: string; open: TodoItem[] }
  | { code: 'unfinished'; reason: string; open: TodoItem[] }

/**
 * `goal` is the session's /goal, when it has one: a goal that ended `blocked` needs the person,
 * and one that ended on a limit, a pause or a stall leaves work (ADR-0072).
 */
export function stopOutcome(state: StopGateState, goal?: GoalState | null): StopOutcome | null {
  const open = openItems(state.todo)
  if (goal?.status === 'blocked') return { code: 'needs_person', reason: goal.lastReason || 'The goal is blocked.', open }
  if (goal && (goal.status === 'budget_limited' || goal.status === 'usage_limited' || goal.status === 'paused')) {
    return { code: 'unfinished', reason: goal.lastReason || `The goal is ${goal.status.replace('_', ' ')}.`, open }
  }
  if (open.length) return { code: 'unfinished', reason: '', open }
  return null
}

/** What a checkpoint learns from the reply's todo list and the goal. */
export function handoffFields(state?: StopGateState | null, goal?: GoalState | null): Pick<Checkpoint, 'done' | 'next'> & { blocked?: string } {
  const todo = state?.todo ?? []
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

/** The text the model reads when the todo gate sends its reply back. */
export function nudgeText(count: number, max: number, open: readonly TodoItem[]): string {
  const list = open.slice(0, 12).map((item) => `- ${item.text}`).join('\n')
  const more = open.length > 12 ? `\n- …and ${open.length - 12} more` : ''
  return [
    `Harness stop gate (${count}/${max}): your reply ended with ${open.length} open todo item${open.length === 1 ? '' : 's'}:`,
    `${list}${more}`,
    'Continue with the next open item now. Mark an item completed only after it is done and checked.',
    'The list shows progress; it is not the limit of the work. If the request needs more than the list says, add it and do it.',
    'Decisions inside the request are yours. Stop only for something only the person can do (a deploy, a secret, remote data, money, missing access), and then say exactly what it is.'
  ].join('\n')
}

/** What the gate reports for the run record: each nudge. */
export type StopGateEvent = { kind: 'todo'; count: number; open: TodoItem[] }

/** One line for the run record per stop-gate nudge. */
export function stopGateNotice(event: StopGateEvent): string {
  return `Stop gate ${event.count}: the reply ended with ${event.open.length} open todo item${event.open.length === 1 ? '' : 's'}; continuing.`
}

export interface StopGateOptions {
  state: StopGateState
  /** The todo list a continued run inherits; each new reply starts from it. */
  initialTodo?: readonly TodoItem[]
  /** The person's request when the prompt is not it (a continuation's "Continue from where you stopped."). */
  request?: () => string | null
  /** Whether the gate applies to the current reply; a function follows the terminal's live plan switch. */
  active?: () => boolean
  /** True when the work-slice guard ended this reply: the gate stays silent and the slice hands off. */
  sliceEnded?: () => boolean
  /** True when the reply already failed (a provider error): nothing to continue. */
  failed?: () => boolean
  max?: number
  /** Called for each nudge, for the run record. */
  onEvent?: (event: StopGateEvent) => void
}

export function stopGate(options: StopGateOptions): (pi: ExtensionAPI) => void {
  const { state } = options
  const max = options.max ?? MAX_STOP_GATE_NUDGES
  return (pi) => {
    // Pi emits agent_start again for every continuation, so a reply resets only on a person's message.
    pi.on('before_agent_start', (event) => {
      if (event.messageType !== undefined && event.messageType !== 'user') return
      resetStopGateState(state, options.initialTodo, options.request?.() || (typeof event.prompt === 'string' ? event.prompt : ''))
    })
    pi.on('tool_call', (event) => {
      if (BOOKKEEPING_TOOLS.has(event.toolName)) return
      state.callsSinceNudge += 1
      state.callsInReply += 1
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
      if (state.nudges >= max) return
      // A nudge that produced no work will not be followed by one that does: hand it back.
      if (state.nudges > 0 && state.callsSinceNudge === 0) return

      const open = openItems(state.todo)
      if (!open.length) return
      state.nudges += 1
      state.callsSinceNudge = 0
      options.onEvent?.({ kind: 'todo', count: state.nudges, open })
      return {
        entries: [...event.entries, { type: 'custom_message', customType: STOP_GATE_CUSTOM_TYPE, content: nudgeText(state.nudges, max, open), display: true }],
        continue: true
      }
    })
  }
}

/** The model a goal-claim check asks: the session's own model, at low effort, through Pi's registry. */
export function sessionCheckModel(ctx: unknown): CheckModel | null {
  const session = (ctx ?? {}) as {
    model?: { reasoning?: boolean }
    modelRegistry?: { streamSimple: (model: never, context: never, options?: never) => { result(): Promise<unknown> } }
    sessionManager?: { getSessionId?: () => string }
  }
  const model = session.model
  const registry = session.modelRegistry
  if (!model || !registry) return null
  // Some providers (opencode-go) reject a request without a session id.
  const sessionId = session.sessionManager?.getSessionId?.()
  return async (system, user, signal) => {
    const context = { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] }
    const message = await registry.streamSimple(model as never, context as never, { ...(model.reasoning ? { reasoning: 'low' } : {}), ...(sessionId ? { sessionId } : {}), maxTokens: 4_000, signal } as never).result()
    const failed = (message as { stopReason?: string; errorMessage?: string }).stopReason
    if (failed === 'error' || failed === 'aborted') throw new Error((message as { errorMessage?: string }).errorMessage || `the check request ended: ${failed}`)
    return { text: answerText(message), message }
  }
}
