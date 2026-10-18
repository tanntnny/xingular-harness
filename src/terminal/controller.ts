// One `pi` command running in a terminal, as the harness sees it. The terminal itself belongs
// to whoever embeds the harness; this follows the native process through its extension's
// telemetry (never by reading the screen), turns each native turn into a run, and answers the
// extension's questions about policy, approvals, and what to do next.
import { createHash, randomUUID } from 'node:crypto'

import { HarnessError } from '../core/errors'
import type { RunEvent } from '../sessions/contracts'
import type { ActiveRun, ApprovalDecision, QuestionAnswer, QuestionInput } from '../sessions/registry'

export interface PolicyReply {
  allowed: boolean
  reason?: string | null
  requiresApproval?: boolean
  rememberable?: boolean
  standing?: 'full' | 'switch' | 'none'
}

export interface ControllerHooks {
  sessionId: string
  nativeSessionId: string | null
  /** Reserves or creates the run for a native turn and starts tracking it. */
  begin(input: { reservedRunId: string | null; nativeTurnId: string; text: string }): ActiveRun
  /** Whether a native tool call may run. */
  policy(run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply>
  /** Saves a user-selected tool grant in the shared local approval store. */
  allowToolGlobally(target: string): void
  /** The native conversation identity changed. */
  native(nativeSessionId: string): void
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

export class TerminalController {
  private run: ActiveRun | null = null
  private readonly pending = new Map<string, Record<string, unknown>>()
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

  constructor(private readonly hooks: ControllerHooks) {
    this.nativeId = hooks.nativeSessionId
  }

  get nativeSessionId(): string | null {
    return this.nativeId
  }

  get activeRun(): ActiveRun | null {
    return this.run && !this.run.finished ? this.run : null
  }

  state(): { ready: boolean; dirty: boolean; active: boolean } {
    return { ready: this.ready, dirty: this.dirty, active: !!this.activeRun || !!this.delivery }
  }

  private requestId(nativeId: string): string {
    return createHash('sha256').update(`${this.hooks.sessionId}:${this.run?.runId}:${nativeId}`).digest('hex')
  }

  private begin(nativeTurnId: string, text: string): ActiveRun {
    if (this.startupError) throw new Error(this.startupError)
    this.dirty = false
    this.multilineDraft = false
    if (this.run && !this.run.finished) return this.run
    const delivery = this.delivery
    if (delivery && text && delivery.text !== text) throw new Error('The native prompt did not match the reserved delivery. Inspect the terminal before continuing.')
    const run = this.hooks.begin({ reservedRunId: delivery?.runId ?? null, nativeTurnId, text })
    this.run = run
    run.onInterrupt(() => void this.commands.push({ type: 'interrupt' }))
    if (text) run.emit('message.completed', { messageId: nativeTurnId, role: 'user', text })
    delivery?.resolve()
    this.delivery = null
    return run
  }

  private finish(outcome: 'completed' | 'failed' | 'interrupted', message?: string): void {
    this.run?.finish(outcome, message ? { code: 'terminal_attention', message } : undefined)
    this.run = null
    this.seen.clear()
    this.pending.clear()
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
      this.pending.set(String(payload.questionId), { ...payload, type: 'question', requestId: payload.questionId, runId: event.runId })
    } else if (descendant && event.type === 'approval.requested') {
      const payload = event.payload as Record<string, unknown>
      if (!payload.automatic) this.pending.set(String(payload.approvalId), { ...payload, type: 'approval', requestId: payload.approvalId, runId: event.runId })
    } else if (event.type === 'approval.resolved') {
      this.pending.delete(String((event.payload as { approvalId: string }).approvalId))
    } else if (event.type === 'question.answered') {
      this.pending.delete(String((event.payload as { questionId: string }).questionId))
    }
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
    if (call === 'terminal.interrupt') return this.activeRun && this.hooks.interrupt ? this.hooks.interrupt(this.activeRun.runId) : {}
    if (call === 'terminal.policy') {
      const run = this.activeRun
      if (!run || typeof data.tool !== 'string' || !data.tool) throw new HarnessError('invalid_request', 'An active run and tool name are required.')
      return this.hooks.policy(run, data.tool, data.args ?? {})
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
    this.pending.set(key, {
      type: 'approval', requestId: key, runId: run.runId, target: tool, action,
      operation, rememberable: policy.rememberable === true, direct: true
    })
    this.seen.set(key, response)
    try {
      return { decision: await response }
    } finally {
      this.pending.delete(key)
    }
  }

  async accept(event: string, data: Record<string, any>): Promise<unknown> {
    if (this.disposed) throw new Error('This terminal controller was disposed.')
    if (event !== 'poll') this.hooks.telemetry(event)
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
    if (event === 'ready') {
      if (!this.ready) {
        this.dirty = false
        this.multilineDraft = false
      }
      this.ready = true
      if (typeof data.nativeSessionId === 'string' && data.nativeSessionId) {
        this.nativeId = data.nativeSessionId
        this.hooks.native(data.nativeSessionId)
      }
      return {}
    }
    if (event === 'begin') {
      const run = this.begin(String(data.turnId ?? randomUUID()), String(data.text ?? ''))
      return { runId: run.runId }
    }
    if (event === 'shutdown') {
      this.ready = false
      this.finish('interrupted')
      return {}
    }
    if (event === 'settled') {
      this.finish(data.aborted ? 'interrupted' : data.error ? 'failed' : 'completed', data.error ? String(data.error) : undefined)
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
        const response: Promise<QuestionAnswer> = run.requestAnswer({ requestId: key, question: String(data.question ?? ''), options: data.options ?? [], multiSelect: !!data.multiSelect, allowText: true })
        this.pending.set(key, { type: 'question', requestId: key, question: String(data.question ?? ''), options: data.options ?? [], multiSelect: !!data.multiSelect })
        this.seen.set(key, response)
        return response.finally(() => this.pending.delete(key))
      }
      const response: Promise<ApprovalDecision> = run.requestApproval({
        requestId: key,
        target: String(data.target ?? 'Native action'),
        action: String(data.action ?? '{}'),
        operation: { tool: String(data.tool ?? data.target), args: data.args ?? {} },
        rememberable: false
      })
      this.pending.set(key, { type: 'approval', requestId: key, target: String(data.target ?? 'Action'), action: String(data.action ?? '{}') })
      this.seen.set(key, response)
      try {
        return { decision: await response }
      } finally {
        this.pending.delete(key)
      }
    }
    if (event === 'usage') run.emit('usage.updated', data)
    else if (event === 'file') run.emit('file.changed', data)
    else if (event === 'message') run.emit('message.completed', { messageId: data.id ?? randomUUID(), role: data.role ?? 'assistant', text: String(data.text) })
    else if (event === 'tool') {
      run.emit(data.phase === 'start' ? 'tool.started' : 'tool.completed', {
        toolCallId: String(data.id),
        name: String(data.name),
        ...(data.phase === 'start'
          ? { summary: String(data.summary ?? '') }
          : { ok: data.ok !== false, ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}), ...(typeof data.resultChars === 'number' ? { resultChars: data.resultChars } : {}) })
      })
    }
    return {}
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    this.delivery?.reject(new Error('The terminal stopped before prompt acknowledgement.'))
    this.delivery = null
    this.finish('interrupted')
  }
}
