// One `pi` command running in a terminal, as the harness sees it. The terminal itself belongs
// to whoever embeds the harness; this follows the native process through its extension's
// telemetry (never by reading the screen), turns each native turn into a run, and answers the
// extension's questions about policy, approvals, and what to do next.
import { createHash, randomUUID } from 'node:crypto'

import { HarnessError } from '../core/errors'
import type { ActiveRun, ApprovalDecision, QuestionAnswer } from '../sessions/registry'

export interface PolicyReply {
  allowed: boolean
  reason?: string | null
  requiresApproval?: boolean
}

export interface ControllerHooks {
  sessionId: string
  nativeSessionId: string | null
  /** Reserves or creates the run for a native turn and starts tracking it. */
  begin(input: { reservedRunId: string | null; nativeTurnId: string; text: string }): ActiveRun
  /** Whether a native tool call may run. */
  policy(run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply>
  /** The native conversation identity changed. */
  native(nativeSessionId: string): void
  telemetry(event: string): void
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
      this.begin(String(data.turnId ?? randomUUID()), String(data.text ?? ''))
      return {}
    }
    if (event === 'shutdown') {
      this.ready = false
      this.finish('interrupted')
      return {}
    }
    if (event === 'settled') {
      this.finish(data.error ? 'failed' : 'completed', data.error ? String(data.error) : undefined)
      return {}
    }
    const run = this.run
    if (!run) throw new Error('Native telemetry arrived without an active turn.')
    if (event === 'policy') return this.hooks.policy(run, String(data.tool), data.args ?? {})
    if (event === 'approval' || event === 'question') {
      const key = this.requestId(String(data.requestId ?? JSON.stringify(data)))
      const existing = this.seen.get(key)
      if (existing) return event === 'approval' ? { decision: await existing } : existing
      if (event === 'question') {
        const response: Promise<QuestionAnswer> = run.requestAnswer({ requestId: key, question: String(data.question ?? ''), options: data.options ?? [], multiSelect: !!data.multiSelect, allowText: true })
        this.seen.set(key, response)
        return response
      }
      const response: Promise<ApprovalDecision> = run.requestApproval({
        requestId: key,
        target: String(data.target ?? 'Native action'),
        action: String(data.action ?? '{}'),
        operation: { tool: String(data.tool ?? data.target), args: data.args ?? {} },
        rememberable: false
      })
      this.seen.set(key, response)
      return { decision: await response }
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
