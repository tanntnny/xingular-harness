// A reply's work slice (PROP-0041): a bounded amount of work, then a handoff checkpoint, then a
// continuation. The guard here refuses the call that would run past the budget, once with a
// request for the checkpoint, and ends the reply if the model keeps calling tools. It also names
// repeated work before it becomes a loop. All decisions are deterministic; no model is consulted.
import { createHash } from 'node:crypto'

import type { Checkpoint } from './contracts'
import { findRun } from './runStore'

export const WORK_SLICE_EXTENSION = 'work-slice'

export interface WorkSliceInput {
  /** False turns the guard off for this run: no budget, no stall notes, no continuation. */
  enabled?: boolean
  /** Tool calls in one reply; 0 disables this limit. */
  maxToolCalls?: number
  /** Minutes in one reply; 0 disables this limit. */
  maxMinutes?: number
  /** New tokens in one reply (input + cache read + output); 0 disables this limit. */
  maxNewTokens?: number
  /** Slices one task may use before it is handed back to the person; 0 disables the cap. */
  maxSlices?: number
  /** Start the next slice from the checkpoint without asking. */
  continue?: boolean
}

export interface SlicePolicy {
  enabled: boolean
  maxToolCalls: number
  maxMinutes: number
  maxNewTokens: number
  maxSlices: number
  continue: boolean
}

/** The foundation defaults: enough for one meaningful step of work, short enough to report. */
export const DEFAULT_SLICE_POLICY: SlicePolicy = {
  enabled: true,
  // Roughly 40 minutes of ordinary work (about 15 s a call), so a checkpoint is a chapter of a
  // task, not an interruption every few edits. A task still gets eight of them before the cap.
  maxToolCalls: 160,
  maxMinutes: 40,
  // A generous cost ceiling, counted on new input, cache writes and output only: heavy reading at
  // a large context can add tens of thousands of tokens a request, so a small cap stopped useful
  // work (see the "Confirm plan model support" thread). 320k is a safety net, not the bound.
  maxNewTokens: 320_000,
  maxSlices: 8,
  continue: true
}

const LIMITS: Record<Exclude<keyof SlicePolicy, 'enabled' | 'continue'>, { min: number; max: number }> = {
  maxToolCalls: { min: 1, max: 2_000 },
  maxMinutes: { min: 1, max: 480 },
  maxNewTokens: { min: 1_000, max: 5_000_000 },
  maxSlices: { min: 1, max: 100 }
}

export class WorkSliceError extends Error {}

/**
 * The policy a run asked for, or the defaults. `XINGULAR_WORK_SLICE=off` at launch turns the guard
 * off for every run in this process; nothing is persisted, so restarting without it restores the
 * defaults.
 */
export function parseWorkSlice(input: unknown): SlicePolicy {
  if (input === undefined || input === null) {
    const launch = process.env.XINGULAR_WORK_SLICE?.trim().toLowerCase()
    return { ...DEFAULT_SLICE_POLICY, ...(launch === 'off' || launch === '0' || launch === 'false' ? { enabled: false } : {}) }
  }
  if (typeof input !== 'object' || Array.isArray(input)) throw new WorkSliceError('workSlice must be an object.')
  const record = input as Record<string, unknown>
  const policy: SlicePolicy = { ...DEFAULT_SLICE_POLICY }
  for (const key of Object.keys(record)) {
    if (key === 'enabled') {
      if (typeof record.enabled !== 'boolean') throw new WorkSliceError('workSlice.enabled must be true or false.')
      policy.enabled = record.enabled
      continue
    }
    if (key === 'continue') {
      if (typeof record.continue !== 'boolean') throw new WorkSliceError('workSlice.continue must be true or false.')
      policy.continue = record.continue
      continue
    }
    const limits = LIMITS[key as keyof typeof LIMITS]
    if (!limits) throw new WorkSliceError(`workSlice has no field ${key}.`)
    const value = record[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new WorkSliceError(`workSlice.${key} must be a whole number.`)
    // 0 switches one limit off, as the settings page says.
    if (value === 0) {
      policy[key as keyof typeof LIMITS] = 0
      continue
    }
    if (value < limits.min || value > limits.max) throw new WorkSliceError(`workSlice.${key} must be between ${limits.min} and ${limits.max}, or 0 for no limit.`)
    policy[key as keyof typeof LIMITS] = value
  }
  return policy
}

export type SliceEnd = 'budget' | 'stuck' | 'compaction-thrash'

/** What a live reply tracks for its slice; the runner reads it after the reply. */
export interface SliceState {
  slice: number
  steps: number
  tokens: number
  startedAt: number
  lastTool: string | null
  compactions: number
  checkpointWritten: boolean
  /** Set when the guard ended the reply instead of the model finishing it. */
  endedBy: SliceEnd | null
  /** The limit that ended it, for the record. */
  endedByLimit: string | null
  /** Steps past which every non-exempt tool call is refused, once one was refused. */
  refusedAt: number | null
}

export function createSliceState(_policy: SlicePolicy, slice = 1, now = Date.now()): SliceState {
  return { slice, steps: 0, tokens: 0, startedAt: now, lastTool: null, compactions: 0, checkpointWritten: false, endedBy: null, endedByLimit: null, refusedAt: null }
}

/** Counters start again for each reply; a terminal session keeps one guard across replies. */
export function resetSliceState(state: SliceState, now = Date.now()): void {
  state.steps = 0
  state.tokens = 0
  state.startedAt = now
  state.lastTool = null
  state.compactions = 0
  state.checkpointWritten = false
  state.endedBy = null
  state.endedByLimit = null
  state.refusedAt = null
}

/** The first limit this reply has passed, named as a person would say it. */
export function sliceLimitReached(policy: SlicePolicy, state: SliceState, now = Date.now()): string | null {
  if (policy.maxToolCalls > 0 && state.steps >= policy.maxToolCalls) return `${policy.maxToolCalls} tool calls`
  if (policy.maxMinutes > 0 && now - state.startedAt >= policy.maxMinutes * 60_000) return `${policy.maxMinutes} minutes`
  if (policy.maxNewTokens > 0 && state.tokens >= policy.maxNewTokens) return `${Math.round(policy.maxNewTokens / 1000)}k new tokens`
  return null
}

/** Tools a reply may still call while it writes its handoff. A plan update waits for the next slice. */
const HANDOFF_TOOLS = new Set(['checkpoint_write', 'session_name'])
/** Tools whose repetition is how waiting works, not a loop. */
const POLLING_TOOLS = new Set(['wait_subagents', 'subagents.list', 'subagents.status'])

/** Commands that read as a check, for "no progress" and "still failing" rules. */
export function looksLikeCheck(command: string): boolean {
  return /\b(test|tests|typecheck|tsc|vitest|jest|cargo|check:|prove|lint|ci|build)\b/u.test(command)
}

/**
 * A stable rendering of a value: object keys sorted, so argument order never changes the result.
 * Depth is bounded so a cyclic or absurdly nested input cannot recurse forever.
 */
function canonical(value: unknown, depth = 0): string {
  if (depth > 8) return '…'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`
}

/**
 * A call's identity: its name and every argument, hashed so the key stays small even when an
 * argument is a whole file. A changed argument is a different call; only an identical one repeats.
 * Reading a fixed handful of fields made every `checklist_write` look identical, so a reply that
 * reported its progress was told it was repeating work.
 */
const signature = (name: string, input: unknown): string =>
  `${name}\u0000${createHash('sha256').update(canonical(input ?? null)).digest('hex')}`

const clip = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`)

function handoffRequest(limit: string, state: SliceState): string {
  return clip(
    `This reply reached its work-slice limit (${limit}; step ${state.steps}). Call checkpoint_write now with what is done, the single next step, anything blocking, the files you touched and the checks that matter. Then tell the user in a few lines where you stopped. Do not call other tools.`,
    600
  )
}

function stalledNote(reason: string): string {
  return clip(
    `You are repeating work: ${reason}. Do not repeat it. Choose a different approach, read what the earlier attempt returned, or call checkpoint_write with the blocker so the next slice can decide.`,
    600
  )
}

interface ToolCall {
  toolName: string
  input?: unknown
}
interface ToolResult {
  toolName: string
  isError?: boolean
  input?: unknown
}

/** The part of Pi's extension API this guard uses. Structural, so the module needs no Pi import. */
interface GuardApi {
  on(event: 'agent_start', handler: () => unknown): void
  on(event: 'tool_call', handler: (event: ToolCall) => unknown): void
  on(event: 'tool_result', handler: (event: ToolResult) => unknown): void
  on(event: 'message_end', handler: (event: { message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }) => unknown): void
}

export interface WorkSliceGuardOptions {
  policy: SlicePolicy
  state: SliceState
  /** Called once the guard has decided the reply must stop; the runner ends it. */
  onEnd?: (end: SliceEnd, limit: string) => void
}

/**
 * Bounds one reply and names repeated work. The first refusal asks for a checkpoint; a tool call
 * after that refusal ends the reply. A repeated call or failing command is named once, then ends it.
 */
export function workSliceGuard(options: WorkSliceGuardOptions): (pi: GuardApi) => void {
  const { policy, state } = options
  const calls = new Map<string, number>()
  const edits = new Map<string, number>()
  const failures = new Map<string, number>()
  let stepsSinceProgress = 0
  let nudged = false

  /** Repetition is judged inside one reply; the next reply starts from a clean count. */
  const resetRepetition = (): void => {
    calls.clear()
    edits.clear()
    failures.clear()
    stepsSinceProgress = 0
    nudged = false
  }

  const end = (kind: SliceEnd, limit: string): { block: true; terminate: true; reason: string } => {
    state.endedBy = kind
    state.endedByLimit = limit
    options.onEnd?.(kind, limit)
    const reason = kind === 'stuck'
      ? stalledNote(limit)
      : kind === 'compaction-thrash'
        ? handoffRequest('three context compactions in one reply', state)
        : handoffRequest(limit, state)
    return { block: true, terminate: true, reason }
  }

  const repeated = (name: string, input: unknown): string | null => {
    if (POLLING_TOOLS.has(name)) return null
    const key = signature(name, input)
    const count = (calls.get(key) ?? 0) + 1
    calls.set(key, count)
    if (count < 3) return null
    return name === 'bash' ? `the same Bash command ${count} times (steps ending at ${state.steps})` : `the same ${name} call ${count} times (steps ending at ${state.steps})`
  }

  const failing = (name: string, input: unknown): string | null => {
    if (name !== 'bash') return null
    const command = input && typeof input === 'object' ? String((input as { command?: unknown }).command ?? '') : ''
    if (!command || !looksLikeCheck(command)) return null
    const count = failures.get(command) ?? 0
    return count >= 2 ? `the check ${command} failed ${count} times` : null
  }

  return (pi) => {
    pi.on('agent_start', () => {
      resetSliceState(state)
      resetRepetition()
    })
    pi.on('message_end', (event) => {
      const usage = event.message.usage
      if (event.message.role !== 'assistant' || !usage) return
      // New tokens only: the cached prefix was sent before and is not new context or new cost.
      state.tokens += (usage.input ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0)
    })
    pi.on('tool_result', (event) => {
      if (event.toolName === 'checkpoint_write' && !event.isError) {
        state.checkpointWritten = true
        stepsSinceProgress = 0
        nudged = false
      }
      if (event.toolName !== 'bash') return
      const command = event.input && typeof event.input === 'object' ? String((event.input as { command?: unknown }).command ?? '') : ''
      if (!command || !looksLikeCheck(command)) return
      if (event.isError) {
        failures.set(command, (failures.get(command) ?? 0) + 1)
        return
      }
      // A passing check is progress: the repetition rules start over.
      failures.delete(command)
      edits.clear()
      calls.clear()
      stepsSinceProgress = 0
      nudged = false
    })
    pi.on('tool_call', (event) => {
      const name = event.toolName
      state.steps += 1
      state.lastTool = name
      const handoff = HANDOFF_TOOLS.has(name)
      // A handoff is always callable; after the slice ended it is the only thing that is.
      if (state.endedBy) {
        return handoff ? undefined : { block: true, terminate: true, reason: 'This reply is over. Its checkpoint is recorded; nothing else runs.' }
      }
      if (state.compactions >= 3) {
        if (handoff) {
          state.endedBy = 'compaction-thrash'
          state.endedByLimit = 'three compactions'
          return undefined
        }
        return end('compaction-thrash', 'three compactions')
      }
      const limit = sliceLimitReached(policy, state)
      if (limit) {
        // The slice ends here; the model gets one wrap-up request to write the handoff. A handoff
        // call is never refused, including when it is the very first call past the budget.
        state.endedBy = 'budget'
        state.endedByLimit = limit
        state.refusedAt ??= state.steps
        stepsSinceProgress = 0
        return handoff ? undefined : { block: true, reason: handoffRequest(limit, state) }
      }
      if (handoff) return undefined
      const edit = name === 'edit' || name === 'write'
      const path = edit && event.input && typeof event.input === 'object' ? String((event.input as { path?: unknown }).path ?? '') : ''
      if (edit && path) {
        const count = (edits.get(path) ?? 0) + 1
        edits.set(path, count)
        stepsSinceProgress = 0
        if (count >= 4) {
          const reason = `${path} was edited ${count} times with no passing check between`
          if (nudged) return end('stuck', reason)
          nudged = true
          return { block: true, reason: stalledNote(reason) }
        }
      } else {
        stepsSinceProgress += 1
      }
      const repeat = repeated(name, event.input)
      const failure = failing(name, event.input)
      const noProgress = stepsSinceProgress >= 25 ? `${stepsSinceProgress} steps with no file change and no passing check` : null
      const reason = repeat ?? failure ?? noProgress
      if (!reason) return undefined
      if (nudged) return end('stuck', reason)
      nudged = true
      stepsSinceProgress = 0
      return { block: true, reason: stalledNote(reason) }
    })
  }
}

/**
 * Which slice of its session a run is, from 1. Counts the recorded continuation chain, so it
 * survives a restart and needs no extra field on the run record.
 */
export function sliceOf(root: string, runId: string, limit = 100): number {
  let current: string | null = runId
  let count = 0
  const seen = new Set<string>()
  while (current && count < limit && !seen.has(current)) {
    seen.add(current)
    count += 1
    current = findRun(root, current)?.resumedFromRunId ?? null
  }
  return Math.max(1, count)
}

/** The reason a checkpoint the harness derives (no model handoff) records. */
export function derivedReason(end: SliceEnd | null): Checkpoint['reason'] {
  return end ?? 'requested'
}
