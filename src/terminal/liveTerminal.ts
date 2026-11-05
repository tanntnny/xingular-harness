// The terminal as a client of the harness (ADR-0083, phase 2). The terminal frontend no longer runs
// Pi: each turn it sends is a `sessions.run { live: true }` of this terminal's conversation, and the
// frontend draws from the live session's native events and its own read of the history file.
// These are protected session-socket routes (INV-TUI-4): the account, folder, variant and caller come
// from preparation, never from the request.
import { randomUUID } from 'node:crypto'

import { HarnessError, invalid } from '../core/errors'
import type { CallerContext } from '../core/caller'
import type { VariantChoice } from '../variant/materialise'
import type { Launch } from '../prompt/compile'
import type { Effort } from '../core/effort'
import type { RunRegistry } from '../sessions/registry'
import { loadRun, recordedSubagents } from '../sessions/runStore'
import { LiveDecisions } from '../sessions/liveDecisions'
import type { SessionRunInput, Sessions } from '../sessions/sessions'
import type { SessionCommand } from '../sessions/runner'
import { rename as renameHistory } from '../sessions/control'

/** Pi's own tools a terminal session has active, as the in-process terminal has them. */
export const TERMINAL_NATIVE_TOOLS = ['read', 'bash', 'edit', 'write']
/** Native events kept for a client that reads late; older ones are dropped and the client resyncs. */
const JOURNAL = 4000
const WAIT_MS = 20_000

export interface LiveTerminalContext {
  sessionId: string
  root: string
  accountId: string
  cwd: string
  sessionDir: string
  caller: CallerContext
  variant: VariantChoice | null
  launch: Launch | undefined
  connections: boolean
  readOnly: boolean
  /** The terminal's subagent options; null switches them off. */
  subagents?: SessionRunInput['subagents']
  /** Always allow a tool for every session of this profile, as the terminal's own approvals do. */
  allowTool(target: string): void
  /** The session's other tools, as terminal preparation lists them: launch and switched-on world tools. */
  tools?(): Promise<string[]>
  /** The plugin commands the session's trusted extensions register, for the palette before the first turn. */
  commands?(): Promise<LiveCommand[]>
}

interface Journaled { seq: number; event: unknown }

/** A plugin command as Pi's extension runner lists it, with what its owner prefix is derived from. */
export interface LiveCommand { name: string; invocationName: string; description: string; sourceInfo: unknown }

/** Pi's names for the commands of loaded extensions: a name two extensions share gets `:2`, `:3`. */
export function registeredCommands(extensions: ReadonlyArray<{ commands: Map<string, { name: string; description?: string; sourceInfo?: unknown }>; sourceInfo?: unknown }>): LiveCommand[] {
  const all = extensions.flatMap((extension) => [...extension.commands.values()].map((command) => ({ command, source: command.sourceInfo ?? extension.sourceInfo })))
  const counts = new Map<string, number>()
  for (const { command } of all) counts.set(command.name, (counts.get(command.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  const taken = new Set<string>()
  return all.map(({ command, source }) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1
    seen.set(command.name, occurrence)
    let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name
    let suffix = occurrence
    while (taken.has(invocationName)) invocationName = `${command.name}:${++suffix}`
    taken.add(invocationName)
    return { name: command.name, invocationName, description: command.description ?? '', sourceInfo: source ?? null }
  })
}

export class LiveTerminal {
  private readonly journal: Journaled[] = []
  private seq = 0
  private readonly waiters = new Set<() => void>()
  /** The decisions waiting for this terminal's reply and its subagents; a pairing on this session shares them. */
  readonly decisions: LiveDecisions
  private activeRunId: string | null = null
  private activeRunStartedAt: number | null = null
  private lastRunId: string | null = null
  private readonly stops: Array<() => void> = []
  private disposed = false
  private readonly settledListeners = new Set<() => void>()

  constructor(private readonly context: LiveTerminalContext, private readonly sessions: Sessions, private readonly runs: RunRegistry) {
    this.decisions = new LiveDecisions({ root: context.root, runs, activeRun: () => this.activeRunId, allowTool: (target) => context.allowTool(target) })
    this.stops.push(sessions.live.watch(context.sessionId, (event) => this.append(event)))
    this.stops.push(runs.listen((event) => {
      // A follow-up the harness started after the last reply is this terminal's reply now.
      const liveActive = sessions.live.status(context.sessionId)?.activeRunId ?? null
      if (liveActive && liveActive === event.runId && this.activeRunId !== liveActive) this.started(liveActive)
      if (event.runId !== this.activeRunId && !this.isOwnChild(event.runId)) return
      this.decisions.observe(event)
      // A plugin's dialog is shown by the window itself; its question stays answerable from anywhere.
      if (event.type === 'question.requested' && (event.payload as { dialog?: unknown }).dialog) {
        this.append({ type: 'harness_dialog', runId: event.runId, request: { ...(event.payload as Record<string, unknown>), requestId: (event.payload as { questionId: string }).questionId } })
      }
      if (event.type === 'question.answered') this.append({ type: 'harness_dialog_done', requestId: (event.payload as { questionId: string }).questionId })
      // What a plugin shows (a notice, a status line, a widget) reaches the window with the reply's own events.
      if (event.type === 'extension.notice') this.append({ type: 'harness_notice', notice: event.payload })
      // A reply that fails says why in the window, as an in-process prompt's error does.
      if (event.type === 'failed' && event.runId === this.activeRunId) {
        const message = (event.payload as { message?: unknown }).message
        if (typeof message === 'string' && message) this.append({ type: 'harness_notice', notice: { kind: 'error', text: message } })
      }
      const ended = event.type === 'completed' || event.type === 'failed' || (event.type === 'status.changed' && (event.payload as { status?: string }).status === 'interrupted')
      if (ended && event.runId === this.activeRunId) {
        // The window learns that the reply is over even when Pi's loop never started (a command that failed).
        // A goal run says where its goal stands, so the window's /goal shows the harness's own state.
        let goalMode: unknown = null
        try {
          goalMode = loadRun(this.context.root, event.runId).goalMode ?? null
        } catch {
          // No record to read.
        }
        const live = this.sessions.live.status(this.context.sessionId)
        this.append({ type: 'harness_settled', runId: event.runId, status: event.type === 'completed' ? 'completed' : event.type === 'failed' ? 'failed' : 'interrupted', goalMode, sessionFile: live?.sessionFile ?? null, nativeSessionId: live?.nativeSessionId ?? null })
        this.activeRunId = null
        this.decisions.bump()
        // A follow-up the harness queued starts in the same turn of the event loop; settle after it.
        setImmediate(() => {
          if (this.activeRunId || this.disposed) return
          for (const settled of this.settledListeners) settled()
        })
      }
    }))
  }

  /** The subagents of the active reply: their approvals and questions are this terminal's too. */
  private children(): string[] {
    if (!this.activeRunId) return []
    try {
      return recordedSubagents(this.context.root, this.activeRunId)
    } catch {
      return []
    }
  }

  private isOwnChild(runId: string): boolean {
    return this.children().includes(runId)
  }

  private append(event: unknown): void {
    const type = (event as { type?: string } | null)?.type
    const last = this.journal.at(-1)
    // A streaming update carries the whole message so far, so a newer one replaces one not yet read.
    if (type === 'message_update' && (last?.event as { type?: string } | undefined)?.type === 'message_update') this.journal.pop()
    this.journal.push({ seq: ++this.seq, event })
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    for (const wake of this.waiters) wake()
  }

  private async wait(set: Set<() => void>, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const wake = (): void => { clearTimeout(timer); set.delete(wake); resolve() }
      const timer = setTimeout(wake, ms)
      timer.unref?.()
      set.add(wake)
    })
  }

  private known: { nativeSessionId: string | null; sessionFile: string | null } = { nativeSessionId: null, sessionFile: null }

  /** Pi's id of this terminal's conversation, as its harness runs record it. */
  get nativeSessionId(): string | null {
    const live = this.sessions.live.status(this.context.sessionId)
    if (live) this.known = { nativeSessionId: live.nativeSessionId, sessionFile: live.sessionFile ?? this.known.sessionFile }
    return this.known.nativeSessionId
  }

  /** The history file of this terminal's conversation, once it has one. */
  get sessionFile(): string | null {
    void this.nativeSessionId
    return this.known.sessionFile
  }

  /** The reply running now, if one is. */
  get activeRun(): string | null {
    return this.activeRunId
  }

  /** Called each time the terminal's replies have all settled and nothing else is queued. */
  onSettled(listener: () => void): () => void {
    this.settledListeners.add(listener)
    return () => { this.settledListeners.delete(listener) }
  }

  /** The run this terminal is showing, or the last one it finished. */
  get lastRun(): string | null {
    return this.activeRunId ?? this.lastRunId
  }

  async call(call: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new HarnessError('run_not_active', 'This terminal session has closed.')
    switch (call) {
      case 'terminal.live.state': return this.state()
      case 'terminal.live.events': return this.events(params)
      case 'terminal.live.run': return this.run(params)
      case 'terminal.live.steer': {
        const text = this.text(params)
        if (!this.activeRunId) throw new HarnessError('run_not_active', 'No reply is running to steer.')
        await this.runs.steer(this.activeRunId, text)
        return { runId: this.activeRunId }
      }
      case 'terminal.live.followUp': {
        const result = await this.sessions.followUp(this.context.sessionId, this.text(params))
        if ('runId' in result) this.started(result.runId)
        return result
      }
      case 'terminal.live.followUp.clear': return { removed: this.sessions.live.clearQueue(this.context.sessionId) }
      case 'terminal.live.interrupt': {
        // The run is stopped and recorded at once; Pi's own abort finishes after the reply returns, so
        // the window never waits on a provider stream that is slow to close.
        return this.decisions.interrupt()
      }
      case 'terminal.live.close': {
        void this.nativeSessionId
        // A new or switched conversation: what this terminal knows comes from its next run.
        if (params.forget === true) this.known = { nativeSessionId: null, sessionFile: null }
        if (params.reload === true) this.listed = null
        return this.sessions.closeLive(this.context.sessionId)
      }
      case 'terminal.live.rename': {
        const name = this.text(params).trim().slice(0, 200)
        // The live session writes its own history; a saved one is renamed in place.
        const session = this.sessions.live.session(this.context.sessionId)
        if (session?.setSessionName && !this.activeRunId) {
          session.setSessionName(name)
          return { name }
        }
        if (this.activeRunId) throw new HarnessError('session_busy', 'Rename the conversation after the reply settles.')
        const file = typeof params.sessionFile === 'string' ? params.sessionFile : undefined
        return renameHistory({ sessionDir: this.context.sessionDir, ...(file ? { sessionFile: file } : {}), cwd: this.context.cwd, name })
      }
      case 'terminal.live.pending': return this.decisions.snapshot(params.ownDialogs === true)
      case 'terminal.live.pending.wait': return this.decisions.wait(params.revision, params.ownDialogs === true)
      case 'terminal.live.approve': return this.decisions.approve(params)
      case 'terminal.live.answer': return this.decisions.answer(params)
      case 'terminal.live.answers': return this.decisions.answers(params)
      default: throw invalid(`Unknown live terminal operation ${call}.`)
    }
  }

  private text(params: Record<string, unknown>): string {
    if (typeof params.text !== 'string' || !params.text.trim()) throw invalid('Text is required.')
    return params.text
  }

  private listed: Promise<LiveCommand[]> | null = null

  private async state(): Promise<Record<string, unknown>> {
    const live = this.sessions.live.status(this.context.sessionId)
    const session = this.sessions.live.session(this.context.sessionId) as unknown as LiveSessionView | null
    const view = session ? sessionView(session) : null
    // Before the first turn there is no live session to ask; the trusted extensions are listed instead.
    const commands = view ? view.commands : await (this.listed ??= (this.context.commands?.() ?? Promise.resolve([])).catch((error: unknown) => {
      this.listed = null
      throw error
    }))
    return {
      seq: this.seq,
      activeRunId: this.activeRunId,
      activeRunStartedAt: this.activeRunId ? this.activeRunStartedAt : null,
      lastRunId: this.lastRunId,
      live,
      session: view,
      commands
    }
  }

  private async events(params: Record<string, unknown>): Promise<{ seq: number; events: Journaled[]; reset: boolean }> {
    const after = typeof params.after === 'number' && Number.isFinite(params.after) ? params.after : 0
    const read = (): { seq: number; events: Journaled[]; reset: boolean } => {
      const first = this.journal[0]?.seq ?? this.seq + 1
      // Events the client missed were dropped: it must read the session again.
      const reset = after > 0 && after < first - 1
      return { seq: this.seq, events: this.journal.filter((entry) => entry.seq > after), reset }
    }
    let result = read()
    if (!result.events.length && params.wait !== false) {
      await this.wait(this.waiters, typeof params.waitMs === 'number' ? Math.min(Math.max(params.waitMs, 0), WAIT_MS) : WAIT_MS)
      result = read()
    }
    return result
  }

  private started(runId: string): void {
    if (this.activeRunId !== runId) this.activeRunStartedAt = Date.now()
    this.activeRunId = runId
    this.lastRunId = runId
    this.decisions.bump()
  }

  private async run(params: Record<string, unknown>): Promise<{ runId: string; nativeSessionId: string | null }> {
    const { context } = this
    if (this.activeRunId) throw new HarnessError('session_busy', 'A reply is running. Steer it, or queue the message as a follow-up.')
    const text = typeof params.text === 'string' ? params.text : ''
    const command = params.command as SessionCommand | undefined
    if (!text.trim() && !command) throw invalid('Text is required.')
    const images = Array.isArray(params.images) ? params.images.filter((image): image is { mediaType: string; data: string } =>
      !!image && typeof (image as { mediaType?: unknown }).mediaType === 'string' && typeof (image as { data?: unknown }).data === 'string') : undefined
    const resume = params.resume && typeof params.resume === 'object'
      ? { sessionFile: typeof (params.resume as { sessionFile?: unknown }).sessionFile === 'string' ? (params.resume as { sessionFile: string }).sessionFile : null,
          nativeSessionId: typeof (params.resume as { nativeSessionId?: unknown }).nativeSessionId === 'string' ? (params.resume as { nativeSessionId: string }).nativeSessionId : null }
      : null
    const runId = randomUUID()
    const native = context.readOnly ? TERMINAL_NATIVE_TOOLS.filter((name) => !['bash', 'edit', 'write'].includes(name)) : TERMINAL_NATIVE_TOOLS
    const allow = [...new Set([...native, ...(await context.tools?.() ?? [])])]
    const input: SessionRunInput = {
      run: { id: runId, sessionId: context.sessionId, sessionType: 'terminal', mode: 'code' },
      accountId: context.accountId,
      model: typeof params.model === 'string' ? params.model : null,
      effort: typeof params.effort === 'string' ? params.effort as Effort : null,
      cwd: context.cwd,
      sessionDir: context.sessionDir,
      ...(resume?.sessionFile ? { resume } : {}),
      ...(params.newHistory === true && !resume?.sessionFile ? { newHistory: true } : {}),
      text: command ? `/${command.name}` : text,
      ...(images?.length ? { images } : {}),
      ...(typeof params.initialBashCommand === 'string' ? { initialBashCommand: params.initialBashCommand } : {}),
      caller: context.caller,
      variant: context.variant,
      launch: context.launch,
      tools: { allow, gated: [] },
      connections: context.connections,
      ...(context.subagents !== undefined ? { subagents: context.subagents } : {}),
      // The terminal sends a plan only the tools it may use, as the in-process terminal does.
      ...(params.plan === true ? { plan: true, planTools: 'active' as const } : {}),
      ...(params.goal && typeof params.goal === 'object' ? { goal: params.goal as SessionRunInput['goal'] } : {}),
      ...(Array.isArray(params.hiddenNotes) && params.hiddenNotes.length ? { hiddenNotes: params.hiddenNotes as SessionRunInput['hiddenNotes'] } : {}),
      ...(command ? { command } : { live: true })
    }
    this.started(runId)
    try {
      const result = await this.sessions.run(input)
      if (!result.nativeSessionId) this.activeRunId = null
      return result
    } catch (error) {
      this.activeRunId = null
      this.decisions.bump()
      throw error
    }
  }

  /** A message from another surface of this terminal (remote control): a new reply, or a follow-up. */
  async send(text: string): Promise<{ runId: string } | { queued: number }> {
    if (this.activeRunId) return this.sessions.followUp(this.context.sessionId, text)
    const state = this.sessions.live.status(this.context.sessionId)
    const result = await this.run({ text, ...(state?.sessionFile ? { resume: { sessionFile: state.sessionFile, nativeSessionId: state.nativeSessionId } } : {}) })
    return { runId: (result as { runId: string }).runId }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.activeRunId) await this.runs.interrupt(this.activeRunId).catch(() => undefined)
    for (const stop of this.stops.splice(0)) stop()
    this.sessions.closeLive(this.context.sessionId)
    this.decisions.dispose()
    for (const wake of [...this.waiters]) wake()
  }
}

/** The parts of Pi's `AgentSession` a terminal draws, read from the live session. */
interface LiveSessionView {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  systemPrompt?: string
  model?: { id: string; provider: string; name?: string; reasoning?: boolean; contextWindow?: number; input?: string[] }
  thinkingLevel?: string
  isStreaming?: boolean
  getActiveToolNames?(): string[]
  getAllTools?(): Array<{ name: string; description?: string }>
  getSteeringMessages?(): readonly string[]
  getFollowUpMessages?(): readonly string[]
  getContextUsage?(): { percent?: number | null; contextWindow?: number; tokens?: number } | undefined
  extensionRunner?: { getRegisteredCommands(): Array<{ name: string; invocationName?: string; description?: string; sourceInfo?: unknown }> }
}

function sessionView(session: LiveSessionView): Record<string, unknown> {
  const commands = (() => {
    try {
      return (session.extensionRunner?.getRegisteredCommands() ?? []).map((command) => ({
        name: command.name,
        invocationName: command.invocationName ?? command.name,
        description: command.description ?? '',
        sourceInfo: command.sourceInfo ?? null
      }))
    } catch {
      return []
    }
  })()
  const usage = (() => {
    try {
      return session.getContextUsage?.() ?? null
    } catch {
      return null
    }
  })()
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? null,
    sessionName: session.sessionName ?? null,
    systemPrompt: session.systemPrompt ?? '',
    model: session.model ? { id: session.model.id, provider: session.model.provider, name: session.model.name ?? session.model.id, reasoning: !!session.model.reasoning, contextWindow: session.model.contextWindow ?? 0, input: session.model.input ?? ['text'] } : null,
    thinkingLevel: session.thinkingLevel ?? null,
    isStreaming: !!session.isStreaming,
    activeTools: session.getActiveToolNames?.() ?? [],
    tools: (session.getAllTools?.() ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
    steering: [...(session.getSteeringMessages?.() ?? [])],
    followUp: [...(session.getFollowUpMessages?.() ?? [])],
    context: usage ? { percent: usage.percent ?? null, window: usage.contextWindow ?? 0 } : null,
    commands
  }
}
