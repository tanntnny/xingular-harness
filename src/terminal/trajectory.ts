import { notFound } from '../core/errors'
import type { RunEvent, RunRecord } from '../sessions/contracts'
import { findRun, listRuns, readEvents } from '../sessions/runStore'

export type TerminalTrajectoryRun = Pick<RunRecord, 'id' | 'mode' | 'goal' | 'startedAt' | 'endedAt' | 'status'>

export interface TerminalTrajectorySnapshot {
  run: TerminalTrajectoryRun
  events: RunEvent[]
}

function summary(run: RunRecord): TerminalTrajectoryRun {
  return {
    id: run.id,
    mode: run.mode,
    goal: run.goal,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status
  }
}

/** The native conversation file is the terminal's boundary for this read-only view. */
export function listTerminalTrajectoryRuns(root: string, sessionId: string, nativeSessionId: string | null): TerminalTrajectoryRun[] {
  if (!nativeSessionId) return []
  return listRuns(root, { sessionId })
    .filter(run => run.nativeSessionId === nativeSessionId || run.trigger === 'side-question' && run.sessionId === sessionId)
    .map(summary)
}

/** Read a run only when it belongs to both this terminal and its current native conversation. */
export function readTerminalTrajectory(
  root: string,
  sessionId: string,
  nativeSessionId: string | null,
  runId: string,
  afterSequence?: number
): TerminalTrajectorySnapshot {
  if (!nativeSessionId || !Number.isSafeInteger(afterSequence ?? 0) || (afterSequence ?? 0) < 0) throw notFound('Run')
  const run = findRun(root, runId)
  if (!run || run.sessionId !== sessionId || (run.nativeSessionId !== nativeSessionId && run.trigger !== 'side-question')) throw notFound('Run')
  const events = readEvents(root, runId).filter(event => afterSequence === undefined || event.sequence > afterSequence)
  return { run: summary(run), events }
}
