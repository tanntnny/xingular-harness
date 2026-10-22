// Continuing a run that stopped before it finished. The harness never restarts model work on its
// own (INV-RUN-4); it says whether a run can be continued and, when the application starts a new
// run with `continueFrom`, tells the model where the earlier one stopped.
import { loadRun as loadCapabilities } from '../capabilities/runSnapshot'
import type { CapabilitySet } from '../capabilities/types'
import type { HostSection } from '../prompt/compile'
import { checklistOf, describeChecklist } from '../tools/checklist'
import { isActiveStatus, type ChecklistItem } from './contracts'
import { findHistory } from './history'
import { findRun, pendingDecisions, readEvents, recordedSubagents, type PendingDecision } from './runStore'

export const CONTINUATION_SECTION_ID = 'continuation'
/** Right after the plan section, before the variant's own sections. */
export const CONTINUATION_SECTION_ORDER = 26
const CONTINUATION_BUDGET = 2000

/** Why a run cannot be continued. */
export type ContinuationBlock = 'not_found' | 'active' | 'completed' | 'no_history' | 'history_missing'

export interface Continuation {
  runId: string
  sessionId: string
  status: string
  resumable: boolean
  reason: ContinuationBlock | null
  /** The exact native history to reopen; set when it was found in the session folder. */
  resume: { sessionFile: string; nativeSessionId: string } | null
  accountId: string | null
  /** The variant the run pinned; a continuation pins the same version. */
  variant: { scope: string; version: string | null } | null
  capabilities: CapabilitySet | null
  stoppedAt: string | null
  terminalReason: string | null
  checklist: ChecklistItem[]
  pending: PendingDecision[]
  /** The last tool the run started, and whether it finished. */
  lastTool: { name: string; finished: boolean } | null
  /** Child runs that did not finish. */
  unfinishedSubagents: string[]
}

/**
 * What a new run needs to continue `runId`. With `sessionDir` the native history is looked up in
 * it; without, `resume` stays null and the run reads as not resumable only when it has no history.
 */
export function continuationOf(root: string, runId: string, sessionDir?: string | null): Continuation {
  const record = findRun(root, runId)
  if (!record) {
    return { runId, sessionId: '', status: 'missing', resumable: false, reason: 'not_found', resume: null, accountId: null, variant: null, capabilities: null, stoppedAt: null, terminalReason: null, checklist: [], pending: [], lastTool: null, unfinishedSubagents: [] }
  }
  const events = readEvents(root, runId)
  const started = events.filter((event) => event.type === 'tool.started').at(-1)
  const startedPayload = started?.payload as { toolCallId?: string; name?: string } | undefined
  const lastTool = startedPayload?.name
    ? { name: startedPayload.name, finished: events.some((event) => event.type === 'tool.completed' && (event.payload as { toolCallId?: string }).toolCallId === startedPayload.toolCallId) }
    : null
  const snapshot = loadCapabilities(root, runId)
  const capabilities: CapabilitySet | null = snapshot ? { version: 1, tools: snapshot.tools, connectors: snapshot.connectors, contributions: snapshot.contributions } : null
  const sessionFile = sessionDir && record.nativeSessionId ? findHistory(sessionDir, record.nativeSessionId) : null
  const reason: ContinuationBlock | null =
    isActiveStatus(record.status) ? 'active'
      : record.status === 'completed' ? 'completed'
        : !record.nativeSessionId ? 'no_history'
          : sessionDir && !sessionFile ? 'history_missing'
            : null
  return {
    runId,
    sessionId: record.sessionId,
    status: record.status,
    resumable: reason === null,
    reason,
    resume: sessionFile && record.nativeSessionId ? { sessionFile, nativeSessionId: record.nativeSessionId } : null,
    accountId: record.accountId,
    variant: record.variantScope ? { scope: record.variantScope, version: record.variantVersion ?? null } : null,
    capabilities,
    stoppedAt: record.endedAt,
    terminalReason: record.terminalReason,
    checklist: checklistOf(events),
    pending: pendingDecisions(events),
    lastTool,
    unfinishedSubagents: recordedSubagents(root, runId).filter((id) => {
      const child = findRun(root, id)
      return !child || child.status !== 'completed'
    })
  }
}

const describePending = (decision: PendingDecision): string => {
  const payload = decision.payload as { target?: unknown; action?: unknown; questions?: { question?: unknown }[]; question?: unknown }
  if (decision.kind === 'approval') return `- An approval for ${typeof payload.target === 'string' ? payload.target : 'a tool call'}${typeof payload.action === 'string' && payload.action ? ` (${payload.action})` : ''} was never answered.`
  const question = typeof payload.question === 'string' ? payload.question : Array.isArray(payload.questions) && typeof payload.questions[0]?.question === 'string' ? payload.questions[0].question : 'a question'
  return `- A question to the user was never answered: ${question}`
}

/** The text that tells the model where the earlier run stopped. */
export function continuationBody(continuation: Continuation): string {
  const lines = [
    `The previous run (${continuation.runId}) stopped before it finished${continuation.stoppedAt ? ` at ${continuation.stoppedAt}` : ''}${continuation.terminalReason ? `: ${continuation.terminalReason}` : '.'}`,
    'Its conversation above is intact up to that point. Check the current state before you repeat any step: work may be partly done.'
  ]
  if (continuation.lastTool) lines.push(continuation.lastTool.finished ? `Its last tool call, ${continuation.lastTool.name}, finished.` : `Its last tool call, ${continuation.lastTool.name}, did not finish; its effect is unknown.`)
  if (continuation.checklist.length) lines.push('', 'Its checklist when it stopped:', describeChecklist(continuation.checklist))
  if (continuation.pending.length) lines.push('', 'Unanswered when it stopped (ask again if still needed; never assume an answer):', ...continuation.pending.map(describePending))
  if (continuation.unfinishedSubagents.length) lines.push('', `Subagents that did not finish: ${continuation.unfinishedSubagents.join(', ')}. Start them again if their work is still needed.`)
  return lines.join('\n')
}

/** The dynamic section for a continuation; on a later run, the empty slot withdraws it. */
export function continuationSection(continuation: Continuation | null, delivered: boolean): HostSection | null {
  if (continuation) return { id: CONTINUATION_SECTION_ID, title: 'Continuing', body: continuationBody(continuation), budget: CONTINUATION_BUDGET, order: CONTINUATION_SECTION_ORDER, dynamic: true }
  return delivered ? { id: CONTINUATION_SECTION_ID, title: 'Continuing', body: null, budget: CONTINUATION_BUDGET, order: CONTINUATION_SECTION_ORDER, dynamic: true } : null
}
