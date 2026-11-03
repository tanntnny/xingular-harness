// A reply that produced nothing for too long is not working: the person should be told instead of
// watching a run that never settles. This is the turn-level rule, applied to every harness run
// (`runTurn`) and to the in-process terminal's reply; the run-store sweep (`reconcileStaleRuns`)
// settles a record whose owner stopped reporting, and all use the same reason, `stalled` (INV-RUN-14).
//
// A reply that waits for its subagents is not silent: each child is watched on its own clock and ended
// with the same reason when it goes quiet, so the wait returns and the parent carries on by itself.

/** How often a live reply's progress is checked against the stall windows. */
export const STALL_CHECK_MS = 30_000
/** Silence with no tool running: the model request never came back. */
export const REPLY_STALL_MS = 15 * 60_000
/** One tool may run this long; past it the reply is wedged, not busy. */
export const TOOL_STALL_MS = 30 * 60_000

export interface ReplyProgress {
  now: number
  /** When the reply last produced something other than a heartbeat. */
  progressAt: number
  /** When each tool that started and has not finished began. */
  runningTools: readonly number[]
}

/** Whether a live reply has gone too long without progress and should be ended. The oldest running tool counts. */
export function replyStalled({ now, progressAt, runningTools }: ReplyProgress): boolean {
  if (!Number.isFinite(now)) return false
  return runningTools.length
    ? now - Math.min(...runningTools) >= TOOL_STALL_MS
    : now - progressAt >= REPLY_STALL_MS
}

/** Whether every tool still running only waits for subagents, which are watched by their own runs. */
export function onlyWaitingForChildren(runningToolNames: readonly string[]): boolean {
  return runningToolNames.length > 0 && runningToolNames.every((name) => CHILD_WAIT_TOOLS.has(name))
}

/** The tools that block a reply until its children settle. */
export const CHILD_WAIT_TOOLS: ReadonlySet<string> = new Set(['wait_subagents', 'spawn_subagent'])
/** How long a child may stay unsettled after it was told to stop before its parent's own watch resumes. */
export const CHILD_STOP_GRACE_MS = 5 * 60_000

/** One subagent the terminal reply is waiting on. */
export interface ChildProgress {
  progressAt: number
  runningTools: readonly number[]
  /** When the stall watch ended this child, if it did. */
  stopRequestedAt: number | null
}

/** Whether a child has gone quiet for the same windows as a reply, and was not yet told to stop. */
export function childStalled(now: number, child: ChildProgress): boolean {
  return child.stopRequestedAt === null && replyStalled({ now, progressAt: child.progressAt, runningTools: child.runningTools })
}

/**
 * Whether the parent's own watch is paused: it is only waiting for children, and at least one still
 * answers to its own watch. A child that ignored the stop for the grace period hands the clock back.
 */
export function waitingOnChildren(now: number, runningToolNames: readonly string[], children: readonly ChildProgress[]): boolean {
  if (!runningToolNames.length || !runningToolNames.every((name) => CHILD_WAIT_TOOLS.has(name))) return false
  return children.some((child) => child.stopRequestedAt === null || now - child.stopRequestedAt < CHILD_STOP_GRACE_MS)
}
