// Live runs. Assigns per-run sequence numbers, validates every event against the contract,
// persists it, hands it to listeners, and tracks interrupt, approval, and question handlers.
import { randomUUID } from 'node:crypto'

import { log } from '../core/bus'
import { HarnessError } from '../core/errors'
import type { AutomaticReason } from './approvals'
import { isActiveStatus, runEventSchema, type QuestionOption, type RunEvent, type RunEventType, type RunRecord } from './contracts'
import { findRun, persistEvent, readEvents, runFamily } from './runStore'

export type ApprovalDecision = 'approved' | 'denied' | 'native'

export interface ApprovalInput {
  requestId?: string
  operation?: { tool: string; args: Record<string, unknown> }
  target: string
  action: string
  screenshotRef?: string
  /** A tool the user may choose to always allow for this session. */
  rememberable?: boolean
  /** `switch`: only the "always approve" switch may grant it. `none`: a person always decides. */
  standing?: 'full' | 'switch' | 'none'
  /** How long to wait for a decision before the request counts as denied. */
  timeoutMs?: number
}

export interface QuestionInput {
  requestId?: string
  userOnly?: boolean
  question: string
  options: QuestionOption[]
  multiSelect: boolean
  allowText: boolean
}

export interface QuestionAnswer {
  selected: string[]
  text?: string
}

export interface ActiveRun {
  runId: string
  sessionId: string
  emit(type: RunEventType, payload: unknown, native?: unknown): void
  onInterrupt(handler: () => Promise<void> | void): void
  /** Resolves when the user decides; only the approval with this exact id can be resolved by it. */
  requestApproval(input: ApprovalInput): Promise<ApprovalDecision>
  /** Asks the user a question and resolves with their answer. */
  requestAnswer(input: QuestionInput): Promise<QuestionAnswer>
  finish(outcome: 'completed' | 'failed' | 'interrupted', failure?: { code: string; message: string }): void
  readonly finished: boolean
}

/** Called with every persisted event, and the run's record as it is after that event. */
export type RunListener = (event: RunEvent, run: RunRecord | null) => void

export interface RegistryOptions {
  root: () => string
  /** Why this approval can be granted without asking, if it can. */
  automatic?: (run: RunRecord, target: string, operation: ApprovalInput['operation'], standing: 'full' | 'switch') => Promise<AutomaticReason | null>
  /** Called when a run stops being live, whatever its outcome. */
  ended?: (runId: string, sessionId: string) => void
  /** Removes secrets from an event before it is stored or shown. */
  redact?: (event: RunEvent) => void
}

type LiveRun = ActiveRun & { interrupt: () => Promise<void> }

export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>()
  private readonly approvals = new Map<string, { runId: string; resolve: (decision: ApprovalDecision) => void }>()
  private readonly questions = new Map<string, { runId: string; input: QuestionInput; resolve: (answer: QuestionAnswer) => void }>()
  private readonly nativeCleared = new Map<string, string>()
  private readonly stopping = new Set<string>()
  private readonly listeners: RunListener[] = []

  constructor(private readonly options: RegistryOptions) {}

  /** Observers see events after they are persisted, in order. */
  listen(listener: RunListener): void {
    this.listeners.push(listener)
  }

  private deliver(event: RunEvent): boolean {
    const root = this.options.root()
    try {
      this.options.redact?.(event)
      if (!persistEvent(root, event)) return false
    } catch (error) {
      log(`could not persist event for ${event.runId}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    const run = findRun(root, event.runId)
    for (const listener of this.listeners) {
      try {
        listener(event, run)
      } catch (error) {
        log('a run listener failed', error instanceof Error ? error.message : String(error))
      }
    }
    return true
  }

  /** Starts tracking a run whose record is already saved. */
  start(sessionId: string, runId: string = randomUUID()): ActiveRun {
    let sequence = 0
    try {
      sequence = readEvents(this.options.root(), runId).reduce((highest, event) => Math.max(highest, event.sequence + 1), 0)
    } catch {
      sequence = 0
    }
    let finished = false
    const interruptHandlers: Array<() => Promise<void> | void> = []
    const waitingStatus = (): string =>
      [...this.approvals.values()].some((request) => request.runId === runId) ? 'waiting_for_approval' : [...this.questions.values()].some((request) => request.runId === runId) ? 'waiting_for_input' : 'running'

    const emit = (type: RunEventType, payload: unknown, native?: unknown): void => {
      if (finished) return
      const parsed = runEventSchema.safeParse({ id: randomUUID(), runId, sessionId, sequence, timestamp: new Date().toISOString(), type, payload, ...(native === undefined ? {} : { native }) })
      if (!parsed.success) {
        log(`dropped invalid ${type} event for run ${runId}`)
        return
      }
      sequence += 1
      this.deliver(parsed.data)
    }

    const run: LiveRun = {
      runId,
      sessionId,
      emit,
      onInterrupt: (handler) => void interruptHandlers.push(handler),
      requestApproval: async (input) => {
        const { requestId, standing = 'full', timeoutMs, ...payload } = input
        const approvalId = requestId ?? randomUUID()
        // What the user already allowed is known here; if it cannot be read, ask as usual.
        const record = findRun(this.options.root(), runId)
        const automatic = record && this.options.automatic && standing !== 'none' ? await this.options.automatic(record, input.target, input.operation, standing).catch(() => null) : null
        if (finished) return 'denied'
        if (this.nativeCleared.delete(approvalId)) return 'native'
        if (automatic) {
          // Marked on the request too, so nothing treats it as waiting on someone.
          emit('approval.requested', { approvalId, ...payload, automatic })
          emit('approval.resolved', { approvalId, decision: 'approved', automatic })
          return 'approved'
        }
        emit('approval.requested', { approvalId, ...payload })
        emit('status.changed', { status: 'waiting_for_approval' })
        return new Promise<ApprovalDecision>((resolve) => {
          const timer = timeoutMs ? setTimeout(() => this.approvals.get(approvalId)?.resolve('denied'), timeoutMs) : null
          this.approvals.set(approvalId, {
            runId,
            resolve: (decision) => {
              if (timer) clearTimeout(timer)
              this.approvals.delete(approvalId)
              emit('approval.resolved', { approvalId, decision })
              emit('status.changed', { status: waitingStatus() })
              resolve(decision)
            }
          })
        })
      },
      requestAnswer: (input) => {
        const { requestId, ...payload } = input
        const questionId = requestId ?? randomUUID()
        if (finished || this.nativeCleared.delete(questionId)) return Promise.resolve({ selected: [] })
        emit('question.requested', { questionId, ...payload })
        emit('status.changed', { status: 'waiting_for_input' })
        return new Promise<QuestionAnswer>((resolve) => {
          this.questions.set(questionId, {
            runId,
            input,
            resolve: (answer) => {
              this.questions.delete(questionId)
              emit('question.answered', { questionId, ...answer })
              emit('status.changed', { status: waitingStatus() })
              resolve(answer)
            }
          })
        })
      },
      finish: (outcome, failure) => {
        if (finished) return
        if (outcome === 'failed') emit('failed', failure ?? { code: 'failed', message: 'The run failed.' })
        else if (outcome === 'interrupted') emit('status.changed', { status: 'interrupted' })
        else emit('completed', {})
        finished = true
        this.runs.delete(runId)
        for (const [id, owner] of this.nativeCleared) if (owner === runId) this.nativeCleared.delete(id)
        for (const [, approval] of [...this.approvals]) if (approval.runId === runId) approval.resolve('denied')
        for (const [, question] of [...this.questions]) if (question.runId === runId) question.resolve({ selected: [] })
        try {
          this.options.ended?.(runId, sessionId)
        } catch (error) {
          log('a run could not be closed cleanly', error instanceof Error ? error.message : String(error))
        }
      },
      get finished() {
        return finished
      },
      interrupt: async () => {
        for (const handler of interruptHandlers) {
          try {
            await handler()
          } catch (error) {
            log(`an interrupt handler failed for run ${runId}`, error instanceof Error ? error.message : String(error))
          }
        }
        run.finish('interrupted')
      }
    }

    this.runs.set(runId, run)
    emit('started', {})
    emit('status.changed', { status: 'running' })
    const record = findRun(this.options.root(), runId)
    if (record?.parentRunId && this.hasStoppedAncestor(record.parentRunId)) run.finish('interrupted')
    return run
  }

  private hasStoppedAncestor(runId: string): boolean {
    const visited = new Set<string>()
    let currentId: string | null = runId
    while (currentId && !visited.has(currentId)) {
      if (this.stopping.has(currentId)) return true
      visited.add(currentId)
      const record = findRun(this.options.root(), currentId)
      if (!record) return false
      if (!isActiveStatus(record.status)) return true
      currentId = record.parentRunId
    }
    return false
  }

  /** The live run with this id, for a tool or broker that reports into it. */
  active(runId: string): ActiveRun | null {
    return this.runs.get(runId) ?? null
  }

  /** The live run of a session, when it has one. */
  activeForSession(sessionId: string): ActiveRun | null {
    for (const run of this.runs.values()) if (run.sessionId === sessionId) return run
    return null
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) throw new HarnessError('run_not_active', 'This run is not active.')
    if (this.stopping.has(runId)) return
    const family = runFamily(this.options.root(), runId)
    const active = family.runs.map(({ run: member }) => member.id).filter((id) => this.runs.has(id))
    for (const id of active) this.stopping.add(id)
    try {
      await Promise.allSettled(active.map((id) => this.runs.get(id)?.interrupt()))
    } finally {
      for (const id of active) this.stopping.delete(id)
    }
  }

  /** Interrupts every live run, giving each a moment to stop cleanly. */
  async interruptAll(timeoutMs = 3000): Promise<void> {
    await Promise.race([Promise.allSettled(this.activeRunIds().map((id) => this.interrupt(id))), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): void {
    if (decision !== 'approved' && decision !== 'denied' && decision !== 'native') throw new HarnessError('invalid_request', 'Unknown decision.')
    const approval = this.approvals.get(approvalId)
    if (!approval || approval.runId !== runId) throw new HarnessError('approval_not_pending', 'This approval is not pending for this run.')
    approval.resolve(decision)
  }

  answerQuestion(runId: string, questionId: string, answer: QuestionAnswer): void {
    const question = this.questions.get(questionId)
    if (!question || question.runId !== runId) throw new HarnessError('question_not_pending', 'This question is not waiting for an answer.')
    if ((!question.input.multiSelect && answer.selected.length > 1) || answer.selected.some((label) => !question.input.options.some((option) => option.label === label)) || (answer.text && !question.input.allowText)) {
      throw new HarnessError('invalid_answer', 'Choose the offered options or an allowed text answer.')
    }
    question.resolve(answer)
  }

  activeRunIds(): string[] {
    return [...this.runs.keys()]
  }

  /** A request the session's own interface already settled: nothing here is waiting on it any more. */
  nativeResolved(runId: string, requestId: string): void {
    if (!this.runs.has(runId)) return
    const approval = this.approvals.get(requestId)
    if (approval?.runId === runId) return approval.resolve('native')
    const question = this.questions.get(requestId)
    if (question?.runId === runId) return question.resolve({ selected: [] })
    this.nativeCleared.set(requestId, runId)
  }
}
