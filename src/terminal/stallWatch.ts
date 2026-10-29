// A live terminal reply that produced nothing for too long is not working: the person should be
// told instead of watching a run that never settles. This is the turn-level rule; the run-store
// sweep (`reconcileStaleRuns`) settles a record whose owner stopped reporting, and both use the
// same reason, `stalled` (INV-RUN-14).

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
