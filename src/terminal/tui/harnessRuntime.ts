// The terminal frontend as a client of the harness (ADR-0083, phase 2). It runs no agent loop of its
// own: every turn is a `terminal.live.run` on the parent, which runs it as a live harness session.
// This process keeps what only draws: the model catalogue, the account's settings, the skills and
// prompts it lists, and a read of the conversation's history file. `session` is a mirror of the live
// Pi session, kept current from its native events, so the screen code is the same in both modes.
import {
  DefaultResourceLoader, ModelRuntime, resolveCliModel, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type AgentSessionEventListener, type AgentSessionServices
} from '@earendil-works/pi-coding-agent'
import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { claimTerminalControl, controlCall } from '../control'
import { SocketError } from '../client'
import { terminalCredentialStore } from '../credentialStore'
import { GoalController, type GoalState } from '../../sessions/goal'
import { GOAL_CUSTOM_TYPE } from '../../sessions/goal'
import { requiredSkillsText, type RequiredSkillText } from '../../prompt/compile'
import { bodyOf } from '../../core/frontmatter'
import { skillInvocations } from './skillInvocation'
import { pluginCommandPrefix } from '../../plugins/commandPrefix'
import type { ExtensionNotice } from '../../sessions/extensionUi'
import { clampLevel, supportedLevels } from './thinkingLevels'
import { ModeChoices, type ChoiceModel, type ChoiceStore, type ComposerMode } from './modeChoices'
import type { ModeChoice } from '../../accounts/choices'
import type { Effort } from '../../core/effort'
import type { SessionAccount } from '../accountsMenu'
import {
  assertTerminalHistoryPath, assertTerminalSessionScope, parseTerminalArguments,
  type TerminalDecision, type TerminalImage, type TerminalPermissionState, type TerminalRuntime, type TerminalRuntimeHost, type TerminalSnapshot
} from './runtime'

/**
 * The terminal's runtime (ADR-0083): this client of the harness by default; `inprocess` runs the
 * previous in-process Pi runtime, which keeps plugins' own terminal components.
 */
export const HARNESS_RUNTIME_ENV = 'XINGULAR_TERMINAL_RUNTIME'
export const harnessRuntimeSelected = (env: NodeJS.ProcessEnv = process.env): boolean => env[HARNESS_RUNTIME_ENV]?.trim().toLowerCase() !== 'inprocess'

type Message = { role?: string; content?: unknown; stopReason?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } }
interface LiveCommand { name: string; invocationName: string; description: string; sourceInfo: unknown }
interface LiveState {
  seq: number
  commands?: LiveCommand[]
  activeRunId: string | null
  live: { sessionFile: string | null; nativeSessionId: string; followUps: string[] } | null
  session: {
    sessionId: string; sessionFile: string | null; sessionName: string | null; systemPrompt?: string
    model: { id: string; provider: string } | null; thinkingLevel: string | null
    activeTools: string[]; tools: Array<{ name: string; description: string }>
    commands: Array<{ name: string; invocationName: string; description: string; sourceInfo: unknown }>
  } | null
}
type Journal = { seq: number; events: Array<{ seq: number; event: AgentSessionEvent }>; reset: boolean }

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

/** The native session id a history file carries in its header. */
function headerId(path: string): string | null {
  try {
    const header = JSON.parse(readFileSync(path, 'utf8').split('\n', 1)[0]) as { type?: string; id?: string }
    return header.type === 'session' && typeof header.id === 'string' ? header.id : null
  } catch {
    return null
  }
}

function textOf(message: Message | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return Array.isArray(message.content) ? message.content.map((part: { type?: string; text?: string }) => part.type === 'text' ? part.text ?? '' : '').join('') : ''
}

/** `XINGULAR_CLIENT_TRACE=<file>`: timestamped client events, for diagnosing a slow window. */
function trace(text: string): void {
  const file = process.env.XINGULAR_CLIENT_TRACE
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`)
  } catch {
    // Diagnostics only.
  }
}

export async function createHarnessTerminalRuntime(args: string[], host: TerminalRuntimeHost): Promise<TerminalRuntime> {
  const prepared = parseTerminalArguments(args)
  const cwd = realpathSync(process.cwd())
  const agentDirValue = process.env.PI_CODING_AGENT_DIR
  if (!agentDirValue || !isAbsolute(agentDirValue)) throw new Error('The Harness terminal requires its isolated account directory.')
  const agentDir = realpathSync(agentDirValue)
  const sessionDirectory = realpathSync(resolve(cwd, prepared.sessionDir))
  let sessionFile: string | null = prepared.session && existsSync(resolve(cwd, prepared.session)) ? resolve(cwd, prepared.session) : null
  if (sessionFile) {
    assertTerminalHistoryPath(sessionFile, sessionDirectory)
    assertTerminalSessionScope(sessionFile, cwd)
  }

  await claimTerminalControl()
  const identity = await controlCall<SessionAccount>('accounts.session').catch(() => null)
  const account = identity && typeof identity.accountId === 'string' && typeof identity.label === 'string'
    ? Object.freeze({ accountId: identity.accountId, label: identity.label }) : null
  // The catalogue and credential checks only: this process makes no model request.
  const modelRuntime = await ModelRuntime.create({ credentials: terminalCredentialStore(), modelsPath: join(agentDir, 'models.json') })
  const settingsManager = SettingsManager.create(cwd, agentDir)
  // Skills, prompts and themes to list and complete. Extensions run in the harness, never here.
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalSkillPaths: prepared.skills, additionalPromptTemplatePaths: prepared.prompts, additionalThemePaths: prepared.themes
  })
  await resourceLoader.reload()
  const services: AgentSessionServices = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] } as never

  const choiceStore: ChoiceStore = {
    read: () => controlCall<Record<string, ModeChoice>>('accounts.choices.get'),
    write: (mode, patch) => controlCall('accounts.choices.set', { mode, ...patch })
  }
  const modeChoices = new ModeChoices(choiceStore)
  await modeChoices.load()
  let currentMode: ComposerMode = 'normal'
  let planActive = false
  const recordingMode = (): ComposerMode => planActive ? 'plan' : currentMode
  const modelFor = (reference: string): ChoiceModel | undefined => resolveCliModel({ cliModel: reference, modelRuntime }).model
  /** A model this account can use: offered by its catalogue and holding credentials. Never a request. */
  const usableModel = async (reference: string): Promise<ChoiceModel | undefined> => {
    const found = modelFor(reference)
    return found && await modelRuntime.checkAuth(found.provider) ? found : undefined
  }
  const goal = new GoalController()

  const listeners = new Set<AgentSessionEventListener>()
  const changes = new Set<(session: AgentSession) => void | Promise<void>>()
  const beforeChanges = new Set<() => void>()
  let disposed = false
  let seq = 0
  let live: LiveState = { seq: 0, activeRunId: null, live: null, session: null }
  let manager: SessionManager | null = null
  let messages: Message[] = []
  const state: { messages: Message[]; streamingMessage?: Message; pendingToolCalls: Set<string> } = { messages, pendingToolCalls: new Set() }
  let streaming = false
  /** A mode switch made during a reply: the next reply starts on the new mode's choice. */
  let pendingApply = false
  let fresh = !sessionFile
  const steering: string[] = []
  const followUps: string[] = []
  const pendingNotes: Array<{ customType: string; content: string }> = []
  let model: ChoiceModel | undefined
  let thinkingLevel: AgentSession['thinkingLevel'] = 'medium' as never
  let sessionName: string | undefined
  const idleWaiters = new Set<() => void>()

  /** Reads the history file again: after a reply, a compaction, or a switch. */
  const reloadHistory = (): void => {
    manager = sessionFile ? SessionManager.open(sessionFile, sessionDirectory) : null
    messages = manager ? manager.buildSessionContext().messages as Message[] : []
    state.messages = messages
    sessionName = manager?.getSessionName() ?? sessionName
  }
  reloadHistory()

  // The model: an explicit launch model, then this conversation's own, then the account's latest choice.
  const startChoice = modeChoices.resolve('normal')
  const recorded = (): string | undefined => {
    const context = (manager as SessionManager | null)?.buildSessionContext() as unknown as { model?: { provider: string; modelId: string } } | undefined
    return context?.model ? `${context.model.provider}/${context.model.modelId}` : undefined
  }
  // The level Pi resolves when no mode has saved an effort: the model's own default, then the account's.
  const defaultEffort = (): AgentSession['thinkingLevel'] =>
    ((model ? settingsManager.getModelThinkingLevel(model.provider, model.id) : undefined) ?? settingsManager.getDefaultThinkingLevel() ?? 'medium') as AgentSession['thinkingLevel']
  const initial = prepared.model ?? recorded() ?? startChoice.model
  if (initial) model = modelFor(initial)
  thinkingLevel = (startChoice.effort ?? defaultEffort()) as never
  // A conversation written on another account (a switch resumes it) can name a model this account
  // cannot use. The account's own newest choice decides then; an explicit launch model is the host's.
  const stale = prepared.model ? undefined : recorded()
  let recovered: { recorded: string; reference: string; effort?: Effort } | null = null
  if (stale && !(await usableModel(stale).then(Boolean, () => true))) {
    const asSession = { get model() { return model }, setModel: async (next: ChoiceModel) => { model = next }, setThinkingLevel: (level: AgentSession['thinkingLevel']) => { thinkingLevel = level } }
    const applied = await modeChoices.useFallback(asSession, 'normal', usableModel, defaultEffort()).catch(() => null)
    if (applied) recovered = { recorded: stale, ...applied }
    // Nothing on this account is usable: name no model, so the harness picks one rather than the old account's.
    else model = undefined
  }

  const reference = (): string | null => model ? `${model.provider}/${model.id}` : null
  const lastAssistant = (): Message | undefined => [...messages].reverse().find((message) => message.role === 'assistant')

  const emit = (event: AgentSessionEvent): void => {
    for (const listener of listeners) listener(event)
    host.changed()
  }

  // A plugin's dialog, shown with this window's own dialogs as an in-process plugin's would be.
  type DialogRequest = { requestId: string; dialog: { kind: 'select' | 'confirm' | 'input' | 'editor'; title: string; message?: string; placeholder?: string; prefill?: string; options?: string[] } }
  const dialogs = new Map<string, AbortController>()
  const showDialog = async (request: DialogRequest): Promise<void> => {
    if (dialogs.has(request.requestId)) return
    const done = new AbortController()
    dialogs.set(request.requestId, done)
    const { dialog } = request
    try {
      const options = { signal: done.signal }
      let answer: { selected: string[]; text?: string }
      if (dialog.kind === 'select') {
        const chosen = await host.ui.select(dialog.title, dialog.options ?? [], options)
        answer = { selected: chosen === undefined ? [] : [chosen] }
      } else if (dialog.kind === 'confirm') {
        answer = { selected: [(await host.ui.confirm(dialog.title, dialog.message ?? '', options)) ? 'Yes' : 'No'] }
      } else {
        const text = dialog.kind === 'input' ? await host.ui.input(dialog.title, dialog.placeholder, options) : await host.ui.editor(dialog.title, dialog.prefill)
        answer = text === undefined ? { selected: [] } : { selected: [], text }
      }
      // Answered elsewhere first (another window or a phone): the first answer stands.
      if (done.signal.aborted) return
      await controlCall('terminal.live.answer', { requestId: request.requestId, answer }).catch(() => undefined)
    } finally {
      dialogs.delete(request.requestId)
    }
  }

  /** Applies one native event of the live session to the mirror, as Pi applies it to its own state. */
  const apply = (event: AgentSessionEvent): void => {
    // A harness run names its initial Bash `<run>:initial-bash`; the window draws `initial-bash:<run>`.
    const bash = event as unknown as { type: string; id?: string }
    if (bash.type === 'bash_execution_update' && bash.id?.endsWith(':initial-bash')) event = { ...event, id: `initial-bash:${bash.id.slice(0, -':initial-bash'.length)}` } as AgentSessionEvent
    const loose = event as unknown as { type: string; message?: Message; toolCallId?: string; steering?: string[]; followUp?: string[] }
    switch (loose.type) {
      case 'agent_start': streaming = true; break
      case 'message_update': if (loose.message?.role === 'assistant') state.streamingMessage = loose.message; break
      case 'message_end':
        if (loose.message) {
          if (state.streamingMessage && loose.message.role === 'assistant') state.streamingMessage = undefined
          messages.push(loose.message)
          if (loose.message.role === 'user' && steering.length) steering.shift()
        }
        break
      case 'tool_execution_start': if (loose.toolCallId) state.pendingToolCalls.add(loose.toolCallId); break
      case 'tool_execution_end': if (loose.toolCallId) state.pendingToolCalls.delete(loose.toolCallId); break
      case 'compaction_end': reloadHistory(); break
      case 'harness_settled': {
        const settled = event as unknown as { status: string; goalMode?: GoalState | null; sessionFile?: string | null }
        // The harness ran the goal: its rounds, time and status are the ones to show.
        if (settled.goalMode) goal.restore(settled.goalMode)
        // A new conversation's first reply made its file: this window resumes it from now on.
        if (!sessionFile && settled.sessionFile) {
          sessionFile = settled.sessionFile
          fresh = false
          reloadHistory()
        }
        // Pi's own settle came first, or never will: settle the mirror as Pi would have.
        if (streaming) apply({ type: 'agent_settled', aborted: settled.status === 'interrupted' } as never)
        host.changed()
        return
      }
      case 'harness_dialog': {
        void showDialog((event as unknown as { request: DialogRequest }).request)
        return
      }
      case 'harness_dialog_done': {
        dialogs.get((event as unknown as { requestId: string }).requestId)?.abort()
        return
      }
      case 'harness_notice': {
        // A plugin's notice, status line or widget, drawn by this window as an in-process plugin's would be.
        const notice = (event as unknown as { notice: ExtensionNotice }).notice
        if (notice.kind === 'notify' || notice.kind === 'error') host.ui.notify(notice.text, notice.kind === 'error' ? 'error' : notice.level ?? 'info')
        else if (notice.kind === 'status' && notice.key) host.ui.setStatus(notice.key, notice.text || undefined)
        else if (notice.kind === 'widget' && notice.key) host.ui.setWidget(notice.key, notice.text ? notice.text.split('\n') : undefined)
        else if (notice.kind === 'title') host.ui.setTitle(notice.text)
        host.changed()
        return
      }
      case 'agent_settled': {
        streaming = false
        if (pendingApply) {
          pendingApply = false
          void modeChoices.apply(session as never, currentMode, modelFor, defaultEffort()).then(() => host.changed())
        }
        state.streamingMessage = undefined
        state.pendingToolCalls.clear()
        steering.length = 0
        // The file is the record: it carries what the live session wrote, compaction included. A
        // new conversation learns its file from the next state read.
        if (sessionFile) reloadHistory()
        for (const wake of idleWaiters) wake()
        idleWaiters.clear()
        break
      }
    }
    emit(event)
  }

  // Bumped when the window switches conversation, so a state read that started before it is ignored.
  let generation = 0
  const refreshState = async (): Promise<void> => {
    const asked = generation
    const read = await controlCall<LiveState>('terminal.live.state')
    if (asked !== generation) return
    live = read
    if (live.live?.sessionFile && !sessionFile && !streaming) {
      sessionFile = live.live.sessionFile
      fresh = false
      reloadHistory()
      host.changed()
    }
    if (live.session?.sessionName) sessionName = live.session.sessionName
    followUps.splice(0, followUps.length, ...(live.live?.followUps ?? []))
  }
  await refreshState()
  seq = live.seq
  // Reattached while its reply kept running (ADR-0083): show it as running until it settles.
  if (live.activeRunId) streaming = true

  // Native events of the live session, read as they come. A gap means events were dropped: the mirror reads the file again.
  // Closing the window cancels the read that is waiting, so nothing keeps this process alive.
  const stopReading = new AbortController()
  let unreachable = 0
  const pump = async (): Promise<void> => {
    while (!disposed) {
      try {
        const read = await controlCall<Journal>('terminal.live.events', { after: seq }, 30_000, stopReading.signal)
        if (disposed) return
        if (read.reset) {
          reloadHistory()
          host.changed()
        }
        if (read.events.length) trace(`events ${read.events.length} last=${(read.events.at(-1)!.event as { type: string }).type}`)
        for (const entry of read.events) {
          seq = entry.seq
          apply(entry.event)
        }
        unreachable = 0
        if (!read.events.length) seq = Math.max(seq, read.seq)
        if (read.events.some((entry) => (entry.event as { type: string }).type === 'agent_settled' || (entry.event as { type: string }).type === 'agent_start')) await refreshState().catch(() => undefined)
      } catch (error) {
        if (disposed) return
        // The harness that ran this window is gone (it stopped or crashed): close cleanly.
        if (error instanceof SocketError && error.code === 'unavailable' && ++unreachable >= 2) {
          host.notify('The harness for this window stopped; closing.')
          host.shutdown()
          return
        }
        if (unreachable === 0) host.notify(`The harness session stream stopped: ${error instanceof Error ? error.message : String(error)}`)
        await new Promise((wait) => setTimeout(wait, 1000))
      }
    }
  }

  const requiredSkills = (text: string): Array<{ customType: string; content: string }> => {
    if (/^\s*!/u.test(text) || settingsManager.getEnableSkillCommands?.() === false) return []
    const skills = resourceLoader.getSkills().skills
    const names = skillInvocations(text, new Set(skills.map((skill) => skill.name)))
    if (!names.length) return []
    const entries: RequiredSkillText[] = names.map((name) => {
      const skill = skills.find((candidate) => candidate.name === name)!
      try {
        return { name, path: skill.filePath, baseDir: skill.baseDir, body: bodyOf(readFileSync(skill.filePath, 'utf8')) }
      } catch {
        return { name, path: skill.filePath, body: '' }
      }
    })
    const content = requiredSkillsText(entries)
    return content ? [{ customType: 'xingular-required-skills', content }] : []
  }

  const startRun = async (text: string, options: { images?: TerminalImage[]; plan?: boolean; command?: unknown; goal?: unknown; mode?: ComposerMode } = {}): Promise<void> => {
    if (disposed) throw new Error('The terminal runtime has closed.')
    const mode = options.mode ?? (options.plan ? 'plan' : currentMode)
    // A mode with no saved model or effort keeps the conversation's current one, as the in-process runtime does.
    const saved = mode === currentMode ? {} : modeChoices.resolve(mode)
    const choice = { model: (saved.model && modelFor(saved.model) ? saved.model : undefined) ?? reference() ?? undefined, effort: saved.effort ?? thinkingLevel }
    const notes = [...pendingNotes.splice(0), ...requiredSkills(text)]
    const bash = /^!\s*([\s\S]+)$/u.exec(text.trimStart())?.[1]
    trace(`run asked ${JSON.stringify(text.slice(0, 40))}`)
    streaming = true
    host.changed()
    try {
      await controlCall('terminal.live.run', {
        text,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(sessionFile ? { resume: { sessionFile, nativeSessionId: headerId(sessionFile) } } : { newHistory: fresh }),
        ...(options.images?.length ? { images: options.images.map((image) => ({ mediaType: image.mimeType, data: image.data })) } : {}),
        ...(options.plan ? { plan: true } : {}),
        ...(options.command ? { command: options.command } : {}),
        ...(options.goal ? { goal: options.goal } : {}),
        ...(bash && !options.plan ? { initialBashCommand: bash } : {}),
        ...(notes.length ? { hiddenNotes: notes } : {})
      }, 60_000)
    } catch (error) {
      streaming = false
      host.changed()
      throw error
    }
  }

  const setModel = async (next: ChoiceModel, options: { persist?: boolean } = {}): Promise<void> => {
    model = next
    // As Pi does: the new model runs at the nearest level it supports.
    thinkingLevel = clampLevel(next, thinkingLevel) as never
    if (options.persist !== false) await modeChoices.record(recordingMode(), { model: `${next.provider}/${next.id}` })
    host.changed()
  }
  const setThinkingLevel = (level: AgentSession['thinkingLevel'], options: { persist?: boolean } = {}): void => {
    thinkingLevel = clampLevel(model, level) as never
    if (options.persist !== false) void modeChoices.record(recordingMode(), { effort: thinkingLevel as Effort })
    host.changed()
  }
  const availableLevels = (): AgentSession['thinkingLevel'][] => supportedLevels(model) as never

  const commandsNow = (): LiveCommand[] => live.session?.commands ?? live.commands ?? []
  const extensionRunner = {
    getRegisteredCommands: () => commandsNow().map((command) => ({ ...command, sourceInfo: command.sourceInfo ?? { path: '', source: 'harness' } })),
    getCommand: (name: string) => {
      const command = commandsNow().find((entry) => entry.invocationName === name || entry.name === name)
      if (!command) return undefined
      // The harness's router takes a plugin command only by its owner-qualified route (ADR-0061).
      const route = `${pluginCommandPrefix((command.sourceInfo ?? { path: '' }) as never)}:${command.invocationName}`
      return { ...command, handler: async (argument: string) => { await startRun(`/${route}${argument ? ` ${argument}` : ''}`) } }
    },
    createCommandContext: () => ({}),
    createContext: () => ({}),
    createToolContext: () => ({}),
    getShortcuts: () => new Map(),
    getExtensionPaths: () => [],
    setUIContext: () => undefined,
    emitToolCall: async () => undefined
  }

  const session = {
    get sessionId() { return live.session?.sessionId ?? (sessionFile ? headerId(sessionFile) ?? '' : '') },
    get sessionFile() { return sessionFile ?? undefined },
    get sessionName() { return sessionName },
    setSessionName: (name: string) => {
      sessionName = name
      void controlCall('terminal.live.rename', { name, ...(sessionFile ? { sessionFile } : {}) }).catch((error) => host.notify(error instanceof Error ? error.message : String(error)))
      host.changed()
    },
    get messages() { return messages },
    get state() { return state },
    get model() { return model },
    get thinkingLevel() { return thinkingLevel },
    get isStreaming() { return streaming },
    get isIdle() { return !streaming },
    get systemPrompt() { return live.session?.systemPrompt ?? '' },
    get settingsManager() { return settingsManager },
    get resourceLoader() { return resourceLoader },
    get modelRuntime() { return modelRuntime },
    get sessionManager() { return manager ?? SessionManager.inMemory(cwd) },
    get extensionRunner() { return extensionRunner },
    get scopedModels() { return [] },
    get steeringMode() { return 'one-at-a-time' },
    get followUpMode() { return 'one-at-a-time' },
    get autoCompactionEnabled() { return settingsManager.getCompactionSettings().enabled },
    get autoRetryEnabled() { return true },
    setSteeringMode: () => undefined,
    setFollowUpMode: () => undefined,
    setAutoCompactionEnabled: (enabled: boolean) => settingsManager.setCompactionEnabled?.(enabled),
    setAutoRetryEnabled: () => undefined,
    supportsThinking: () => !!model?.reasoning,
    getAvailableThinkingLevels: availableLevels,
    cycleThinkingLevel: () => {
      const levels = availableLevels()
      const next = levels[(levels.indexOf(thinkingLevel) + 1) % levels.length]
      setThinkingLevel(next)
      return next
    },
    cycleModel: async () => undefined,
    setModel,
    setThinkingLevel,
    getActiveToolNames: () => live.session?.activeTools.length ? [...live.session.activeTools] : DEFAULT_TOOLS,
    getAllTools: () => live.session?.tools.length ? live.session.tools : DEFAULT_TOOLS.map((name) => ({ name, description: '' })),
    setActiveToolsByName: () => undefined,
    getToolDefinition: () => undefined,
    getSteeringMessages: () => [...steering],
    getFollowUpMessages: () => [...followUps],
    clearQueue: () => {
      const removed = { steering: [...steering], followUp: [...followUps] }
      steering.length = 0
      followUps.length = 0
      void controlCall('terminal.live.followUp.clear').catch(() => undefined)
      host.changed()
      return removed
    },
    getContextUsage: () => {
      const usage = lastAssistant()?.usage
      const window = model?.contextWindow ?? 0
      const tokens = usage ? (usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)) : null
      return { tokens, contextWindow: window, percent: tokens !== null && window ? tokens / window * 100 : null }
    },
    getSessionStats: () => {
      const assistant = messages.filter((message) => message.role === 'assistant')
      const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => assistant.reduce((total, message) => total + (message.usage?.[key] ?? 0), 0)
      return {
        sessionFile: sessionFile ?? undefined, sessionId: session.sessionId,
        userMessages: messages.filter((message) => message.role === 'user').length, assistantMessages: assistant.length,
        toolCalls: 0, toolResults: messages.filter((message) => message.role === 'toolResult').length, totalMessages: messages.length,
        tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), total: sum('input') + sum('output') + sum('cacheRead') + sum('cacheWrite') },
        cost: assistant.reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0)
      }
    },
    getLastAssistantText: () => textOf(lastAssistant()) || undefined,
    getUserMessagesForForking: () => (manager?.getEntries() ?? []).filter((entry) => entry.type === 'message' && (entry as { message?: Message }).message?.role === 'user')
      .map((entry) => ({ entryId: entry.id, text: textOf((entry as { message?: Message }).message) })),
    subscribe: (listener: AgentSessionEventListener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    prompt: async (text: string, options: { images?: TerminalImage[]; streamingBehavior?: 'steer' | 'followUp' } = {}) => {
      await runtime.submit(text, options.streamingBehavior === 'followUp', options.images)
    },
    sendCustomMessage: async (message: { customType: string; content: string }, options: { triggerTurn?: boolean; deliverAs?: string } = {}) => {
      if (options.deliverAs === 'steer' && streaming) {
        await controlCall('terminal.live.steer', { text: message.content })
        return
      }
      if (options.triggerTurn && message.customType === GOAL_CUSTOM_TYPE) {
        const current = goal.get()
        if (current) await startRun(current.objective, { goal: { objective: current.objective, rounds: current.limits.rounds, hours: current.limits.hours } })
        return
      }
      pendingNotes.push({ customType: message.customType.replace(/[^a-z0-9-]/g, '-').toLowerCase(), content: message.content })
    },
    abort: async () => { await runtime.interrupt() },
    abortBash: () => undefined,
    waitForIdle: async () => {
      if (!streaming) return
      await new Promise<void>((wake) => idleWaiters.add(wake))
    },
    compact: async (instructions?: string) => {
      if (!sessionFile) throw new Error('There is no saved conversation to compact yet.')
      await startRun('/compact', { command: { name: 'compact', ...(instructions ? { instructions } : {}) } })
    },
    navigateTree: async (targetId: string, options: { summarize?: boolean; customInstructions?: string } = {}) => {
      if (!sessionFile) return { cancelled: true }
      const entry = manager?.getEntries().find((candidate) => candidate.id === targetId) as { message?: Message } | undefined
      await startRun('/tree', { command: { name: 'navigate', entryId: targetId, summarize: !!options.summarize, ...(options.customInstructions ? { instructions: options.customInstructions } : {}) } })
      await session.waitForIdle()
      return { cancelled: false, ...(entry?.message?.role === 'user' ? { editorText: textOf(entry.message) } : {}) }
    },
    exportToHtml: async (path?: string) => {
      const target = path ? resolve(cwd, path) : join(cwd, `${basename(sessionFile ?? 'session', '.jsonl')}.html`)
      await startRun('/export', { command: { name: 'export', path: target } })
      return target
    },
    exportToJsonl: async (path: string) => {
      if (!sessionFile) throw new Error('There is no saved conversation to export yet.')
      copyFileSync(sessionFile, resolve(cwd, path))
      return resolve(cwd, path)
    },
    bindExtensions: async () => undefined,
    reload: async () => undefined,
    dispose: () => undefined
  }

  /**
   * Whether a reply really runs. The window learns that a reply ended from the event stream, a moment
   * after the harness knows; when the harness has no running reply, wait for the window to catch up.
   */
  const replying = async (): Promise<boolean> => {
    if (!streaming) return false
    await refreshState().catch(() => undefined)
    if (live.activeRunId) return true
    await Promise.race([
      new Promise<void>((wake) => idleWaiters.add(wake)),
      new Promise((wait) => setTimeout(wait, 2000))
    ])
    // The harness has nothing running: whatever the stream still owes, the reply is over.
    if (streaming) apply({ type: 'agent_settled', aborted: false } as never)
    return false
  }

  const announce = async (): Promise<void> => {
    for (const listener of changes) await listener(session as unknown as AgentSession)
    host.changed()
  }
  const replace = async (file: string | null): Promise<void> => {
    if (await replying()) throw new Error('Stop the current response before changing or reloading this session.')
    for (const listener of beforeChanges) listener()
    // The live session holds the old conversation; the next run opens the new one.
    generation += 1
    await controlCall('terminal.live.close', { forget: true }).catch(() => undefined)
    live = { ...live, live: null, session: null }
    sessionFile = file
    fresh = !file
    sessionName = undefined
    reloadHistory()
    await announce()
  }

  const runtime: TerminalRuntime = {
    async pending() {
      if (disposed) return []
      return (await controlCall<{ requests: TerminalDecision[] }>('terminal.live.pending')).requests
    },
    approve: async (requestId, decision, alwaysAllowTool = false) => { await controlCall('terminal.live.approve', { requestId, decision, alwaysAllow: alwaysAllowTool }) },
    permissions: async () => disposed ? { full: false, globalTools: [] } : controlCall<TerminalPermissionState>('terminal.permissions.get'),
    setFullPermission: async (enabled) => { await controlCall('terminal.permissions.setFull', { enabled }) },
    setGlobalTool: async (tool, allowed) => { await controlCall('terminal.permissions.setTool', { tool, allowed }) },
    answer: async (requestId, answer) => { await controlCall('terminal.live.answer', { requestId, answer }) },
    answerBatch: async (batchId, answers) => { await controlCall('terminal.live.answers', { batchId, answers }) },
    snapshot(): TerminalSnapshot {
      const usage = session.getContextUsage()
      return Object.freeze({
        sessionId: session.sessionId, sessionFile: sessionFile ?? undefined, name: sessionName, cwd, account,
        model: model ? Object.freeze({ id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }) : undefined,
        thinkingLevel, isStreaming: streaming, idle: !streaming,
        hasUserMessages: messages.some((message) => message.role === 'user'),
        hideThinking: settingsManager.getHideThinkingBlock(),
        context: Object.freeze({ percent: usage.percent, window: usage.contextWindow }),
        costUsd: session.getSessionStats().cost,
        subscription: model ? modelRuntime.isUsingSubscription(model.provider) : false,
        queue: Object.freeze({ steering: Object.freeze([...steering]), followUp: Object.freeze([...followUps]) })
      })
    },
    async submit(text, followUp = false, images) {
      if (disposed) throw new Error('The terminal runtime has closed.')
      const input = text.trimStart().startsWith('/') ? text.trimStart() : text
      if (await replying()) {
        if (followUp) {
          const result = await controlCall<{ queued?: number }>('terminal.live.followUp', { text: input })
          if (result.queued) followUps.push(input)
        } else {
          steering.push(input)
          await controlCall('terminal.live.steer', { text: input }).catch((error: unknown) => {
            steering.splice(steering.indexOf(input), 1)
            throw error
          })
        }
        host.changed()
        return
      }
      await startRun(input, { images })
    },
    async submitPlan(text, images) {
      if (!text.trim()) throw new Error('Use /plan <plan brief>.')
      if (await replying()) throw new Error('A plan request must wait until the current response settles.')
      // A one-shot plan from the normal composer: the window shows and runs the plan's choice, then returns.
      const previous = { model, effort: thinkingLevel }
      const oneShot = currentMode !== 'plan'
      if (oneShot) await modeChoices.apply(session as never, 'plan', modelFor, defaultEffort())
      planActive = true
      try {
        await startRun(text, { images, plan: true, mode: 'plan' })
        await session.waitForIdle()
      } finally {
        planActive = false
        if (oneShot && !disposed) {
          model = previous.model
          thinkingLevel = previous.effort
          if (pendingApply) {
            pendingApply = false
            await modeChoices.apply(session as never, currentMode, modelFor, defaultEffort())
          }
          host.changed()
        }
      }
    },
    async setMode(mode) {
      currentMode = mode
      // A switch during a reply waits for it to settle, so the reply keeps the model it started with.
      if (streaming) { pendingApply = true; return }
      await modeChoices.apply(session as never, mode, modelFor, defaultEffort())
      host.changed()
    },
    get session() { return session as unknown as AgentSession },
    get services() { return services },
    cwd, sessionDirectory,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    onSessionChange(listener) { changes.add(listener); return () => { changes.delete(listener) } },
    onBeforeSessionChange(listener) { beforeChanges.add(listener); return () => { beforeChanges.delete(listener) } },
    newSession: (async () => {
      await modeChoices.load()
      await replace(null)
      return { cancelled: false }
    }) as never,
    switchSession: (async (path: string, options?: { cwdOverride?: string }) => {
      // A conversation by its file, or by the session id its runs record.
      const named = resolve(cwd, path)
      const byId = (): string | undefined => readdirSync(sessionDirectory).filter((name) => name.endsWith('.jsonl')).map((name) => join(sessionDirectory, name)).find((file) => headerId(file) === path)
      const target = existsSync(named) ? named : byId() ?? named
      assertTerminalHistoryPath(target, sessionDirectory)
      assertTerminalSessionScope(target, cwd, options?.cwdOverride)
      await replace(target)
      return { cancelled: false }
    }) as never,
    fork: (async (entryId: string) => {
      if (!sessionFile) throw new Error('There is no saved conversation to fork yet.')
      // A fork writes a new file from the saved one; the live session's own file is not touched.
      const source = SessionManager.open(sessionFile, sessionDirectory)
      const entry = source.getEntries().find((candidate) => candidate.id === entryId) as { parentId?: string | null; message?: Message } | undefined
      const leaf = entry?.message?.role === 'user' ? entry.parentId ?? null : entryId
      const forked = leaf ? source.createBranchedSession(leaf) : undefined
      if (!forked) throw new Error('This conversation could not be forked at that message.')
      await replace(forked)
      return { cancelled: false, ...(entry?.message?.role === 'user' ? { selectedText: textOf(entry.message) } : {}) }
    }) as never,
    navigateTree: ((targetId: string, options?: { summarize?: boolean; customInstructions?: string }) => session.navigateTree(targetId, options)) as never,
    importFromJsonl: (async (path: string, cwdOverride?: string) => {
      const target = resolve(cwd, path)
      assertTerminalSessionScope(target, cwd, cwdOverride)
      const copy = join(sessionDirectory, basename(target))
      if (!existsSync(copy)) copyFileSync(target, copy)
      await replace(copy)
      return { cancelled: false }
    }) as never,
    installationDeviceId: () => controlCall<string>('accounts.deviceId'),
    reload: async () => {
      if (await replying()) throw new Error('Stop the current response before changing or reloading this session.')
      await controlCall('terminal.resources', {}, 30_000)
      // The next run opens a fresh live session that loads plugins again.
      await controlCall('terminal.live.close', { reload: true }).catch(() => undefined)
      await refreshState().catch(() => undefined)
      await resourceLoader.reload()
      await announce()
    },
    goal,
    async interrupt() {
      if (goal.active() && streaming) goal.pause()
      trace(`interrupt asked streaming=${streaming}`)
      await controlCall('terminal.live.interrupt', {}, 15_000).then((result) => trace(`interrupt answered ${JSON.stringify(result)}`)).catch((error: unknown) => trace(`interrupt failed ${String(error)}`))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      stopReading.abort()
      // The reply belongs to the harness: the parent ends it, or keeps it running for a reattach.
      for (const wake of idleWaiters) wake()
      for (const dialog of dialogs.values()) dialog.abort()
      listeners.clear()
      changes.clear()
      beforeChanges.clear()
    }
  }

  void pump()
  await announce()
  if (recovered) {
    const effort = recovered.effort ? ` at ${recovered.effort} effort` : ''
    host.notify(`This account cannot use ${recovered.recorded}. Started on ${recovered.reference}${effort}, your latest choice on this account.`)
  }
  return runtime
}
