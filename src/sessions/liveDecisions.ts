// The decisions waiting in one live conversation, and the calls that settle them (ADR-0083). A
// client terminal (`LiveTerminal`) and a remote-control pairing on a host's session (PAR-018) share
// this: what is pending for the reply running now and its subagents, a revision that changes whenever
// that set may have changed, approve, answer and interrupt. It holds no session of its own; the caller
// says which run is replying.
import { HarnessError, invalid } from '../core/errors'
import { pendingDecisions, readEvents, recordedSubagents } from './runStore'
import type { RunEvent } from './contracts'
import type { RunRegistry } from './registry'

const WAIT_MS = 20_000
const DECISION_EVENTS = new Set(['approval.requested', 'approval.resolved', 'question.requested', 'question.answered'])
const LIFECYCLE_EVENTS = new Set(['started', 'completed', 'failed', 'status.changed'])

export interface LiveDecisionsOptions {
  root: string
  runs: RunRegistry
  /** The run replying now, or null while the conversation is idle. */
  activeRun(): string | null
  /** Always allow a tool for every session of this profile, as the person's "always allow" does. */
  allowTool(target: string): void
}

export type PendingRequest = Record<string, unknown>

export class LiveDecisions {
  private revisionNumber = 0
  private readonly waiters = new Set<() => void>()

  constructor(private readonly options: LiveDecisionsOptions) {}

  get revision(): number {
    return this.revisionNumber
  }

  /** The set of pending decisions may have changed. */
  bump(): void {
    this.revisionNumber += 1
    for (const wake of [...this.waiters]) wake()
  }

  /** The subagents of the active reply: their approvals and questions belong to the conversation too. */
  private children(): string[] {
    const runId = this.options.activeRun()
    if (!runId) return []
    try {
      return recordedSubagents(this.options.root, runId)
    } catch {
      return []
    }
  }

  /** Whether a run's decisions are this conversation's: the reply running now or one of its subagents. */
  concerns(runId: string): boolean {
    return runId === this.options.activeRun() || this.children().includes(runId)
  }

  /** Bumps the revision for an event that may change what is pending. */
  observe(event: RunEvent): void {
    if (this.concerns(event.runId) && DECISION_EVENTS.has(event.type)) this.bump()
  }

  /**
   * Follows a conversation's own runs on the registry, for a holder with no run events of its own
   * (a remote pairing on a host's session). Returns the function that stops following.
   */
  follow(sessionId: string): () => void {
    return this.options.runs.listen((event) => {
      if (event.sessionId === sessionId && LIFECYCLE_EVENTS.has(event.type)) this.bump()
      else this.observe(event)
    })
  }

  /** The decisions waiting; `ownDialogs` leaves out plugin dialogs the window shows itself. */
  pending(ownDialogs = false): PendingRequest[] {
    const runId = this.options.activeRun()
    if (!runId) return []
    return [runId, ...this.children()].flatMap((id) => {
      try {
        return pendingDecisions(readEvents(this.options.root, id))
          .filter((decision) => !ownDialogs || !(decision.payload as { dialog?: unknown }).dialog)
          .map((decision) => ({ ...(decision.payload as Record<string, unknown>), type: decision.kind, requestId: decision.id, runId: id }))
      } catch {
        return []
      }
    })
  }

  snapshot(ownDialogs = false): { revision: number; requests: PendingRequest[] } {
    return { revision: this.revisionNumber, requests: this.pending(ownDialogs) }
  }

  /** The decisions now, or, when `revision` is still current, the ones after the next change (or 20 s). */
  async wait(revision: unknown, ownDialogs = false, ms = WAIT_MS): Promise<{ revision: number; requests: PendingRequest[] }> {
    if (revision === this.revisionNumber) {
      await new Promise<void>((resolve) => {
        const wake = (): void => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
        const timer = setTimeout(wake, ms)
        timer.unref?.()
        this.waiters.add(wake)
      })
    }
    return this.snapshot(ownDialogs)
  }

  private decision(params: Record<string, unknown>, kind: 'approval' | 'question'): PendingRequest {
    const requestId = typeof params.requestId === 'string' ? params.requestId : ''
    const request = this.pending().find((entry) => entry.requestId === requestId && entry.type === kind)
    if (!request) throw new HarnessError('invalid_request', 'This terminal decision is no longer pending.')
    return request
  }

  approve(params: Record<string, unknown>): Record<string, never> {
    const request = this.decision(params, 'approval')
    const decision = params.decision === 'approved' ? 'approved' : params.decision === 'denied' ? 'denied' : null
    if (!decision) throw invalid('A decision must be approved or denied.')
    if (decision === 'approved' && params.alwaysAllow === true) {
      if (request.rememberable !== true || typeof request.target !== 'string') throw invalid('This action cannot be always allowed.')
      this.options.allowTool(request.target)
    }
    this.options.runs.resolveApproval(String(request.runId), String(request.requestId), decision)
    return {}
  }

  answer(params: Record<string, unknown>): Record<string, never> {
    const request = this.decision(params, 'question')
    this.options.runs.answerQuestion(String(request.runId), String(request.requestId), params.answer as never)
    return {}
  }

  answers(params: Record<string, unknown>): Record<string, never> {
    const batch = this.pending().find((entry) => entry.batchId === params.batchId)
    if (!batch || typeof params.batchId !== 'string' || !Array.isArray(params.answers)) throw invalid('This question batch is no longer pending.')
    this.options.runs.answerQuestions(String(batch.runId), params.batchId, params.answers as never)
    return {}
  }

  /** Stops the reply at once; the provider stream is closed after the reply returns. */
  interrupt(): { runId: string | null } {
    const runId = this.options.activeRun()
    if (runId) void this.options.runs.interrupt(runId).catch(() => undefined)
    return { runId }
  }

  /** Releases anyone waiting; no decision will come. */
  dispose(): void {
    for (const wake of [...this.waiters]) wake()
  }
}
