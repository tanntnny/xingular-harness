import {
  createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, resolveCliModel,
  SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEventListener, type AgentSessionRuntime, type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory, type ExtensionUIContext, type SessionEntry
} from '@earendil-works/pi-coding-agent'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import terminalExtension, { type TerminalPlanRunState } from '../piExtension'
import { terminalCredentialStore } from '../credentialStore'
import { normalModeTools, normalToolsForBranch, planModeTools, PLAN_TOOLS_ENTRY, QUESTION_TOOL_NAMES } from './planMode'
import { claimTerminalControl, controlCall } from '../control'
import { observeProviderResponses } from '../../usage/limits/capture'
import { limitHeaders } from '../../usage/limits/normalize'
import { loadPiAdapter } from './piAdapter'
import { loadPi } from '../../pi/runtime'
import { wrapPromptLoader } from '../../commands/promptLoader'
import { applyExtensionOwners } from '../../commands/extensionOwners'
import { installPluginCommandRouter } from '../../commands/runtimeRouter'
import { pluginCommandPrefix } from '../../plugins/commandPrefix'
import type { Found } from '../../plugins/discover'
import type { SessionAccount } from '../accountsMenu'
import type { QuestionAnswer } from '../../sessions/registry'
import type { TerminalQuestion } from './questions'
import { sessionUiContext } from './sessionUi'
import { ModeChoices, type ChoiceModel, type ChoiceStore, type ComposerMode } from './modeChoices'
import type { ModeChoice } from '../../accounts/choices'
import type { Effort } from '../../core/effort'

export interface TerminalArguments {
  appendSystemPrompt: string[]
  extensions: string[]
  skills: string[]
  prompts: string[]
  themes: string[]
  sessionDir: string
  session?: string
  model?: string
}

/** The launch specification comes from Terminals.prepare(), never from Pi's own discovery. */
export function parseTerminalArguments(args: string[]): TerminalArguments {
  const result: TerminalArguments = { appendSystemPrompt: [], extensions: [], skills: [], prompts: [], themes: [], sessionDir: '' }
  const lists: Record<string, string[]> = {
    '--append-system-prompt': result.appendSystemPrompt, '--extension': result.extensions,
    '--skill': result.skills, '--prompt-template': result.prompts, '--theme': result.themes
  }
  const flags = new Set(['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'])
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (flags.has(argument)) continue
    if (!(argument in lists) && !['--session-dir', '--session', '--model'].includes(argument)) {
      throw new Error(`Unsupported prepared terminal argument: ${argument}`)
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`)
    if (argument in lists) lists[argument].push(value)
    else if (argument === '--session-dir') result.sessionDir = value
    else if (argument === '--session') result.session = value
    else result.model = value
  }
  if (!result.sessionDir) throw new Error('The Harness terminal requires its prepared --session-dir.')
  if (!result.extensions.length) throw new Error('The Harness terminal requires its prepared bridge extension.')
  return result
}

export interface TerminalRuntimeHost {
  ui: ExtensionUIContext
  shutdown(): void
  notify(message: string): void
  changed(): void
  resources?(services: AgentSessionServices): void
}

type SessionChangeListener = (session: AgentSession) => void | Promise<void>
type NewOptions = Parameters<AgentSessionRuntime['newSession']>[0]
type SwitchOptions = Parameters<AgentSessionRuntime['switchSession']>[1]
type ForkOptions = Parameters<AgentSessionRuntime['fork']>[1]
type TreeOptions = Parameters<AgentSession['navigateTree']>[1]

export interface TerminalSnapshot {
  readonly sessionId: string
  readonly sessionFile?: string
  readonly name?: string
  readonly cwd: string
  readonly account: Readonly<SessionAccount> | null
  readonly model?: Readonly<{ id: string; provider: string; name: string; reasoning: boolean; contextWindow: number }>
  readonly thinkingLevel: AgentSession['thinkingLevel']
  readonly isStreaming: boolean
  readonly idle: boolean
  readonly hasUserMessages: boolean
  readonly hideThinking: boolean
  readonly context: Readonly<{ percent: number | null; window: number }>
  readonly costUsd: number
  readonly subscription: boolean
  readonly queue: Readonly<{ steering: readonly string[]; followUp: readonly string[] }>
}

export interface TerminalDecision extends TerminalQuestion { type: 'approval' | 'question'; target?: string; action?: string; rememberable?: boolean }

export interface TerminalPermissionState {
  readonly full: boolean
  readonly globalTools: readonly string[]
}

/** An image the user attached to a prompt, as Pi sends it to the model. */
export interface TerminalImage { type: 'image'; data: string; mimeType: string }

export interface TerminalRuntime {
  pending(): Promise<TerminalDecision[]>
  approve(requestId: string, decision: 'approved' | 'denied', alwaysAllowTool?: boolean): Promise<void>
  permissions(): Promise<TerminalPermissionState>
  setFullPermission(enabled: boolean): Promise<void>
  setGlobalTool(tool: string, allowed: boolean): Promise<void>
  answer(requestId: string, answer: QuestionAnswer): Promise<void>
  answerBatch(batchId: string, answers: Array<{ questionId: string; answer: QuestionAnswer }>): Promise<void>
  snapshot(): TerminalSnapshot
  /** Images go to the model in the same user message as `text`. */
  submit(text: string, followUp?: boolean, images?: TerminalImage[]): Promise<void>
  submitPlan(text: string, images?: TerminalImage[]): Promise<void>
  /** The composer's mode. Its saved model and effort apply now, or when a running turn settles. */
  setMode(mode: ComposerMode): Promise<void>
  readonly session: AgentSession
  readonly services: AgentSessionServices
  readonly cwd: string
  readonly sessionDirectory: string
  subscribe(listener: AgentSessionEventListener): () => void
  onSessionChange(listener: SessionChangeListener): () => void
  onBeforeSessionChange(listener: () => void): () => void
  newSession(options?: NewOptions): ReturnType<AgentSessionRuntime['newSession']>
  switchSession(path: string, options?: SwitchOptions): ReturnType<AgentSessionRuntime['switchSession']>
  fork(entryId: string, options?: ForkOptions): ReturnType<AgentSessionRuntime['fork']>
  navigateTree(targetId: string, options?: TreeOptions): ReturnType<AgentSession['navigateTree']>
  importFromJsonl(path: string, cwdOverride?: string): ReturnType<AgentSessionRuntime['importFromJsonl']>
  installationDeviceId(): Promise<string>
  reload(): Promise<void>
  interrupt(): Promise<void>
  dispose(): Promise<void>
}

/** Saved native history stays in the prepared project folder, including symlink targets. */
export function assertTerminalHistoryPath(path: string, sessionDirectory: string): void {
  const within = relative(realpathSync(sessionDirectory), realpathSync(path))
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error('Resume only from this terminal history folder. Use /import for another native session file in this working folder.')
  }
}

/** Inspect the header before any native switch/import can invalidate a session or copy a file. */
export function assertTerminalSessionScope(path: string, cwd: string, cwdOverride?: string): void {
  if (cwdOverride !== undefined && realpathSync(resolve(cwdOverride)) !== realpathSync(cwd)) {
    throw new Error('Resume this conversation in a terminal opened for its own working folder.')
  }
  const descriptor = openSync(path, 'r')
  let first: string
  try {
    const buffer = Buffer.alloc(65_536)
    const size = readSync(descriptor, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')
    const newline = text.indexOf('\n')
    if (newline === -1 && size === buffer.length) throw new Error('The native session header is too large.')
    first = newline === -1 ? text : text.slice(0, newline)
  } finally {
    closeSync(descriptor)
  }
  let header: { type?: string; cwd?: string }
  try {
    header = JSON.parse(first) as typeof header
  } catch {
    throw new Error('This file does not have a readable native session header.')
  }
  if (header.type !== 'session' || !header.cwd || !isAbsolute(header.cwd)) {
    throw new Error('The native session must record its original absolute working folder.')
  }
  if (realpathSync(header.cwd) !== realpathSync(cwd)) {
    throw new Error('This conversation belongs to another working folder. Open its terminal to keep project permissions and context isolated.')
  }
}

/**
 * The model a conversation's own history names: the last model change, else the model that answered
 * last. A conversation with no message yet has nothing to continue and names nothing.
 */
function recordedModel(branch: SessionEntry[]): { provider: string; modelId: string } | undefined {
  if (!branch.some(entry => entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant'))) return undefined
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry.type === 'model_change') return { provider: entry.provider, modelId: entry.modelId }
    // A routed virtual response names the physical model that answered it, not the selection.
    if (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.api !== 'pi-virtual') {
      return { provider: entry.message.provider, modelId: entry.message.model }
    }
  }
  return undefined
}

export async function createTerminalRuntime(args: string[], host: TerminalRuntimeHost): Promise<TerminalRuntime> {
  const prepared = parseTerminalArguments(args)
  const cwd = realpathSync(process.cwd())
  const agentDirValue = process.env.PI_CODING_AGENT_DIR
  if (!agentDirValue || !isAbsolute(agentDirValue)) throw new Error('The Harness terminal requires its isolated account directory.')
  const agentDir = realpathSync(agentDirValue)
  const sessionDirectory = realpathSync(resolve(cwd, prepared.sessionDir))
  // Pi writes a session file only after its first message, so a restart before that has nothing to resume.
  const resume = prepared.session && existsSync(resolve(cwd, prepared.session)) ? resolve(cwd, prepared.session) : null
  if (resume) {
    assertTerminalHistoryPath(resume, sessionDirectory)
    assertTerminalSessionScope(resume, cwd)
  }

  const pi = await loadPi()
  // Claim before loading any plugin code and retain it in the trusted process across reloads.
  await claimTerminalControl()
  const identity = await controlCall<SessionAccount>('accounts.session').catch(() => null)
  const account = identity && typeof identity.accountId === 'string' && typeof identity.label === 'string'
    ? Object.freeze({ accountId: identity.accountId, label: identity.label }) : null
  await loadPiAdapter()
  // Credentials live in the host's store, read and refreshed under its lock (`terminalCredentialStore`).
  const modelRuntime = await ModelRuntime.create({ credentials: terminalCredentialStore(), modelsPath: join(agentDir, 'models.json') })
  // This process makes the model requests, so it is where response headers are seen. Only the
  // limit-bearing headers cross the socket, and the parent throttles what it stores.
  observeProviderResponses(modelRuntime, (provider, response) => {
    const headers = limitHeaders(response.headers)
    if (!Object.keys(headers).length) return
    void controlCall('terminal.usage.headers', { provider, status: response.status, headers }).catch(() => undefined)
  })
  const listeners = new Set<AgentSessionEventListener>()
  const changes = new Set<SessionChangeListener>()
  const beforeChanges = new Set<() => void>()
  let unsubscribe: (() => void) | undefined
  let changing = false
  let disposed = false
  let uiGeneration = 0
  let deviceIdPromise: Promise<string> | null = null
  const installationDeviceId = (): Promise<string> => {
    if (!deviceIdPromise) {
      deviceIdPromise = controlCall<string>('accounts.deviceId').catch((error: unknown) => {
        deviceIdPromise = null
        throw error
      })
    }
    return deviceIdPromise
  }
  const currentUi = () => {
    const generation = uiGeneration
    return sessionUiContext(host.ui, () => !disposed && generation === uiGeneration)
  }
  const planRun: TerminalPlanRunState = { active: false, allowedTools: new Set() }
  let currentMode: ComposerMode = 'normal'
  let pendingApply = false
  const choiceStore: ChoiceStore = {
    read: () => controlCall<Record<string, ModeChoice>>('accounts.choices.get'),
    write: (mode, patch) => controlCall('accounts.choices.set', { mode, ...patch })
  }
  const modeChoices = new ModeChoices(choiceStore)
  // A selection is recorded against the mode it was made in; a one-shot plan run is always plan.
  const recordingMode = (): ComposerMode => (planRun.active ? 'plan' : currentMode)
  const modelFor = (reference: string): ChoiceModel | undefined => resolveCliModel({ cliModel: reference, modelRuntime }).model
  /** A model this account can use: offered by its catalogue and holding credentials. Never a request. */
  const usableModel = async (reference: string): Promise<ChoiceModel | undefined> => {
    const model = modelFor(reference)
    return model && await modelRuntime.checkAuth(model.provider) ? model : undefined
  }
  // The level Pi resolves when no mode has saved an effort: the model's own default, then the account's.
  const defaultEffort = (session: AgentSession): AgentSession['thinkingLevel'] => {
    const model = session.model
    return ((model ? session.settingsManager.getModelThinkingLevel(model.provider, model.id) : undefined)
      ?? session.settingsManager.getDefaultThinkingLevel() ?? 'medium') as AgentSession['thinkingLevel']
  }
  const applyMode = (): Promise<void> => modeChoices.apply(native.session, currentMode, modelFor, defaultEffort(native.session))
  // Pi rebuilds the active tools from the transcript, where the last recorded set may be a plan's.
  const restoreNormalTools = (session: AgentSession): void => {
    const recorded = normalToolsForBranch(session.sessionManager.getBranch() as never)
    session.setActiveToolsByName(normalModeTools(recorded ?? session.getActiveToolNames()))
  }
  const restoreChoice = async (session: AgentSession, previous: { model: AgentSession['model']; effort: AgentSession['thinkingLevel'] }): Promise<void> => {
    if (previous.model && (session.model?.provider !== previous.model.provider || session.model?.id !== previous.model.id)) {
      await session.setModel(previous.model, { persist: false }).catch(() => undefined)
    }
    session.setThinkingLevel(previous.effort, { persist: false })
  }
  // A conversation written on another account can name a model this one cannot use. The account's own
  // newest choice decides then, and the conversation records it so the next resume is settled. A
  // fallback never fails the start: whatever is wrong with the choice, Pi's own fallback remains.
  const recoverModel = async (session: AgentSession): Promise<{ recorded: string; reference: string; effort?: Effort } | null> => {
    // An explicit launch model is the host's decision for this session, and a reading that fails is no reason to change one.
    if (prepared.model) return null
    const recorded = recordedModel(session.sessionManager.getBranch())
    if (!recorded) return null
    const reference = `${recorded.provider}/${recorded.modelId}`
    if (await usableModel(reference).catch(() => undefined)) return null
    const applied = await modeChoices.useFallback(session, currentMode, usableModel, defaultEffort(session)).catch(() => null)
    return applied ? { recorded: reference, ...applied } : null
  }

  let native: AgentSessionRuntime
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
    if (realpathSync(targetCwd) !== cwd) throw new Error('A native session cannot change this terminal working folder.')
    const settingsManager = SettingsManager.create(cwd, agentDir)
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir,
      // The real settings still control models and tools; empty discovery settings prevent a
      // second resource decision outside the Harness's trusted prepare() result.
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: prepared.extensions.slice(0, -1),
      additionalSkillPaths: prepared.skills, additionalPromptTemplatePaths: prepared.prompts,
      additionalThemePaths: prepared.themes,
      extensionFactories: [
        { name: 'harness-terminal-bridge', factory: pi => terminalExtension(pi, planRun, () => native.session), hidden: true },
        // A model picked in the terminal reaches Pi as this event. A restore is not a pick.
        { name: 'harness-mode-choices', factory: pi => { pi.on('model_select', event => { if (event.source !== 'restore') void modeChoices.record(recordingMode(), { model: `${event.model.provider}/${event.model.id}` }) }) }, hidden: true },
        // The bridge registers parent capabilities when delegation is available. Runs without
        // delegation still need the same frozen snapshot, after the bridge has begun the run.
        { name: 'harness-run-capabilities', factory: pi => {
          pi.on('before_agent_start', async () => {
            if (!pi.getAllTools().some(tool => tool.name === 'spawn_subagent')) {
              const snapshot = await controlCall<{ connectors?: string[] }>('terminal.subagents.register', { tools: pi.getActiveTools(), plan: planRun.active })
              if (Array.isArray(snapshot.connectors)) planRun.connectors = snapshot.connectors
            }
          })
        }, hidden: true }
      ],
      appendSystemPromptOverride: (base) => [...base, ...prepared.appendSystemPrompt]
    })
    let resourceOwners: Found[] = []
    const barePrompts = new Set<string>()
    const reloadResources = resourceLoader.reload.bind(resourceLoader)
    resourceLoader.reload = async (options) => {
      // Recheck the host's exact package trust and attachment identities before every load,
      // including the reload performed internally by AgentSession.reload().
      const selected = await controlCall<{ resourceOwners?: Found[] }>('terminal.resources', {}, 30_000)
      resourceOwners = selected.resourceOwners ?? []
      await reloadResources(options)
      applyExtensionOwners(resourceLoader, resourceOwners)
      await wrapPromptLoader(pi, resourceLoader, resourceOwners, prepared.prompts, cwd, agentDir, () => (native?.session?.extensionRunner.getRegisteredCommands() ?? []).map(command => {
        const source = command.sourceInfo
        return { prefix: pluginCommandPrefix(source), name: command.name, owner: source.origin === 'package' ? `package:${source.baseDir ?? source.source}` : `extension:${source.path}`, path: source.path }
      }), barePrompts)
    }
    await resourceLoader.reload()
    const errors = resourceLoader.getExtensions().errors
    if (errors.length) throw new Error(errors.map((error) => `${error.path}: ${error.error}`).join('\n'))
    let selected: ReturnType<typeof resolveCliModel> | undefined
    if (prepared.model && sessionStartEvent?.reason === 'startup') {
      selected = resolveCliModel({ cliModel: prepared.model, modelRuntime })
      if (selected.error || !selected.model) throw new Error(selected.error ?? `Model ${prepared.model} is unavailable.`)
    }
    // A fresh conversation starts on this account's latest normal-mode choice. A resumed one keeps its history,
    // and an explicit --model wins. A saved model the account cannot use is skipped.
    const fresh = !prepared.model && (sessionStartEvent?.reason === 'new' || (sessionStartEvent?.reason === 'startup' && !resume))
    const saved: { model?: string; effort?: Effort } = fresh ? modeChoices.resolve('normal') : {}
    if (fresh && saved.model) {
      const chosen = resolveCliModel({ cliModel: saved.model, modelRuntime })
      if (chosen.model && !chosen.error && await modelRuntime.checkAuth(chosen.model.provider)) selected = chosen
    }
    const thinkingLevel = selected?.thinkingLevel ?? (fresh ? saved.effort : undefined)
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager, sessionStartEvent,
      ...(selected?.model ? { model: selected.model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {})
    })
    installPluginCommandRouter(created.session, resourceOwners, barePrompts)
    restoreNormalTools(created.session)
    const services: AgentSessionServices = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }
    host.resources?.(services)
    return { ...created, services, diagnostics: services.diagnostics }
  }
  await modeChoices.load()
  native = await createAgentSessionRuntime(factory, {
    cwd, agentDir,
    sessionManager: resume ? SessionManager.open(resume, sessionDirectory) : SessionManager.create(cwd, sessionDirectory),
    sessionStartEvent: { type: 'session_start', reason: 'startup' }
  })

  const before = () => {
    uiGeneration += 1
    unsubscribe?.()
    unsubscribe = undefined
    for (const listener of beforeChanges) listener()
  }
  const announce = async () => {
    for (const listener of changes) await listener(native.session)
    host.changed()
  }
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    if (disposed) throw new Error('The terminal runtime has closed.')
    if (changing) throw new Error('A native session change is already in progress.')
    if (!native.session.isIdle) throw new Error('Stop the current response before changing or reloading this session.')
    changing = true
    try {
      await controlCall('terminal.resources', {}, 30_000)
      // A model or effort a switch restores belongs to the session's history, not to a choice the person made.
      return await modeChoices.quietly(action)
    } finally {
      changing = false
    }
  }
  const decide = async (call: string, params: Record<string, unknown>): Promise<void> => {
    if (disposed) throw new Error('The terminal runtime has closed.')
    await controlCall(call, params)
  }
  const runtime: TerminalRuntime = {
    async pending() {
      if (disposed) return []
      return (await controlCall<{ requests: TerminalDecision[] }>('terminal.pending')).requests
    },
    approve: (requestId, decision, alwaysAllowTool = false) => decide('terminal.approve', { requestId, decision, alwaysAllow: alwaysAllowTool }),
    async permissions() {
      if (disposed) return { full: false, globalTools: [] }
      return controlCall<TerminalPermissionState>('terminal.permissions.get')
    },
    setFullPermission: async enabled => { await decide('terminal.permissions.setFull', { enabled }) },
    setGlobalTool: async (tool, allowed) => { await decide('terminal.permissions.setTool', { tool, allowed }) },
    answer: (requestId, answer) => decide('terminal.answer', { requestId, answer }),
    answerBatch: (batchId, answers) => decide('terminal.answers', { batchId, answers }),
    snapshot() {
      const session = native.session
      const usage = session.getContextUsage()
      const model = session.model?.id === 'unknown' ? undefined : session.model
      return Object.freeze({
        sessionId: session.sessionId, sessionFile: session.sessionFile, name: session.sessionName,
        cwd, account,
        model: model ? Object.freeze({ id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }) : undefined,
        thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, idle: session.isIdle,
        hasUserMessages: session.state.messages.some(message => message.role === 'user'),
        hideThinking: session.settingsManager.getHideThinkingBlock(),
        context: Object.freeze({ percent: usage?.percent ?? null, window: usage?.contextWindow ?? model?.contextWindow ?? 0 }),
        costUsd: session.getSessionStats().cost,
        subscription: model ? session.modelRuntime.isUsingSubscription(model.provider) : false,
        queue: Object.freeze({ steering: Object.freeze([...session.getSteeringMessages()]), followUp: Object.freeze([...session.getFollowUpMessages()]) })
      })
    },
    async submit(text, followUp = false, images) {
      if (disposed) throw new Error('The terminal runtime has closed.')
      if (changing) throw new Error('Wait for the native session change to finish before submitting.')
      const input = text.trimStart().startsWith('/') ? text.trimStart() : text
      await native.session.prompt(input, {
        ...(native.session.isStreaming ? { streamingBehavior: followUp ? 'followUp' : 'steer' } : {}),
        ...(images?.length ? { images } : {})
      })
    },
    async submitPlan(text, images) {
      if (disposed) throw new Error('The terminal runtime has closed.')
      if (changing) throw new Error('Wait for the native session change to finish before submitting.')
      if (!text.trim()) throw new Error('Use /plan <plan brief>.')
      const session = native.session
      if (!session.isIdle) throw new Error('A plan request must wait until the current response settles.')
      const originalTools = session.getActiveToolNames()
      const registeredQuestions = session.getAllTools().map(tool => tool.name).filter(name => QUESTION_TOOL_NAMES.has(name))
      const allowedTools = planModeTools(originalTools, [], registeredQuestions)
      // The session's own model and effort come back once the plan is done.
      const previous = { model: session.model, effort: session.thinkingLevel }
      planRun.allowedTools = new Set(allowedTools)
      planRun.active = true
      try {
        session.sessionManager.appendCustomEntry(PLAN_TOOLS_ENTRY, { phase: 'begin', normal: originalTools })
        session.setActiveToolsByName(allowedTools)
        await modeChoices.apply(session, 'plan', modelFor, defaultEffort(session))
        await session.prompt(text, { expandPromptTemplates: false, ...(images?.length ? { images } : {}) })
      } finally {
        planRun.active = false
        planRun.allowedTools = new Set()
        if (!disposed && native.session === session) {
          session.setActiveToolsByName(originalTools)
          session.sessionManager.appendCustomEntry(PLAN_TOOLS_ENTRY, { phase: 'end' })
          await modeChoices.quietly(() => restoreChoice(session, previous))
          if (pendingApply) {
            pendingApply = false
            await applyMode()
          }
        }
      }
    },
    async setMode(mode) {
      if (disposed) throw new Error('The terminal runtime has closed.')
      currentMode = mode
      // A switch during a running turn waits for it to settle, so the turn keeps the model it started with.
      if (native.session.isIdle && !planRun.active) await applyMode()
      else pendingApply = true
    },
    get session() { return native.session },
    get services() { return native.services },
    cwd, sessionDirectory,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    onSessionChange(listener) { changes.add(listener); return () => { changes.delete(listener) } },
    onBeforeSessionChange(listener) { beforeChanges.add(listener); return () => { beforeChanges.delete(listener) } },
    newSession: (options) => exclusive(async () => {
      // Re-read the choices so a new conversation starts on what was chosen most recently.
      await modeChoices.load()
      return native.newSession(options)
    }),
    switchSession: (path, options) => exclusive(async () => {
      const target = resolve(cwd, path)
      assertTerminalHistoryPath(target, sessionDirectory)
      assertTerminalSessionScope(target, cwd, options?.cwdOverride)
      return native.switchSession(target, options)
    }),
    fork: (entryId, options) => exclusive(() => native.fork(entryId, options)),
    navigateTree: (targetId, options) => exclusive(async () => {
      const result = await native.session.navigateTree(targetId, options)
      if (!result.cancelled && !planRun.active) restoreNormalTools(native.session)
      if (!result.cancelled) await announce()
      return result
    }),
    importFromJsonl: (path, cwdOverride) => exclusive(async () => {
      const target = resolve(cwd, path)
      assertTerminalSessionScope(target, cwd, cwdOverride)
      return native.importFromJsonl(target, cwdOverride)
    }),
    installationDeviceId,
    reload: () => exclusive(async () => {
      // Refuse a revoked or changed resource set before tearing down the currently usable UI.
      await controlCall('terminal.resources', {}, 30_000)
      await runtime.interrupt()
      before()
      await native.session.reload({ beforeSessionStart: async () => {
        native.session.extensionRunner.setUIContext(currentUi(), 'tui')
        observeSession()
        await announce()
      } })
      host.changed()
    }),
    async interrupt() {
      // Bash executions use their own abort controllers, outside Pi's agent tool loop.
      native.session.abortBash()
      // Socket-backed questions and approvals must settle before Pi can finish aborting tools.
      await controlCall('terminal.interrupt', {}, 15_000).catch(() => {})
      await native.session.abort()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await runtime.interrupt()
        await native.dispose()
      } finally {
        unsubscribe?.()
        listeners.clear()
        changes.clear()
        beforeChanges.clear()
      }
    }
  }
  const observeSession = () => {
    unsubscribe?.()
    unsubscribe = native.session.subscribe(event => {
      if (event.type === 'thinking_level_changed') void modeChoices.record(recordingMode(), { effort: event.level as Effort })
      if (event.type === 'agent_settled' && pendingApply && !planRun.active) {
        pendingApply = false
        void applyMode().catch(() => undefined)
      }
      for (const listener of listeners) listener(event)
      host.changed()
    })
  }
  const bind = async () => {
    const session = native.session
    observeSession()
    await session.bindExtensions({
      uiContext: currentUi(), mode: 'tui', shutdownHandler: () => host.shutdown(),
      abortHandler: () => { void runtime.interrupt().catch((error) => host.notify(error instanceof Error ? error.message : String(error))) },
      onError: (error) => host.notify(`${error.event}: ${error.error}`),
      commandContextActions: {
        waitForIdle: () => native.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        switchSession: (path, options) => runtime.switchSession(path, options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: (targetId, options) => runtime.navigateTree(targetId, options),
        reload: () => runtime.reload()
      }
    })
    const recovered = await recoverModel(session)
    await announce()
    if (recovered) {
      const effort = recovered.effort ? ` at ${recovered.effort} effort` : ''
      host.notify(`This account cannot use ${recovered.recorded}. Started on ${recovered.reference}${effort}, your latest choice on this account.`)
    } else if (native.modelFallbackMessage) host.notify(native.modelFallbackMessage)
  }
  native.setBeforeSessionInvalidate(before)
  native.setRebindSession(bind)
  try {
    await bind()
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  return runtime
}
