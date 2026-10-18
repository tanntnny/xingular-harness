import {
  createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, resolveCliModel,
  SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEventListener, type AgentSessionRuntime, type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory, type ExtensionUIContext
} from '@earendil-works/pi-coding-agent'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import terminalExtension from '../piExtension'
import { claimTerminalControl, controlCall } from '../control'
import { loadPiAdapter } from './piAdapter'
import type { SessionAccount } from '../accountsMenu'
import type { QuestionAnswer } from '../../sessions/registry'
import type { TerminalQuestion } from './questions'
import { sessionUiContext } from './sessionUi'

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

export interface TerminalRuntime {
  pending(): Promise<TerminalDecision[]>
  approve(requestId: string, decision: 'approved' | 'denied', alwaysAllowTool?: boolean): Promise<void>
  permissions(): Promise<TerminalPermissionState>
  setFullPermission(enabled: boolean): Promise<void>
  setGlobalTool(tool: string, allowed: boolean): Promise<void>
  answer(requestId: string, answer: QuestionAnswer): Promise<void>
  answerBatch(batchId: string, answers: Array<{ questionId: string; answer: QuestionAnswer }>): Promise<void>
  snapshot(): TerminalSnapshot
  submit(text: string, followUp?: boolean): Promise<void>
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

  // Claim before loading any plugin code and retain it in the trusted process across reloads.
  await claimTerminalControl()
  const identity = await controlCall<SessionAccount>('accounts.session').catch(() => null)
  const account = identity && typeof identity.accountId === 'string' && typeof identity.label === 'string'
    ? Object.freeze({ accountId: identity.accountId, label: identity.label }) : null
  const adapter = await loadPiAdapter()
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') })
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
      extensionFactories: [...adapter.builtins, { name: 'harness-terminal-bridge', factory: terminalExtension, hidden: true }],
      appendSystemPromptOverride: (base) => [...base, ...prepared.appendSystemPrompt]
    })
    const reloadResources = resourceLoader.reload.bind(resourceLoader)
    resourceLoader.reload = async (options) => {
      // Recheck the host's exact package trust and attachment identities before every load,
      // including the reload performed internally by AgentSession.reload().
      await controlCall('terminal.resources', {}, 30_000)
      await reloadResources(options)
    }
    await resourceLoader.reload()
    const errors = resourceLoader.getExtensions().errors
    if (errors.length) throw new Error(errors.map((error) => `${error.path}: ${error.error}`).join('\n'))
    let selected: ReturnType<typeof resolveCliModel> | undefined
    if (prepared.model && sessionStartEvent?.reason === 'startup') {
      selected = resolveCliModel({ cliModel: prepared.model, modelRuntime })
      if (selected.error || !selected.model) throw new Error(selected.error ?? `Model ${prepared.model} is unavailable.`)
    }
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager, sessionStartEvent,
      ...(selected?.model ? { model: selected.model } : {}),
      ...(selected?.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {})
    })
    const services: AgentSessionServices = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }
    host.resources?.(services)
    return { ...created, services, diagnostics: services.diagnostics }
  }
  const native = await createAgentSessionRuntime(factory, {
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
      return await action()
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
    async submit(text, followUp = false) {
      if (disposed) throw new Error('The terminal runtime has closed.')
      if (changing) throw new Error('Wait for the native session change to finish before submitting.')
      const input = text.trimStart().startsWith('/') ? text.trimStart() : text
      await native.session.prompt(input, native.session.isStreaming ? { streamingBehavior: followUp ? 'followUp' : 'steer' } : {})
    },
    get session() { return native.session },
    get services() { return native.services },
    cwd, sessionDirectory,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    onSessionChange(listener) { changes.add(listener); return () => { changes.delete(listener) } },
    onBeforeSessionChange(listener) { beforeChanges.add(listener); return () => { beforeChanges.delete(listener) } },
    newSession: (options) => exclusive(() => native.newSession(options)),
    switchSession: (path, options) => exclusive(async () => {
      const target = resolve(cwd, path)
      assertTerminalHistoryPath(target, sessionDirectory)
      assertTerminalSessionScope(target, cwd, options?.cwdOverride)
      return native.switchSession(target, options)
    }),
    fork: (entryId, options) => exclusive(() => native.fork(entryId, options)),
    navigateTree: (targetId, options) => exclusive(async () => {
      const result = await native.session.navigateTree(targetId, options)
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
    await announce()
    if (native.modelFallbackMessage) host.notify(native.modelFallbackMessage)
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
