// One `pi` command running in a terminal, as the harness sees it. The terminal itself belongs
// to whoever embeds the harness; this follows the native process through its extension's
// telemetry (never by reading the screen), turns each native turn into a run, and answers the
// extension's questions about policy, approvals, and what to do next.
import { createHash, randomUUID } from 'node:crypto'

import { HarnessError } from '../core/errors'
import { runStatusSchema, type RunEvent, type RunRecord } from '../sessions/contracts'
import { briefTitle } from '../sessions/subagents'
import type { ActiveRun, ApprovalDecision, QuestionAnswer, QuestionInput } from '../sessions/registry'
import { MAIN_PROFILE, SubagentMonitor, type TerminalSubagentActivity, type TerminalSubagentProfile, type TerminalSubagentRun } from './subagentMonitor'
import { replyStalled } from './stallWatch'

type MonitorRuntime = Pick<TerminalSubagentRun, 'accountLabel' | 'model' | 'effort'>

/** A saved run to show in the monitor after the conversation is reopened. */
export interface MonitorEntry {
  record: RunRecord
  events: readonly RunEvent[]
  profile?: TerminalSubagentProfile | null
  runtime?: MonitorRuntime
}

function monitorRun(record: RunRecord, relation: 'main' | 'subagent', profile: TerminalSubagentProfile | null, runtime: MonitorRuntime): TerminalSubagentRun {
  return {
    id: record.id,
    parentRunId: record.parentRunId,
    relation,
    title: record.title ?? (briefTitle(record.goal) || (relation === 'main' ? 'Main agent' : '')),
    goal: record.goal,
    status: runStatusSchema.parse(record.status),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    profile: relation === 'main' ? MAIN_PROFILE : profile,
    ...runtime
  }
}

export interface PolicyReply {
  allowed: boolean
  reason?: string | null
  workspaceRoot?: string
  requiresApproval?: boolean
  rememberable?: boolean
  standing?: 'full' | 'switch' | 'none'
}

export interface ControllerHooks {
  sessionId: string
  nativeSessionId: string | null
  /** Reserves or creates the run for a native turn and starts tracking it. */
  begin(input: { reservedRunId: string | null; nativeTurnId: string; text: string; model?: string | null; effort?: string | null }): ActiveRun
  /** Whether a native tool call may run. */
  policy(run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply>
  /** The workspace root pinned on the run record. */
  workspaceRoot(run: ActiveRun): string
  /** One-shot approval before an explicitly broad Bash command runs. */
  workspaceEscape(run: ActiveRun, tool: string, args: unknown, reason: string): Promise<boolean>
  /** Whether Full Permission may bypass the filesystem boundary for this Bash command. */
  workspaceBoundaryBypass(run: ActiveRun, tool: string, args: unknown): Promise<boolean>
  /** Saves a user-selected tool grant in the shared local approval store. */
  allowToolGlobally(target: string): void
  /** The native conversation identity changed. */
  native(nativeSessionId: string): void
  /**
   * The conversation opened with no turn running: show its latest parent run's rows again. `owners`
   * are the parent run ids recorded on the native branch, oldest first.
   */
  hydrate?(owners: string[]): void
  telemetry(event: string): void
  interrupt?(runId: string): Promise<void>
  resolveApproval?(runId: string, requestId: string, decision: ApprovalDecision): void
  answerQuestion?(runId: string, requestId: string, answer: QuestionAnswer): void
  answerQuestions?(runId: string, batchId: string, answers: Array<{ questionId: string; answer: QuestionAnswer }>): void
}

interface Delivery {
  runId: string
  text: string
  resolve: () => void
  reject: (error: Error) => void
}

type Command = { type: 'interrupt' } | { type: 'send'; text: string }

const READY_TIMEOUT_MS = 90_000
const ACK_TIMEOUT_MS = 25_000
/** How often a live reply's progress is checked against the stall windows. */
const STALL_CHECK_MS = 30_000

export class TerminalController {
  private run: ActiveRun | null = null
  private lastRunId: string | null = null
  private readonly pending = new Map<string, Record<string, unknown>>()
  private pendingRevision = 0
  private readonly pendingWaiters = new Set<() => void>()
  private readonly subagents = new SubagentMonitor()
  private subagentParentRunId: string | null = null
  private ready = false
  private disposed = false
  private dirty = false
  private multilineDraft = false
  private startupError: string | null = null
  private startupPhase = 'Waiting for the native extension'
  private delivery: Delivery | null = null
  private nativeId: string | null
  private readonly seen = new Map<string, Promise<unknown>>()
  private readonly commands: Command[] = []
  /** When the reply last produced something other than a heartbeat; silence is what a stall is. */
  private progressAt = 0
  private readonly runningTools = new Map<string, number>()
  private stallRequested: string | null = null
  private stallTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly hooks: ControllerHooks) {
    this.nativeId = hooks.nativeSessionId
  }

  private pendingChanged(): void {
    this.pendingRevision += 1
    for (const wake of this.pendingWaiters) wake()
  }

  private setPending(key: string, value: Record<string, unknown>): void {
    this.pending.set(key, value)
    this.pendingChanged()
  }

  private deletePending(key: string): void {
    if (this.pending.delete(key)) this.pendingChanged()
  }

  private async waitPending(revision: unknown): Promise<{ revision: number; requests: Record<string, unknown>[] }> {
    if (revision === this.pendingRevision && !this.disposed) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.pendingWaiters.delete(wake); resolve() }
        const timer = setTimeout(wake, 20_000)
        this.pendingWaiters.add(wake)
      })
    }
    return { revision: this.pendingRevision, requests: [...this.pending.values()] }
  }

  get nativeSessionId(): string | null {
    return this.nativeId
  }

  get activeRun(): ActiveRun | null {
    return this.run && !this.run.finished ? this.run : null
  }

  /** The run this terminal is showing, or the last one it finished: `/context` reads it after a reply. */
  get lastRun(): string | null {
    return this.activeRun?.runId ?? this.lastRunId
  }

  state(): { ready: boolean; dirty: boolean; active: boolean } {
    return { ready: this.ready, dirty: this.dirty, active: !!this.activeRun || !!this.delivery }
  }

  private requestId(nativeId: string): string {
    return createHash('sha256').update(`${this.hooks.sessionId}:${this.run?.runId}:${nativeId}`).digest('hex')
  }

  private begin(nativeTurnId: string, text: string, launch: { model?: string | null; effort?: string | null } = {}): ActiveRun {
    if (this.startupError) throw new Error(this.startupError)
    this.dirty = false
    this.multilineDraft = false
    if (this.run && !this.run.finished) return this.run
    const delivery = this.delivery
    if (delivery && text && delivery.text !== text) throw new Error('The native prompt did not match the reserved delivery. Inspect the terminal before continuing.')
    const run = this.hooks.begin({ reservedRunId: delivery?.runId ?? null, nativeTurnId, text, ...launch })
    this.run = run
    this.lastRunId = run.runId
    this.subagentParentRunId = run.runId
    this.watchProgress()
    this.subagents.begin(run.runId)
    run.onInterrupt(() => void this.commands.push({ type: 'interrupt' }))
    if (text) run.emit('message.completed', { messageId: nativeTurnId, role: 'user', text })
    delivery?.resolve()
    this.delivery = null
    return run
  }

  private finish(outcome: 'completed' | 'failed' | 'interrupted', message?: string, reason?: string, code?: import('../sessions/contracts').RunStopCode): void {
    this.stopStallWatch()
    this.run?.finish(outcome, message ? { code: code === 'provider_error' ? 'provider_error' : 'terminal_attention', message } : undefined, reason, code)
    this.run = null
    this.seen.clear()
    if (this.pending.size) { this.pending.clear(); this.pendingChanged() }
  }

  private watchProgress(): void {
    this.progressAt = Date.now()
    this.runningTools.clear()
    this.stallRequested = null
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = setInterval(() => this.checkStall(), STALL_CHECK_MS)
    this.stallTimer.unref?.()
  }

  private stopStallWatch(): void {
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = null
    this.stallRequested = null
    this.runningTools.clear()
  }

  /**
   * Ends a reply its native turn can no longer finish: the process is alive and keeps reporting, but
   * the reply produced nothing for the whole window (a model request that never came back). A person
   * may already be answering an approval, and a tool may still be working, so neither is cut short.
   */
  private checkStall(): void {
    const run = this.activeRun
    if (!run || this.stallRequested || this.pending.size) return
    if (!replyStalled({ now: Date.now(), progressAt: this.progressAt, runningTools: [...this.runningTools.values()] })) return
    this.stallRequested = run.runId
    this.hooks.telemetry('stall')
    this.commands.push({ type: 'interrupt' })
  }

  /** Hands the native process an instruction and waits until it acknowledges the prompt. */
  async send(runId: string, text: string): Promise<void> {
    if (this.disposed) throw new HarnessError('terminal_not_ready', 'Reopen the terminal before sending instructions.')
    if (this.activeRun || this.delivery) throw new HarnessError('session_busy', 'This terminal has an active task or delivery.')
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!this.ready && !this.startupError && !this.disposed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    if (this.disposed) throw new HarnessError('terminal_not_ready', 'The terminal stopped during initialization.')
    if (this.startupError) throw new HarnessError('terminal_not_ready', this.startupError)
    if (!this.ready) throw new HarnessError('terminal_not_ready', `The native telemetry handshake is missing (${this.startupPhase}). Inspect the terminal sign-in or trust screen.`)
    if (this.dirty) throw new HarnessError('terminal_has_draft', 'The terminal contains user input. Submit or clear it before handing back control.')
    let timer: ReturnType<typeof setTimeout>
    const ack = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new HarnessError('delivery_uncertain', 'The native prompt acknowledgement was not received. Inspect the terminal; this instruction will not be resent.')), ACK_TIMEOUT_MS)
      this.delivery = { runId, text, resolve, reject }
    })
    // Delivery can fail while the native process is still starting the turn. Observe it immediately.
    void ack.catch(() => {})
    try {
      this.commands.push({ type: 'send', text })
      await ack
    } catch (error) {
      this.ready = false
      this.startupError = error instanceof Error ? error.message : String(error)
      this.delivery = null
      this.commands.length = 0
      this.commands.push({ type: 'interrupt' })
      this.finish('failed', this.startupError)
      throw error
    } finally {
      clearTimeout(timer!)
    }
  }

  /** What the person typed into the terminal, so an instruction is never sent over their draft. */
  onInput(data: string): void {
    if (!this.ready || this.activeRun || data === '\u0003') return
    if (data.includes('\n') || data.includes('\r')) this.multilineDraft = true
    this.dirty = data !== '\u0015' || this.multilineDraft
  }

  /** The native process hung up while it was waiting for a decision. */
  disconnected(): void {
    if (this.disposed) return
    this.ready = false
    this.commands.push({ type: 'interrupt' })
    this.finish('failed', 'The native decision callback disconnected. Inspect the terminal before continuing.')
  }

  /** Project registry-owned questions, including grouped requests, into the terminal inbox. */
  observe(event: RunEvent, descendant = false): void {
    if (this.disposed || !this.activeRun || (!descendant && event.runId !== this.activeRun.runId)) return
    if (event.type === 'question.requested') {
      const payload = event.payload as Record<string, unknown>
      this.setPending(String(payload.questionId), { ...payload, type: 'question', requestId: payload.questionId, runId: event.runId })
    } else if (event.type === 'approval.requested') {
      const payload = event.payload as Record<string, unknown>
      if (!payload.automatic && (descendant || payload.target === 'workspace-write')) {
        this.setPending(String(payload.approvalId), { ...payload, type: 'approval', requestId: payload.approvalId, runId: event.runId })
      }
    } else if (event.type === 'approval.resolved') {
      this.deletePending(String((event.payload as { approvalId: string }).approvalId))
    } else if (event.type === 'question.answered') {
      this.deletePending(String((event.payload as { questionId: string }).questionId))
    }
  }

  /** A child event that belongs to the active terminal parent run. */
  observeSubagent(
    parentRunId: string,
    run: RunRecord,
    event: RunEvent,
    profile: TerminalSubagentProfile | null = null,
    runtime: Pick<TerminalSubagentRun, 'accountLabel' | 'model' | 'effort'> = {}
  ): void {
    if (this.disposed || this.activeRun?.runId !== parentRunId || run.relation !== 'subagent') return
    this.subagents.observe(parentRunId, monitorRun(run, 'subagent', profile, runtime), event)
  }

  /** An event of the tracked parent run itself, shown as the `main` row; it outlives settlement. */
  observeMain(run: RunRecord, event: RunEvent, runtime: MonitorRuntime = {}): void {
    if (this.disposed || this.subagentParentRunId !== run.id || run.relation) return
    this.subagents.observe(run.id, monitorRun(run, 'main', null, runtime), event)
  }

  /** Shows a saved parent run and its descendants, as they ended, until another run begins. */
  restoreMonitor(parent: MonitorEntry, children: readonly MonitorEntry[]): void {
    if (this.disposed || this.activeRun || this.delivery) return
    this.subagentParentRunId = parent.record.id
    this.subagents.restore(parent.record.id, [
      { run: monitorRun(parent.record, 'main', null, parent.runtime ?? {}), events: parent.events },
      ...children.map((child) => ({ run: monitorRun(child.record, 'subagent', child.profile ?? null, child.runtime ?? {}), events: child.events }))
    ])
  }

  /** Read-only child activity for the latest parent run, retained until another run begins. */
  subagentSnapshot(): TerminalSubagentActivity[] {
    return this.subagentParentRunId ? this.subagents.snapshot(this.subagentParentRunId) : []
  }

  /** The socket grants this interface only to the process that owns terminal input. */
  async control(call: string, data: Record<string, any>): Promise<unknown> {
    if (this.disposed) throw new HarnessError('terminal_not_ready', 'This terminal has ended.')
    if (call === 'terminal.draft') {
      this.dirty = data.dirty === true
      this.multilineDraft = false
      return {}
    }
    if (call === 'terminal.pending') return { requests: [...this.pending.values()] }
    if (call === 'terminal.pending.wait') return this.waitPending(data.revision)
    if (call === 'terminal.interrupt') return this.activeRun && this.hooks.interrupt ? this.hooks.interrupt(this.activeRun.runId) : {}
    if (call === 'terminal.policy') {
      const run = this.activeRun
      if (!run || typeof data.tool !== 'string' || !data.tool) throw new HarnessError('invalid_request', 'An active run and tool name are required.')
      return this.hooks.policy(run, data.tool, data.args ?? {})
    }
    if (call === 'terminal.workspaceBoundaryBypass') {
      const run = this.activeRun
      if (!run || data.tool !== 'bash') throw new HarnessError('invalid_request', 'An active run and Bash command are required.')
      const args = data.args && typeof data.args === 'object' && !Array.isArray(data.args) ? data.args : {}
      return { bypass: await this.hooks.workspaceBoundaryBypass(run, 'bash', args) }
    }
    if (call === 'terminal.workspaceEscape') {
      const run = this.activeRun
      if (!run || data.tool !== 'bash' || typeof data.reason !== 'string' || !data.reason) throw new HarnessError('invalid_request', 'An active run, Bash command, and outside-scope request are required.')
      const args = data.args && typeof data.args === 'object' && !Array.isArray(data.args) ? data.args : {}
      return { approved: await this.hooks.workspaceEscape(run, 'bash', args, data.reason) }
    }
    if (call === 'terminal.approval') return this.requestNativeApproval(data)
    if (call === 'terminal.answers' && this.hooks.answerQuestions) {
      const run = this.activeRun
      const batchId = String(data.batchId ?? '')
      const requests = [...this.pending.values()].filter(request => request.batchId === batchId)
      if (!run || !batchId || !requests.length || !Array.isArray(data.answers)) throw new HarnessError('invalid_request', 'This question batch is no longer pending.')
      this.hooks.answerQuestions(String(requests[0].runId ?? run.runId), batchId, data.answers)
      return {}
    }
    const requestId = String(data.requestId ?? '')
    const request = this.pending.get(requestId)
    const run = this.activeRun
    if (!request || !run) throw new HarnessError('invalid_request', 'This terminal decision is no longer pending.')
    if (call === 'terminal.approve' && request.type === 'approval' && this.hooks.resolveApproval) {
      if (data.decision !== 'approved' && data.decision !== 'denied') throw new HarnessError('invalid_request', 'Choose approve or deny.')
      const alwaysAllow = data.alwaysAllow === true
      if (alwaysAllow && request.rememberable !== true) throw new HarnessError('invalid_request', 'This approval cannot be remembered for other sessions.')
      let decision: ApprovalDecision = data.decision
      if (decision === 'approved' && request.direct === true) {
        const operation = request.operation as { tool?: unknown; args?: unknown } | undefined
        const tool = typeof operation?.tool === 'string' ? operation.tool : ''
        const current = await this.hooks.policy(run, tool, operation?.args ?? {})
        if (!current.allowed && !current.requiresApproval) decision = 'denied'
        if (alwaysAllow && current.rememberable !== true) {
          request.rememberable = false
          throw new HarnessError('invalid_request', 'This tool can no longer be allowed across sessions. Review the approval again.')
        }
      }
      if (decision === 'approved' && alwaysAllow) this.hooks.allowToolGlobally(String(request.target ?? ''))
      this.hooks.resolveApproval(String(request.runId ?? run.runId), requestId, decision)
      return {}
    }
    if (call === 'terminal.answer' && request.type === 'question' && this.hooks.answerQuestion) {
      if (!data.answer || !Array.isArray(data.answer.selected)) throw new HarnessError('invalid_request', 'A question answer is required.')
      this.hooks.answerQuestion(String(request.runId ?? run.runId), requestId, data.answer)
      return {}
    }
    throw new HarnessError('unknown_method', `Unknown terminal control ${call}.`)
  }

  private async requestNativeApproval(data: Record<string, any>): Promise<unknown> {
    const run = this.activeRun
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const tool = typeof data.tool === 'string' ? data.tool : ''
    if (!run || !requestId || !tool) throw new HarnessError('invalid_request', 'An active run, request id, and tool name are required.')
    const args = data.args && typeof data.args === 'object' && !Array.isArray(data.args) ? data.args as Record<string, unknown> : {}
    const policy = await this.hooks.policy(run, tool, args)
    if (!policy.allowed && !policy.requiresApproval) return { decision: 'denied' }
    if (policy.allowed && !policy.requiresApproval) return { decision: 'approved' }
    const key = this.requestId(`approval:${requestId}`)
    const existing = this.seen.get(key)
    if (existing) return { decision: await existing }
    const action = JSON.stringify(args)
    const operation = { tool, args }
    const response = run.requestApproval({
      requestId: key,
      target: tool,
      action,
      operation,
      rememberable: policy.rememberable === true,
      standing: policy.standing
    })
    this.setPending(key, {
      type: 'approval', requestId: key, runId: run.runId, target: tool, action,
      operation, rememberable: policy.rememberable === true, direct: true
    })
    this.seen.set(key, response)
    try {
      return { decision: await response }
    } finally {
      this.deletePending(key)
    }
  }

  async accept(event: string, data: Record<string, any>): Promise<unknown> {
    if (this.disposed) throw new Error('This terminal controller was disposed.')
    // Streamed reply text is frequent and only feeds run events; it is not host telemetry.
    if (event !== 'poll' && event !== 'delta') this.hooks.telemetry(event)
    if (event === 'startup') {
      this.startupPhase = String(data.phase)
      return {}
    }
    if (event === 'startupFailed') {
      this.startupError = String(data.reason ?? 'The native extension could not initialize.')
      this.ready = false
      this.finish('failed', this.startupError)
      return {}
    }
    if (event === 'poll') return { command: this.commands.shift() ?? null }
    // A heartbeat proves the turn is alive, not that it is working; only real events restart the clock.
    if (event !== 'heartbeat') this.progressAt = Date.now()
    if (event === 'ready') {
      if (!this.ready) {
        this.dirty = false
        this.multilineDraft = false
      }
      this.ready = true
      if (typeof data.nativeSessionId === 'string' && data.nativeSessionId) {
        if (this.nativeId !== data.nativeSessionId) {
          this.subagents.clear()
          this.subagentParentRunId = null
        }
        this.nativeId = data.nativeSessionId
        this.hooks.native(data.nativeSessionId)
      }
      const owners = Array.isArray(data.owners) ? data.owners.filter((id: unknown): id is string => typeof id === 'string') : []
      if (!this.activeRun && !this.delivery && this.hooks.hydrate) this.hooks.hydrate(owners)
      return {}
    }
    if (event === 'begin') {
      const run = this.begin(String(data.turnId ?? randomUUID()), String(data.text ?? ''), {
        model: typeof data.model === 'string' && data.model ? data.model : null,
        effort: typeof data.effort === 'string' && data.effort ? data.effort : null
      })
      return { runId: run.runId, workspaceRoot: this.hooks.workspaceRoot(run) }
    }
    if (event === 'shutdown') {
      this.ready = false
      this.finish('interrupted', undefined, undefined, 'terminal_closed')
      return {}
    }
    if (event === 'settled') {
      // A reply that stopped at its work-slice boundary is interrupted, not completed: the record
      // says `slice_complete` (or `stalled`) so a host can continue it (PROP-0041).
      const stalled = this.stallRequested !== null && this.stallRequested === this.run?.runId
      const reason = data.error ? undefined : stalled ? 'stalled' : typeof data.reason === 'string' ? data.reason : undefined
      const outcome = data.error ? 'failed' : data.aborted || reason ? 'interrupted' : 'completed'
      const code = data.error ? data.errorCode === 'provider_error' ? 'provider_error' : undefined : stalled ? 'stalled' : data.code === 'slice_budget' || data.code === 'compaction_thrash' ? data.code : data.aborted ? 'user_abort' : undefined
      this.finish(outcome, data.error ? String(data.error) : undefined, reason, code)
      return {}
    }
    const run = this.run
    if (!run) throw new Error('Native telemetry arrived without an active turn.')
    if (event === 'policy') return this.hooks.policy(run, String(data.tool), data.args ?? {})
    if (event === 'questions') {
      if (!Array.isArray(data.questions) || !data.questions.length || data.questions.length > 5) throw new HarnessError('invalid_request', 'Ask between one and five questions.')
      const questions = (data.questions as QuestionInput[]).map(question => ({ ...question, requestId: randomUUID() }))
      return run.requestAnswers(questions)
    }
    if (event === 'approval' || event === 'question') {
      const key = this.requestId(`${event}:${String(data.requestId ?? JSON.stringify(data))}`)
      const existing = this.seen.get(key)
      if (existing) return event === 'approval' ? { decision: await existing } : existing
      if (event === 'question') {
        const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : undefined
        const sketchMode = data.uiSketch === undefined ? {} : { uiSketch: data.uiSketch }
        const response: Promise<QuestionAnswer> = run.requestAnswer({ requestId: key, ...(summary ? { summary } : {}), ...sketchMode, question: String(data.question ?? ''), options: data.options ?? [], multiSelect: !!data.multiSelect, allowText: true })
        this.setPending(key, { type: 'question', requestId: key, ...(summary ? { summary } : {}), ...sketchMode, question: String(data.question ?? ''), options: data.options ?? [], multiSelect: !!data.multiSelect })
        this.seen.set(key, response)
        return response.finally(() => this.deletePending(key))
      }
      const response: Promise<ApprovalDecision> = run.requestApproval({
        requestId: key,
        target: String(data.target ?? 'Native action'),
        action: String(data.action ?? '{}'),
        operation: { tool: String(data.tool ?? data.target), args: data.args ?? {} },
        rememberable: false
      })
      this.setPending(key, { type: 'approval', requestId: key, target: String(data.target ?? 'Action'), action: String(data.action ?? '{}') })
      this.seen.set(key, response)
      try {
        return { decision: await response }
      } finally {
        this.deletePending(key)
      }
    }
    if (event === 'usage') run.emit('usage.updated', data)
    else if (event === 'refusal') run.emit('tool.refused', data)
    else if (event === 'compaction.started' || event === 'compaction.ended') run.emit(event, data)
    else if (event === 'heartbeat') run.emit('heartbeat', data)
    else if (event === 'todo' || event === 'checklist') run.emit('todo.updated', { items: data.items })
    else if (event === 'checkpoint') run.emit('checkpoint', data)
    else if (event === 'file') run.emit('file.changed', data)
    else if (event === 'delta') run.emit('message.delta', { messageId: String(data.id ?? ''), text: String(data.text ?? '') })
    else if (event === 'message') run.emit('message.completed', { messageId: data.id ?? randomUUID(), role: data.role ?? 'assistant', text: String(data.text) })
    else if (event === 'tool') {
      if (data.phase === 'start') this.runningTools.set(String(data.id), Date.now())
      else this.runningTools.delete(String(data.id))
      run.emit(data.phase === 'start' ? 'tool.started' : 'tool.completed', {
        toolCallId: String(data.id),
        name: String(data.name),
        ...(data.phase === 'start'
          ? { summary: String(data.summary ?? ''), ...(typeof data.input === 'string' ? { input: data.input.slice(0, 24_000) } : {}) }
          : { ok: data.ok !== false, ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}), ...(typeof data.resultChars === 'number' ? { resultChars: data.resultChars } : {}), ...(typeof data.output === 'string' ? { output: data.output.slice(0, 24_000) } : {}), ...(data.outputTruncated === true ? { outputTruncated: true } : {}) })
      })
    }
    return {}
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingChanged()
    this.ready = false
    this.delivery?.reject(new Error('The terminal stopped before prompt acknowledgement.'))
    this.delivery = null
    this.finish('interrupted', undefined, undefined, 'terminal_closed')
    this.subagents.clear()
    this.subagentParentRunId = null
  }
}
