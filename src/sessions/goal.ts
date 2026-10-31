// /goal (ADR-0072): a person's opt-in, long-running objective. The state machine, the model's two
// goal tools, the brakes and the status text are adapted from OpenAI Codex (Apache-2.0; see
// NOTICE.md): codex-rs/ext/goal/src/{spec,tool,accounting,runtime,api}.rs and
// codex-rs/tui/src/goal_display.rs.
//
// Differences from upstream: the harness caps a goal by rounds and hours (Codex caps by tokens);
// `update_goal(complete)` is held as a claim that the harness checks against the objective before
// the goal is complete (goalLoop.ts); the model cannot create a goal (the person does, with /goal).
import { randomUUID } from 'node:crypto'

import type { ToolSpec } from '../tools/types'
import { BUDGET_LIMIT_TEMPLATE, CONTINUATION_TEMPLATE, OBJECTIVE_UPDATED_TEMPLATE, renderGoalPrompt } from './goalPrompts'

export const GET_GOAL = 'get_goal'
export const UPDATE_GOAL = 'update_goal'
export const GOAL_TOOLS = [GET_GOAL, UPDATE_GOAL] as const

export const GOAL_CUSTOM_TYPE = 'xingular-goal'
export const GOAL_STATE_ENTRY = 'xingular-goal-state'

/** Codex limits a goal objective to this many characters. */
export const MAX_GOAL_OBJECTIVE = 4_000
export const DEFAULT_GOAL_ROUNDS = 30
export const DEFAULT_GOAL_HOURS = 8
/** Consecutive automatic rounds without activity, or with only failed commands, before a goal is blocked. */
export const GOAL_STRIKES = 3

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'

export interface GoalLimits {
  rounds: number
  hours: number
}

export interface GoalState {
  /** Changes when a goal is replaced, kept when its objective is edited. */
  goalId: string
  objective: string
  status: GoalStatus
  limits: GoalLimits
  /** Automatic continuations started so far. */
  rounds: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  /** The model called update_goal(complete) and the harness has not checked the claim yet. */
  claimed: boolean
  /** The latest verdict on a completion claim, while it matters. */
  lastReason: string
}

/** Thrown for a call the model may not make; the message goes back to the model as the tool result. */
export class GoalError extends Error {}

export const withLimits = (limits?: Partial<GoalLimits>): GoalLimits => ({
  rounds: Number.isInteger(limits?.rounds) && (limits!.rounds as number) > 0 ? (limits!.rounds as number) : DEFAULT_GOAL_ROUNDS,
  hours: typeof limits?.hours === 'number' && limits.hours > 0 ? limits.hours : DEFAULT_GOAL_HOURS
})

/** `59s`, `1m`, `1h 30m`, `2d 23h 42m`: Codex's elapsed-time format. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h ${minutes % 60}m`
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** What the model reads as a goal's numbers. */
function budgetValues(goal: GoalState): Record<string, string> {
  return {
    objective: escapeXml(goal.objective),
    rounds_used: String(goal.rounds),
    max_rounds: String(goal.limits.rounds),
    time_used: formatElapsed(goal.timeUsedSeconds),
    max_time: formatElapsed(goal.limits.hours * 3600)
  }
}

export const continuationPrompt = (goal: GoalState): string => renderGoalPrompt(CONTINUATION_TEMPLATE, budgetValues(goal))
export const budgetLimitPrompt = (goal: GoalState): string => renderGoalPrompt(BUDGET_LIMIT_TEMPLATE, budgetValues(goal))
export const objectiveUpdatedPrompt = (goal: GoalState): string => renderGoalPrompt(OBJECTIVE_UPDATED_TEMPLATE, budgetValues(goal))

/** The goal as the model's tools report it. */
export function goalReport(goal: GoalState | null): Record<string, unknown> {
  if (!goal) return { goal: null }
  return {
    goal: {
      objective: goal.objective,
      status: goal.status,
      rounds: goal.rounds,
      maxRounds: goal.limits.rounds,
      timeUsedSeconds: goal.timeUsedSeconds,
      maxHours: goal.limits.hours,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt
    }
  }
}

/** The text a goal-aware session shows after it ends in `complete`. */
export const completionReport = (goal: GoalState): string =>
  `Goal achieved. Report the final usage to the user: ${goal.rounds} of ${goal.limits.rounds} rounds and ${formatElapsed(goal.timeUsedSeconds)} of ${formatElapsed(goal.limits.hours * 3600)}.`

/** What one finished round did, as the loop saw it. */
export interface RoundOutcome {
  /** The round produced text, reasoning, or a tool call. */
  activity: boolean
  /** A command failed and no tool succeeded in the round. */
  failedCommands: boolean
  /** The round ended with a provider error (not a usage limit). */
  error?: boolean
  /** The round ended with a usage-limit error. */
  usageLimit?: boolean
}

export interface GoalControllerOptions {
  now?: () => number
  /** Called after every change with the new state (null once cleared), to persist and show it. */
  onChange?: (state: GoalState | null) => void
}

/**
 * One session's goal. All changes go through it, so the status rules live in one place:
 * the model may only claim `complete`, report `blocked` or, on the person's word, `paused`;
 * the person sets, edits, pauses, resumes and clears; the system alone limits.
 */
export class GoalController {
  private state: GoalState | null = null
  private idleStrikes = 0
  private failureStrikes = 0
  private startedAt: number | null = null
  private readonly now: () => number
  private readonly listeners = new Set<(state: GoalState | null) => void>()

  constructor(private readonly options: GoalControllerOptions = {}) {
    this.now = options.now ?? Date.now
  }

  get(): GoalState | null {
    return this.state
  }

  active(): boolean {
    return this.state?.status === 'active'
  }

  /** Restores a persisted goal; the in-memory strike counters start fresh. */
  restore(state: GoalState | null): void {
    this.state = state ? { ...state } : null
    this.idleStrikes = 0
    this.failureStrikes = 0
    this.startedAt = null
    this.changed(false)
  }

  /** Hears every change (a persisted copy, the footer, the model's tools). Returns the way to stop. */
  subscribe(listener: (state: GoalState | null) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(notify = true): void {
    if (!notify) return
    const copy = this.state ? { ...this.state } : null
    this.options.onChange?.(copy)
    for (const listener of [...this.listeners]) listener(copy)
  }

  private touch(patch: Partial<GoalState>): GoalState {
    this.state = { ...this.state!, ...patch, updatedAt: this.now() }
    this.changed()
    return this.state
  }

  /** The person sets a goal. Replaces a finished one; the caller confirms replacing an unfinished one. */
  set(objective: string, limits?: Partial<GoalLimits>): GoalState {
    const text = objective.trim()
    if (!text) throw new GoalError('goal objective must not be empty')
    if (text.length > MAX_GOAL_OBJECTIVE) throw new GoalError(`goal objective must be at most ${MAX_GOAL_OBJECTIVE} characters`)
    const now = this.now()
    this.state = { goalId: randomUUID(), objective: text, status: 'active', limits: withLimits(limits), rounds: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now, claimed: false, lastReason: '' }
    this.idleStrikes = 0
    this.failureStrikes = 0
    this.startedAt = null
    this.changed()
    return this.state
  }

  /** The person edits the objective: the same goal, its usage kept. A finished goal becomes active again. */
  edit(objective: string): GoalState {
    if (!this.state) throw new GoalError('cannot update goal because this thread has no goal')
    const text = objective.trim()
    if (!text) throw new GoalError('goal objective must not be empty')
    if (text.length > MAX_GOAL_OBJECTIVE) throw new GoalError(`goal objective must be at most ${MAX_GOAL_OBJECTIVE} characters`)
    return this.touch({ objective: text, status: 'active', claimed: false, lastReason: '' })
  }

  pause(): GoalState | null {
    if (!this.state || this.state.status === 'complete' || this.state.status === 'budget_limited') return this.state
    this.endRound()
    return this.touch({ status: 'paused', claimed: false })
  }

  resume(): GoalState {
    if (!this.state) throw new GoalError('cannot update goal because this thread has no goal')
    this.idleStrikes = 0
    this.failureStrikes = 0
    if (this.state.status === 'complete') return this.state
    return this.touch({ status: 'active', claimed: false })
  }

  clear(): boolean {
    const had = this.state !== null
    this.state = null
    this.startedAt = null
    this.changed()
    return had
  }

  /** A round (a turn charged to the goal) begins. */
  beginRound(): void {
    if (this.state?.status === 'active' && this.startedAt === null) this.startedAt = this.now()
  }

  /** Charges the round's wall time to the goal. Called at every stop, so an idle gap is not billed. */
  endRound(): void {
    if (this.startedAt === null || !this.state) return
    const seconds = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000))
    this.startedAt = null
    if (seconds > 0) this.state = { ...this.state, timeUsedSeconds: this.state.timeUsedSeconds + seconds, updatedAt: this.now() }
  }

  /** The model's `update_goal`. Returns the tool result. */
  update(status: string): { text: string; goal: GoalState } {
    if (!this.state) throw new GoalError('cannot update goal because this thread has no goal')
    if (status === 'active' || status === 'budget_limited' || status === 'usage_limited') {
      throw new GoalError("update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request; resume, budget-limited, and usage-limited status changes are controlled by the user or system")
    }
    if (status !== 'complete' && status !== 'blocked' && status !== 'paused') {
      throw new GoalError('status must be one of complete, blocked or paused')
    }
    this.endRound()
    if (status === 'paused') {
      // Budget limits take precedence over pausing.
      if (this.state.status === 'budget_limited') return { text: JSON.stringify(goalReport(this.state)), goal: this.state }
      const goal = this.touch({ status: 'paused', claimed: false })
      return { text: JSON.stringify(goalReport(goal)), goal }
    }
    if (status === 'blocked') {
      if (this.state.status === 'budget_limited') return { text: JSON.stringify(goalReport(this.state)), goal: this.state }
      const goal = this.touch({ status: 'blocked', claimed: false })
      return { text: JSON.stringify(goalReport(goal)), goal }
    }
    // complete: a claim, checked by the loop before the goal is complete.
    const goal = this.touch({ claimed: true })
    return {
      text: JSON.stringify({
        ...goalReport(goal),
        claim: 'recorded',
        note: 'The harness now checks this claim against the objective. If it finds the objective unmet you continue; otherwise the goal is complete. Write a short report of what was done and verified.'
      }),
      goal
    }
  }

  /** The claim was checked and holds. */
  accept(reason = ''): GoalState {
    return this.touch({ status: 'complete', claimed: false, lastReason: reason })
  }

  /** The claim was checked and does not hold: the goal stays active with the reason. */
  reject(reason: string): GoalState {
    return this.touch({ status: 'active', claimed: false, lastReason: reason })
  }

  /** The system limits the goal. */
  limit(status: 'budget_limited' | 'usage_limited' | 'blocked', reason = ''): GoalState {
    this.endRound()
    return this.touch({ status, claimed: false, lastReason: reason })
  }

  /** Counts one automatic round; returns the status the system moved the goal to, if any. */
  settleRound(outcome: RoundOutcome): GoalStatus | null {
    if (!this.state || this.state.status !== 'active') return null
    this.endRound()
    if (outcome.usageLimit) return this.limit('usage_limited', 'The provider reported a usage limit.').status
    if (outcome.error) return this.limit('blocked', 'A round ended with an error.').status
    this.idleStrikes = outcome.activity ? 0 : this.idleStrikes + 1
    this.failureStrikes = outcome.failedCommands ? this.failureStrikes + 1 : 0
    if (this.idleStrikes >= GOAL_STRIKES) return this.limit('blocked', `${GOAL_STRIKES} automatic rounds in a row produced no activity.`).status
    if (this.failureStrikes >= GOAL_STRIKES) return this.limit('blocked', `${GOAL_STRIKES} rounds in a row only had failed commands.`).status
    return null
  }

  /** True once the goal has used its rounds or hours. */
  overLimit(): boolean {
    const goal = this.state
    if (!goal) return false
    return goal.rounds >= goal.limits.rounds || goal.timeUsedSeconds >= goal.limits.hours * 3600
  }

  /** Starts the next automatic round. */
  nextRound(): GoalState {
    return this.touch({ rounds: this.state!.rounds + 1 })
  }
}

// ----------------------------------------------------------------------------------------------
// The model's tools (adapted verbatim from codex-rs/ext/goal/src/spec.rs).

export function goalTools(goal: () => GoalController | null): ToolSpec[] {
  return [
    {
      name: GET_GOAL,
      label: 'Get the goal',
      description: 'Get the current goal for this thread, including status, budgets, rounds and elapsed-time usage.',
      readOnly: true,
      planModeSafe: () => true,
      parameters: (Type) => Type.Object({}),
      execute: async () => JSON.stringify(goalReport(goal()?.get() ?? null))
    },
    {
      name: UPDATE_GOAL,
      label: 'Update the goal',
      description: [
        'Update the existing goal.',
        "Set status to `paused` only at the user's explicit request to pause this goal, never on your own initiative. Ask if unclear; a later resume revokes that request. Report the returned status and stop goal work. Budget limits take precedence over pausing.",
        'Set status to `complete` only when the objective has actually been achieved and no required work remains.',
        'Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.',
        'If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again.',
        'Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`.',
        'Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.',
        'Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.',
        'You cannot use this tool to resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.',
        'When marking a goal achieved with status `complete`, report the final usage from the tool result to the user.'
      ].join('\n'),
      parameters: (Type) => Type.Object({
        status: Type.Union([Type.Literal('complete'), Type.Literal('blocked'), Type.Literal('paused')], {
          description: 'Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.'
        })
      }),
      execute: async (input) => {
        const controller = goal()
        try {
          if (!controller) throw new GoalError('cannot update goal because this thread has no goal')
          return controller.update(typeof input.status === 'string' ? input.status : '').text
        } catch (error) {
          if (error instanceof GoalError) return error.message
          throw error
        }
      }
    }
  ]
}

// ----------------------------------------------------------------------------------------------
// The person's side: `/goal` and its status text.

export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'set'; objective: string; limits: Partial<GoalLimits> }
  | { kind: 'edit'; objective: string | null }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'error'; message: string }

export const GOAL_USAGE = 'Usage: /goal [<objective>|edit|pause|resume|clear]'

/**
 * Parses the argument of `/goal`. Subcommands match only as the whole text, so "pause now" is
 * an objective. `--rounds N` and `--hours H` before the objective set this goal's caps.
 */
export function parseGoalCommand(argument: string): GoalCommand {
  const text = argument.trim()
  if (!text) return { kind: 'show' }
  const word = text.toLowerCase()
  if (word === 'clear' || word === 'stop' || word === 'off') return { kind: 'clear' }
  if (word === 'pause') return { kind: 'pause' }
  if (word === 'resume') return { kind: 'resume' }
  if (word === 'edit') return { kind: 'edit', objective: null }
  const limits: Partial<GoalLimits> = {}
  let rest = text
  for (;;) {
    const match = /^--(rounds|hours)(?:=|\s+)(\S+)\s*/.exec(rest)
    if (!match) break
    const value = Number(match[2])
    if (!(value > 0)) return { kind: 'error', message: `--${match[1]} needs a positive number. ${GOAL_USAGE}` }
    if (match[1] === 'rounds') limits.rounds = Math.floor(value)
    else limits.hours = value
    rest = rest.slice(match[0].length)
  }
  if (!rest.trim()) return { kind: 'error', message: GOAL_USAGE }
  if (rest.length > MAX_GOAL_OBJECTIVE) return { kind: 'error', message: `The goal is ${rest.length} characters; the limit is ${MAX_GOAL_OBJECTIVE}. Put the details in a file and point the goal to it.` }
  return { kind: 'set', objective: rest, limits }
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'active',
  paused: 'paused',
  blocked: 'stalled',
  usage_limited: 'usage limited',
  budget_limited: 'limited by budget',
  complete: 'complete'
}

/** The text of a bare `/goal`. */
export function goalSummary(goal: GoalState | null): string {
  if (!goal) return 'No goal is currently set.\nExample: /goal improve benchmark coverage'
  const commands = goal.status === 'active'
    ? '/goal edit, /goal pause, /goal clear'
    : goal.status === 'budget_limited' || goal.status === 'complete'
      ? '/goal edit, /goal clear'
      : '/goal edit, /goal resume, /goal clear'
  return [
    'Goal',
    `Status: ${STATUS_LABEL[goal.status]}`,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.rounds} of ${goal.limits.rounds}`,
    `Time used: ${formatElapsed(goal.timeUsedSeconds)} of ${formatElapsed(goal.limits.hours * 3600)}`,
    ...(goal.lastReason ? [`Last check: ${goal.lastReason}`] : []),
    '',
    `Commands: ${commands}`
  ].join('\n')
}

/** The footer label (Codex's wording, with rounds in place of tokens). */
export function goalFooter(goal: GoalState | null): string | null {
  if (!goal) return null
  switch (goal.status) {
    case 'active': return `Pursuing goal (${formatElapsed(goal.timeUsedSeconds)}, round ${goal.rounds}/${goal.limits.rounds})`
    case 'paused': return 'Goal paused (/goal resume)'
    case 'blocked': return 'Goal stalled (/goal resume)'
    case 'usage_limited': return 'Goal hit usage limits (/goal resume)'
    case 'budget_limited': return `Goal unmet (${goal.rounds}/${goal.limits.rounds} rounds, ${formatElapsed(goal.timeUsedSeconds)})`
    case 'complete': return `Goal achieved (${formatElapsed(goal.timeUsedSeconds)})`
  }
}

/** The hidden message that records who changed the goal, so a pause can be checked as the person's. */
export function provenanceText(action: 'set' | 'paused' | 'cleared' | 'resumed' | 'edited', goal: GoalState | null): string {
  if (action === 'cleared') return 'User cleared the goal.'
  if (action === 'paused') return 'User set goal status: "paused".'
  if (action === 'resumed') return 'User set goal status: "active".'
  const objective = JSON.stringify(goal?.objective ?? '')
  // A long objective is omitted whole, so truncation cannot turn a restriction into a grant.
  if (objective.length > 700) return `User ${action === 'edited' ? 'edited' : 'set'} the goal: [objective omitted; exceeds the evidence limit].`
  return `User ${action === 'edited' ? 'edited' : 'set'} the goal: ${objective}`
}
