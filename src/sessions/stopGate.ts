// The stop gate (ADR-0069, ADR-0071): a reply may not quietly end while work it can do itself is
// left. Two layers share one cap at Pi's `agent_before_settle` boundary:
//   1. the todo gate — open todo items send the reply back, with no model call;
//   2. the completion check — when a reply that did work ends with its list closed or absent, the
//      same model at low effort judges the person's request against the reply (`completionCheck.ts`).
// The agent doing the work never certifies its own early stop: the reply ends `completed` only when
// nothing is left open and the check (when it runs) says `done`; `needs_person` only when the check
// says the person is needed; otherwise, once the cap or the no-progress rule stops the nudges,
// `unfinished`. The check fails open: any error leaves the reply as it was.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { TODO_WRITE } from '../tools/todo'
import { validatedTodo } from './compactionCheckpoint'
import { answerText, runCompletionCheck, type CheckModel, type CheckVerdict } from './completionCheck'
import { MAX_CHECKPOINT_DONE, type Checkpoint, type TodoItem } from './contracts'

export const STOP_GATE_EXTENSION = 'stop-gate'
export const STOP_GATE_CUSTOM_TYPE = 'xingular-stop-gate'
export const COMPLETION_CHECK_CUSTOM_TYPE = 'xingular-completion-check'
/** Nudges per reply, across both layers, before the reply is handed back to the person. */
export const MAX_STOP_GATE_NUDGES = 3
/** Calls that are bookkeeping, not work: they neither count as progress nor make a reply checkable. */
const BOOKKEEPING_TOOLS = new Set([TODO_WRITE, 'session_name'])

/** What the gate knows about the live reply. */
export interface StopGateState {
  /** The reply's todo list as the model last wrote it (or as a continued run inherited it). */
  todo: TodoItem[]
  /** The person's request this reply answers. */
  request: string
  /** Nudges sent in this reply, by either layer. */
  nudges: number
  /** Work tool calls since the last nudge. */
  callsSinceNudge: number
  /** Work tool calls in this reply. */
  callsInReply: number
  /** Completion checks run in this reply. */
  checks: number
  /** The latest check's verdict, while it stands: `continue` until a later check says `done`. */
  verdict: CheckVerdict | null
  /** Set by the runner (or terminal) so a check's model request is counted with the run's usage. */
  recordUsage?: (message: unknown) => void
}

export function createStopGateState(initialTodo: readonly TodoItem[] = []): StopGateState {
  return { todo: validatedTodo(initialTodo) ?? [], request: '', nudges: 0, callsSinceNudge: 0, callsInReply: 0, checks: 0, verdict: null }
}

/** A new reply starts from the inherited todo list, with no nudges, checks or verdict. */
export function resetStopGateState(state: StopGateState, initialTodo: readonly TodoItem[] = [], request = ''): void {
  state.todo = validatedTodo(initialTodo) ?? []
  state.request = request
  state.nudges = 0
  state.callsSinceNudge = 0
  state.callsInReply = 0
  state.checks = 0
  state.verdict = null
}

/** The todo items a reply has not finished. */
export function openItems(todo: readonly TodoItem[]): TodoItem[] {
  return todo.filter((item) => item.status !== 'completed')
}

/** How a settled reply ended when its work is not done; `null` when it is. */
export type StopOutcome =
  | { code: 'needs_person'; reason: string; open: TodoItem[] }
  | { code: 'unfinished'; reason: string; open: TodoItem[] }

export function stopOutcome(state: StopGateState): StopOutcome | null {
  const open = openItems(state.todo)
  if (open.length) return { code: 'unfinished', reason: '', open }
  if (state.verdict?.verdict === 'needs_person') return { code: 'needs_person', reason: state.verdict.reason, open }
  if (state.verdict?.verdict === 'continue') return { code: 'unfinished', reason: state.verdict.reason, open }
  return null
}

/** What a checkpoint learns from the reply's todo list and the completion check. */
export function handoffFields(state?: StopGateState | null): Pick<Checkpoint, 'done' | 'next'> & { blocked?: string } {
  const todo = state?.todo ?? []
  const next = openItems(todo)[0]?.text || (state?.verdict?.verdict === 'continue' ? state.verdict.next : '')
  const blocked = state?.verdict?.verdict === 'needs_person' ? state.verdict.reason.slice(0, 500) : ''
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
  if (outcome.open.length) return `The reply ended with ${outcome.open.length} open todo item${outcome.open.length === 1 ? '' : 's'}.`
  return `The reply ended with work left: ${outcome.reason}`.slice(0, 1_200)
}

/** The text the model reads when the todo gate sends its reply back. */
export function nudgeText(count: number, max: number, open: readonly TodoItem[]): string {
  const list = open.slice(0, 12).map((item) => `- ${item.text}`).join('\n')
  const more = open.length > 12 ? `\n- …and ${open.length - 12} more` : ''
  return [
    `Harness stop gate (${count}/${max}): your reply ended with ${open.length} open todo item${open.length === 1 ? '' : 's'}:`,
    `${list}${more}`,
    'Continue with the next open item now. Mark an item completed only after it is done and checked.',
    'Decisions inside the request are yours. Stop only for something only the person can do (a deploy, a secret, remote data, money, missing access), and then say exactly what it is.'
  ].join('\n')
}

/** The text the model reads when the completion check sends its reply back. */
export function checkNudgeText(count: number, max: number, verdict: CheckVerdict): string {
  return [
    `Completion check (${count}/${max}): the request is not done yet, and the rest is work you can do yourself.`,
    verdict.reason ? `Why: ${verdict.reason}` : '',
    verdict.next ? `Next: ${verdict.next}` : 'Continue with the next step of the request.',
    'Do not ask the person about decisions inside the request; make them and keep working.'
  ].filter(Boolean).join('\n')
}

/** What the gate reports for the run record: each nudge and each check. */
export type StopGateEvent =
  | { kind: 'todo'; count: number; open: TodoItem[] }
  | { kind: 'check'; count: number; verdict: CheckVerdict | null; error?: string }

/** One line for the run record per stop-gate nudge or completion check. */
export function stopGateNotice(event: StopGateEvent): string {
  if (event.kind === 'todo') return `Stop gate ${event.count}: the reply ended with ${event.open.length} open todo item${event.open.length === 1 ? '' : 's'}; continuing.`
  if (!event.verdict) return `Completion check ${event.count}: no verdict (${event.error ?? 'unreadable answer'}); the reply ends as it was.`
  return `Completion check ${event.count}: ${event.verdict.verdict} — ${event.verdict.reason}`.slice(0, 600)
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
  /** The check's model for this settle (from Pi's ctx); absent, null or switched off, only the todo gate runs. */
  check?: ((ctx: unknown) => CheckModel | null) | null
  max?: number
  /** Called for each nudge and each check, for the run record. */
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
    pi.on('agent_before_settle', async (event, ctx) => {
      if (event.outcome !== 'completed' || event.continue || ctx?.signal?.aborted) return
      if (options.active && !options.active()) return
      if (options.sliceEnded?.() || options.failed?.()) return
      if (state.nudges >= max) return
      // A nudge that produced no work will not be followed by one that does: hand it back.
      if (state.nudges > 0 && state.callsSinceNudge === 0) return

      const open = openItems(state.todo)
      if (open.length) {
        state.nudges += 1
        state.callsSinceNudge = 0
        options.onEvent?.({ kind: 'todo', count: state.nudges, open })
        return {
          entries: [...event.entries, { type: 'custom_message', customType: STOP_GATE_CUSTOM_TYPE, content: nudgeText(state.nudges, max, open), display: true }],
          continue: true
        }
      }

      // The list is closed or absent: a reply that did work asks the check whether the request is done.
      const ask = state.callsInReply > 0 ? options.check?.(ctx) ?? null : null
      if (!ask) return
      state.checks += 1
      const result = await runCompletionCheck(ask, { request: state.request, todo: state.todo, messages: event.context?.llmMessages ?? [] }, { signal: ctx?.signal })
      if (result.answer?.message) state.recordUsage?.(result.answer.message)
      options.onEvent?.({ kind: 'check', count: state.checks, verdict: result.verdict, ...(result.error ? { error: result.error } : {}) })
      if (!result.verdict || ctx?.signal?.aborted) return
      state.verdict = result.verdict
      if (result.verdict.verdict !== 'continue') return
      state.nudges += 1
      state.callsSinceNudge = 0
      return {
        entries: [...event.entries, { type: 'custom_message', customType: COMPLETION_CHECK_CUSTOM_TYPE, content: checkNudgeText(state.nudges, max, result.verdict), display: true }],
        continue: true
      }
    })
  }
}

/** The model the check asks: the session's own model, at low effort, through Pi's registry. */
export function sessionCheckModel(ctx: unknown): CheckModel | null {
  const session = (ctx ?? {}) as {
    model?: { reasoning?: boolean }
    modelRegistry?: { streamSimple: (model: never, context: never, options?: never) => { result(): Promise<unknown> } }
  }
  const model = session.model
  const registry = session.modelRegistry
  if (!model || !registry) return null
  return async (system, user, signal) => {
    const context = { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] }
    const message = await registry.streamSimple(model as never, context as never, { ...(model.reasoning ? { reasoning: 'low' } : {}), maxTokens: 4_000, signal } as never).result()
    const failed = (message as { stopReason?: string; errorMessage?: string }).stopReason
    if (failed === 'error' || failed === 'aborted') throw new Error((message as { errorMessage?: string }).errorMessage || `the check request ended: ${failed}`)
    return { text: answerText(message), message }
  }
}
