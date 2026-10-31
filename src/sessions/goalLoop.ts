// The /goal loop (ADR-0072): while a goal is active, the reply that would end is continued in place
// with Codex's continuation prompt, up to the goal's caps. Adapted from OpenAI Codex (Apache-2.0;
// see NOTICE.md): codex-rs/ext/goal/src/{runtime,extension,accounting}.rs. One Pi extension serves
// the terminal and server runs.
//
//   - A round is one reply that ended while the goal was active; the loop counts it, applies the
//     brakes (no activity, only failed commands, a provider error, a usage limit) and starts the next.
//   - `update_goal(complete)` is a claim: the same model, at low effort and with a fresh context,
//     checks it against the objective (completionCheck.ts) before the goal is complete.
//   - The loop never stops a goal for "no tool call in a round" alone: Codex removed that rule
//     because it made the model shortcut work. Only the strike rules and the caps stop it.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { runCompletionCheck, type CheckModel, type CheckVerdict } from './completionCheck'
import {
  GOAL_CUSTOM_TYPE,
  budgetLimitPrompt,
  continuationPrompt,
  type GoalController,
  type GoalState,
  type GoalStatus
} from './goal'

export const GOAL_EXTENSION = 'goal'

/** What the loop reports for the run record. */
export type GoalEvent =
  | { kind: 'round'; goal: GoalState }
  | { kind: 'claim'; goal: GoalState; verdict: CheckVerdict | null; error?: string }
  | { kind: 'stopped'; goal: GoalState; status: GoalStatus }

export interface GoalLoopOptions {
  controller: GoalController
  /** The model that checks a completion claim (from Pi's ctx); absent or null, a claim is accepted. */
  check?: ((ctx: unknown) => CheckModel | null) | null
  /** Whether the loop applies to the current reply; a function follows the terminal's live plan switch. */
  active?: () => boolean
  /** True when the work-slice guard ended this reply: the slice hands off and the loop waits. */
  sliceEnded?: () => boolean
  /** True when the reply already failed (a provider error). */
  failed?: () => boolean
  /** True when the provider reported a usage limit. */
  usageLimited?: () => boolean
  /** Counts a check's model request with the run's usage. */
  recordUsage?: (message: unknown) => void
  onEvent?: (event: GoalEvent) => void
}

const COMMAND_TOOLS = new Set(['bash', 'powershell'])

export function goalLoop(options: GoalLoopOptions): (pi: ExtensionAPI) => void {
  const { controller } = options
  return (pi) => {
    let activity = false
    let failedCommand = false
    let succeededTool = false
    const resetRound = () => {
      activity = false
      failedCommand = false
      succeededTool = false
    }
    const append = (event: { entries: unknown[] }, content: string, display = false) =>
      [...event.entries, { type: 'custom_message', customType: GOAL_CUSTOM_TYPE, content, display }] as never

    // Pi starts the agent loop again for every continuation, so each round begins here.
    pi.on('agent_start', () => {
      resetRound()
      controller.beginRound()
    })
    pi.on('tool_call', () => {
      activity = true
    })
    pi.on('tool_result', (event) => {
      if (event.isError) {
        if (COMMAND_TOOLS.has(event.toolName)) failedCommand = true
      } else {
        succeededTool = true
      }
    })
    pi.on('message_end', (event) => {
      const message = event.message as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) return
      for (const part of message.content as { type?: string; text?: string; thinking?: string }[]) {
        if ((part?.type === 'text' && part.text?.trim()) || (part?.type === 'thinking' && part.thinking?.trim())) activity = true
      }
    })

    pi.on('agent_before_settle', async (event, ctx) => {
      const goal = controller.get()
      if (!goal || goal.status !== 'active') {
        controller.endRound()
        return
      }
      if (event.outcome !== 'completed' || event.continue || ctx?.signal?.aborted) {
        controller.endRound()
        return
      }
      if (options.active && !options.active()) return
      if (options.sliceEnded?.()) return
      // A message the person queued is the next turn; the goal continues after it.
      if (event.context?.pendingMessages?.length) return
      if (options.failed?.()) {
        controller.settleRound({ activity, failedCommands: false, error: true })
        options.onEvent?.({ kind: 'stopped', goal: controller.get()!, status: controller.get()!.status })
        return
      }
      if (options.usageLimited?.()) {
        controller.settleRound({ activity, failedCommands: false, usageLimit: true })
        options.onEvent?.({ kind: 'stopped', goal: controller.get()!, status: controller.get()!.status })
        return
      }

      let reason = ''
      if (goal.claimed) {
        const ask = options.check?.(ctx) ?? null
        let verdict: CheckVerdict | null = null
        let error: string | undefined
        if (ask) {
          const result = await runCompletionCheck(ask, { objective: goal.objective, messages: event.context?.llmMessages ?? [] }, { signal: ctx?.signal })
          if (result.answer?.message) options.recordUsage?.(result.answer.message)
          verdict = result.verdict
          error = result.error
          if (ctx?.signal?.aborted) {
            controller.endRound()
            return
          }
        }
        // No model, an error or an unreadable answer: the claim stands, as the person's goal asked for.
        if (!verdict || verdict.verdict === 'done') {
          const done = controller.accept(verdict?.reason ?? '')
          options.onEvent?.({ kind: 'claim', goal: done, verdict, ...(error ? { error } : {}) })
          options.onEvent?.({ kind: 'stopped', goal: done, status: 'complete' })
          return
        }
        reason = [verdict.reason ? `Why: ${verdict.reason}` : '', verdict.next ? `Next: ${verdict.next}` : ''].filter(Boolean).join('\n')
        const rejected = controller.reject(verdict.reason)
        options.onEvent?.({ kind: 'claim', goal: rejected, verdict })
      }

      const stopped = controller.settleRound({ activity: goal.claimed ? true : activity, failedCommands: failedCommand && !succeededTool })
      if (stopped) {
        options.onEvent?.({ kind: 'stopped', goal: controller.get()!, status: stopped })
        return
      }
      if (controller.overLimit()) {
        const limited = controller.limit('budget_limited', `The goal reached its limit of ${controller.get()!.limits.rounds} rounds or ${controller.get()!.limits.hours} hours.`)
        options.onEvent?.({ kind: 'stopped', goal: limited, status: 'budget_limited' })
        // One last round so the model can wrap up: progress, what remains, the next step.
        return { entries: append(event, budgetLimitPrompt(limited)), continue: true }
      }
      const next = controller.nextRound()
      options.onEvent?.({ kind: 'round', goal: next })
      const prefix = reason ? `The completion claim was checked and the objective is not met yet.\n${reason}\n\n` : ''
      return { entries: append(event, `${prefix}${continuationPrompt(next)}`), continue: true }
    })
  }
}


/** One line for the run record per round, claim check or stop. */
export function goalNotice(event: GoalEvent): string {
  switch (event.kind) {
    case 'round': return `Goal round ${event.goal.rounds} of ${event.goal.limits.rounds} starts.`
    case 'claim':
      if (!event.verdict) return `Goal claim check: no verdict (${event.error ?? 'no check model'}); the claim stands.`
      return `Goal claim check: ${event.verdict.verdict === 'done' ? 'the objective is met' : 'not met yet'} — ${event.verdict.reason}`.slice(0, 600)
    case 'stopped': return `Goal ${event.status.replace('_', ' ')}${event.goal.lastReason ? `: ${event.goal.lastReason}` : ''}`.slice(0, 600)
  }
}
