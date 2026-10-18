// A host owns the PTY and process supervision; Harness owns the terminal application inside it.
// This service prepares the isolated account, compiled context, trusted resource selection and
// socket bridge. The default launch runs our frontend with Pi's persistent SDK runtime.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Type } from 'typebox'

import type { CapabilitySet } from '../capabilities/types'
import { freezeRun } from '../capabilities/runSnapshot'
import type { Subagents } from '../sessions/subagentService'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS, type SubagentOptions } from '../sessions/subagents'
import { subagentTools } from '../tools/spawnSubagent'
import type { Effort } from '../sessions/runner'
import type { Accounts } from '../accounts/accounts'
import type { Approvals } from '../sessions/approvals'
import { configDir, launchEnv } from '../accounts/env'
import { readAudit, type Account } from '../accounts/store'
import type { Bus } from '../core/bus'
import { log } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import { newId, now } from '../core/fs'
import { prependSearchPath, searchPath } from '../core/path'
import type { BrokerSession, ConnectedApps } from '../mcp/service'
import type { CallerContext } from '../memory/caller'
import { dispatch } from '../memory/dispatch'
import type { AttachParams, PluginScope } from '../plugins/api'
import type { Loading, Plugins } from '../plugins/plugins'
import type { Plugin } from '../plugins/types'
import type { Hub } from '../hub/hub'
import { compile, copyToRun, memoryDelta, record, render, saveForSession, type Launch } from '../prompt/compile'
import type { RunRecord } from '../sessions/contracts'
import { isActiveStatus } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import type { ActiveRun, RunRegistry } from '../sessions/registry'
import { findRun, loadRun, saveRun, updateRun } from '../sessions/runStore'
import { resources } from '../skills/registry'
import type { ToolSpec } from '../tools/types'
import { APPS_COMMAND, WIKI_COMMAND } from './cli'
import { SOCKET_ENV, TOKEN_ENV } from './client'
import { TerminalController, type PolicyReply } from './controller'
import { resolvePiCommand, terminalCommandFiles } from './launch'
import { SessionSocket, socketPath } from './socket'
import { harnessLogInfo, readHarnessLogChunk } from './logs'
import { listTerminalTrajectoryRuns, readTerminalTrajectory } from './trajectory'

/** Identity of the exact resource decision that this terminal was prepared with. */
function resourceIdentity(loading: Loading | null): string {
  if (!loading) return 'null'
  return JSON.stringify({
    extensions: loading.extensionPaths, builtins: loading.builtins, skills: loading.skillPaths,
    prompts: loading.promptPaths, themes: loading.themePaths, detached: loading.detached,
    project: loading.projectCode, packages: loading.packageCode
  })
}

/** The files a terminal session needs on disk, outside this process. */
export interface TerminalAssets {
  /** The Node binary that runs the commands. */
  node: string
  /** The built `xingular-harness` command (`dist/cli.js`). */
  cli: string
  /** The built Pi extension (`dist/terminal-pi.js`). */
  piExtension: string
}

/** Where the package's own build puts them. An application that bundles the harness passes its own. */
export function defaultAssets(): TerminalAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const dist = [here, join(here, '..', '..', 'dist'), join(here, '..', 'dist')].find((folder) => existsSync(join(folder, 'terminal-pi.js'))) ?? here
  return { node: process.execPath, cli: join(dist, 'cli.js'), piExtension: join(dist, 'terminal-pi.js') }
}

export interface TerminalPrepareInput {
  subagents?: SubagentOptions | null
  sessionId: string
  /** The account the session is pinned to. Omitted only for a session that has none yet; it then takes the default and keeps it. */
  accountId?: string | null
  projectId?: string | null
  cwd: string
  /** The session's own folder. Its compiled instructions and native history are kept under it. */
  sessionFolder: string
  nativeSessionId?: string | null
  model?: string | null
  readOnly?: boolean
  /** What the application adds to the instructions, and which of its tools it describes. */
  launch?: Launch
  /** Give the session the connected-apps broker. Defaults to yes. */
  connections?: boolean
  /** Fields copied onto each run this session records. */
  run?: Partial<Pick<RunRecord, 'mode' | 'worktreeId'>>
}

export interface TerminalLaunch {
  program: string
  args: string[]
  /** Variables to set; `null` removes an inherited one. */
  env: Record<string, string | null>
  accountId: string
  nativeSessionId: string | null
}

interface Live {
  input: TerminalPrepareInput
  account: Account
  controller: TerminalController
  token: string
  broker: BrokerSession | null
  caller: CallerContext
}

export interface TerminalsOptions {
  subagents?: Subagents
  resolveCapabilities?: (caller: CallerContext, tools: readonly string[], cwd: string) => Promise<CapabilitySet>
  env: HarnessEnv
  stateDir: string
  accounts: Accounts
  runs: RunRegistry
  approvals: Approvals
  apps: ConnectedApps
  policy: ToolPolicy
  bus: Bus
  /** Chooses what a terminal loads. Without it Pi discovers extensions and skills on its own. */
  plugins?: Plugins
  /** Lists plugins and applies a person's choices, for the session's `/plugins` command. */
  pluginControl?: PluginControl
  hub?: Hub
  assets?: TerminalAssets
  /** The `pi` executable. Defaults to the pinned bundled CLI through the active Node runtime. */
  program?: () => string | null
}

/** What `/plugins` in a terminal can do. Each takes the session's folder, account and project. */
export interface PluginControl {
  list(scope: PluginScope): Promise<Plugin[]>
  attach(params: AttachParams, on: boolean): Promise<Plugin[]>
  trust(scope: PluginScope & { hash: string }): Promise<Plugin[]>
  untrust(scope: PluginScope & { hash: string }): Promise<Plugin[]>
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export class Terminals {
  private readonly sessions = new Map<string, Live>()
  private readonly socket: SessionSocket
  private readonly assets: TerminalAssets
  /** A session's `/accounts` switch, taken once its Pi process has ended. */
  private readonly relaunches = new Map<string, { accountId: string; nativeSessionId: string | null }>()

  constructor(private readonly options: TerminalsOptions) {
    this.assets = options.assets ?? defaultAssets()
    options.runs.listen(event => {
      this.sessions.get(event.sessionId)?.controller.observe(event)
      const record = findRun(options.env.root, event.runId)
      if (record?.relation !== 'subagent') return
      let parentId = record.parentRunId
      const seen = new Set<string>()
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = findRun(options.env.root, parentId)
        if (!parent) break
        const owner = this.sessions.get(parent.sessionId)
        if (owner?.controller.activeRun?.runId === parent.id) { owner.controller.observe(event, true); break }
        parentId = parent.parentRunId
      }
    })
    this.socket = new SessionSocket(socketPath(options.stateDir), {
      memory: (caller, call, params) => dispatch(options.env, caller, call, params),
      apps: (session, call, params) => this.appsCall(session, call, params),
      plugins: (grant, call, params, control) => this.pluginsCall(grant.sessionId, call, params, control),
      accounts: (grant, call, params, control) => this.accountsCall(grant.sessionId, call, params, control)
    })
  }

  /** The commands a terminal session finds on PATH. Rewritten only when they change. */
  private ensureCommands(): string {
    const bin = join(this.options.stateDir, 'run', 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of ['agentx-wiki', 'agentx-mcp', 'agentx-wiki.cmd', 'agentx-mcp.cmd']) {
      const path = join(bin, name)
      try {
        if (lstatSync(path).isFile()) unlinkSync(path)
      } catch {
        // These names belonged to the previous generated wrappers.
      }
    }
    for (const [name, mode] of [[WIKI_COMMAND, 'wiki'], [APPS_COMMAND, 'mcp']] as const) {
      for (const file of terminalCommandFiles(process.platform, this.assets.node, this.assets.cli, name, mode)) {
        const path = join(bin, file.name)
        let current: string | null = null
        try {
          current = readFileSync(path, 'utf8')
        } catch {
          current = null
        }
        if (current !== file.content) {
          writeFileSync(path, file.content)
          chmodSync(path, 0o755)
        }
      }
    }
    return bin
  }

  private tools(session: BrokerSession): ToolSpec[] {
    return this.options.apps.brokerTools(session)
  }

  private async appsCall(session: BrokerSession, call: string, params: Record<string, unknown>): Promise<unknown> {
    const { apps } = this.options
    switch (call) {
      case 'mcp.list':
        return apps.list(session)
      case 'mcp.call':
        return apps.invoke(session, String(params.name ?? ''), (params.args && typeof params.args === 'object' ? params.args : {}) as Record<string, unknown>)
      case 'mcp.revision':
        return apps.revision(session)
      case 'tools.list': {
        const { Type } = await import('typebox')
        return { tools: this.tools(session).map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters(Type) })) }
      }
      case 'tools.call': {
        const tool = this.tools(session).find((candidate) => candidate.name === params.name)
        if (!tool) throw new HarnessError('unknown_method', `Unknown tool ${String(params.name)}.`)
        const result = await tool.execute((params.input && typeof params.input === 'object' ? params.input : {}) as Record<string, unknown>)
        return { text: typeof result === 'string' ? result : result.text }
      }
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  /**
   * `/plugins` in a terminal. Listing is open to the session. A change is taken only from the
   * session's own extension, which asks the person in the terminal first: the model can reach
   * this socket from a shell command, and must not be able to trust code or switch it on.
   */
  private async pluginsCall(sessionId: string, call: string, params: Record<string, unknown>, control: boolean): Promise<unknown> {
    const api = this.options.pluginControl
    const live = this.sessions.get(sessionId)
    if (!api || !live) throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    const projectId = live.input.projectId ?? null
    const scope = { cwd: live.input.cwd, accountId: live.account.id, projectId }
    if (call === 'hub.list' && this.options.hub) return this.options.hub.list(params.refresh === true)
    if (call === 'hub.install' && this.options.hub) {
      if (!control) throw new HarnessError('unauthorized', 'Only a person at this terminal can install items. Type /hub.')
      if (typeof params.id !== 'string' || typeof params.version !== 'string') throw invalid('An item id and version are required.')
      return this.options.hub.install(params.id, params.version)
    }
    if (call === 'plugins.list') return api.list(scope)
    if (call === 'plugins.session') return { projectId }
    if (!control) throw new HarnessError('unauthorized', 'Only a person at this terminal can change plugins. Type /plugins.')
    const text = (name: string): string => {
      if (typeof params[name] !== 'string' || !params[name]) throw invalid(`${name} is required.`)
      return params[name] as string
    }
    switch (call) {
      case 'plugins.attach':
      case 'plugins.detach':
        return api.attach({ ...scope, id: text('id'), scope: params.everywhere === true || !projectId ? {} : { projectId } }, call === 'plugins.attach')
      case 'plugins.trust':
        return api.trust({ ...scope, hash: text('hash') })
      case 'plugins.untrust':
        return api.untrust({ ...scope, hash: text('hash') })
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  /**
   * `/accounts` in a terminal. Every call needs the session's control key: adding, signing in,
   * or removing an account is a person's choice, never the model's shell command.
   */
  private async accountsCall(sessionId: string, call: string, params: Record<string, unknown>, control: boolean): Promise<unknown> {
    const { accounts } = this.options
    const live = this.sessions.get(sessionId)
    if (!live) throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    if (!control) throw new HarnessError('unauthorized', 'Only a person at this terminal can manage accounts. Type /accounts.')
    const text = (name: string): string => {
      if (typeof params[name] !== 'string' || !params[name]) throw invalid(`${name} is required.`)
      return params[name] as string
    }
    const optional = (name: string): string | null => (typeof params[name] === 'string' ? (params[name] as string) : null)
    switch (call) {
      case 'accounts.deviceId':
        return accounts.installationDeviceId()
      case 'accounts.list':
        return accounts.overview()
      case 'accounts.session':
        return { accountId: live.account.id, label: live.account.label }
      case 'accounts.create':
        return accounts.create(text('label'), optional('authKind') ?? 'subscription')
      case 'accounts.rename':
        return accounts.rename(text('accountId'), text('label'))
      case 'accounts.setDefault':
        return accounts.setDefault(text('accountId'))
      case 'accounts.remove': {
        const accountId = text('accountId')
        // Every terminal in this process counts, this session's own included. Another process's terminals are not visible here.
        if (accounts.terminalCount(accountId) > 0) throw new HarnessError('account_in_use', 'A running terminal is using this account, this one included.', 'Switch this session to another account first, then remove it.')
        return accounts.remove(accountId)
      }
      case 'accounts.refresh':
        return accounts.refresh(optional('accountId'))
      case 'accounts.providers':
        return accounts.providers()
      case 'accounts.loginStart':
        return accounts.loginStart(text('accountId'), text('provider'), optional('method'))
      case 'accounts.loginStatus':
        return accounts.loginStatus(text('accountId'))
      case 'accounts.loginRespond':
        accounts.loginRespond(text('loginId'), text('promptId'), optional('value'))
        return {}
      case 'accounts.loginCancel':
        accounts.loginCancel(text('accountId'), optional('loginId'))
        return {}
      case 'accounts.setApiKey':
        return accounts.setApiKey(text('accountId'), text('key'), text('provider'))
      case 'accounts.removeProvider':
        return accounts.removeProvider(text('accountId'), text('provider'))
      case 'accounts.signOut':
        return accounts.signOut(text('accountId'))
      case 'accounts.savePool': {
        const pool = params.pool as { id?: unknown; label?: unknown; accountIds?: unknown } | undefined
        if (!pool || typeof pool.label !== 'string' || !Array.isArray(pool.accountIds) || !pool.accountIds.every((id) => typeof id === 'string')) throw invalid('A pool needs a label and its account ids.')
        return accounts.savePool({ id: typeof pool.id === 'string' ? pool.id : undefined, label: pool.label, accountIds: pool.accountIds as string[] })
      }
      case 'accounts.removePool':
        return accounts.removePool(text('poolId'))
      case 'accounts.audit':
        return readAudit(accounts.dir, optional('accountId'), typeof params.limit === 'number' ? params.limit : 100)
      case 'accounts.relaunch': {
        // Checked here so a bad choice is refused before the session is asked to end.
        const target = accounts.resolve(text('accountId'))
        this.relaunches.set(sessionId, { accountId: target.id, nativeSessionId: live.controller.nativeSessionId })
        return { accountId: target.id, label: target.label }
      }
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  /** The account a session asked to switch to. Taken once, after its Pi process has ended and before `dispose`. */
  takeRelaunch(sessionId: string): { accountId: string; nativeSessionId: string | null } | null {
    const request = this.relaunches.get(sessionId) ?? null
    this.relaunches.delete(sessionId)
    return request
  }

  private live(sessionId: string): Live {
    const live = this.sessions.get(sessionId)
    if (!live) throw new HarnessError('terminal_not_ready', 'The terminal controller is unavailable. Reopen this session.')
    return live
  }

  private historyDir(input: TerminalPrepareInput): string {
    return join(input.sessionFolder, 'pi')
  }

  private runRecord(live: Live, runId: string, text: string | null): RunRecord {
    const { input } = live
    return {
      resumedFromRunId: null,
      parentRunId: null,
      relation: null,
      terminalReason: null,
      agentId: null,
      trigger: null,
      id: runId,
      projectId: input.projectId ?? null,
      mode: input.run?.mode ?? 'code',
      harness: 'pi',
      sessionType: 'terminal',
      sessionId: input.sessionId,
      nativeSessionId: live.controller.nativeSessionId,
      workingDirectory: input.cwd,
      worktreeId: input.run?.worktreeId ?? null,
      goal: text,
      attachmentCount: 0,
      startedAt: now(),
      endedAt: null,
      status: 'queued',
      exitCode: null,
      handoffId: null,
      accountId: live.account.id
    }
  }

  /** The run a native turn reports into: the one reserved by `send`, or a new one for what the person typed. */
  private begin(live: Live, reservedRunId: string | null, text: string): ActiveRun {
    const { root } = this.options.env
    const { sessionId } = live.input
    if (this.options.runs.activeForSession(sessionId)) throw new HarnessError('session_busy', 'A native turn already owns this session.')
    let runId = reservedRunId
    if (runId) {
      const reserved = loadRun(root, runId)
      if (reserved.sessionId !== sessionId || reserved.status !== 'queued') throw invalid('Delivery does not own this queued run.')
    } else {
      runId = newId()
      saveRun(root, this.runRecord(live, runId, text || null))
      copyToRun(root, live.input.sessionFolder, runId)
    }
    return this.options.runs.start(sessionId, runId)
  }

  private async decide(live: Live, run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply> {
    const record = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(record.status)) throw invalid('The run is no longer active.')
    const call = { run: record, caller: { ...live.caller, runId: run.runId }, tool, args }
    const { policy } = this.options
    if (policy.scope) {
      const scope = await policy.scope(call)
      if (!scope.allowed && (scope.automatic || !scope.requiresApproval)) return { allowed: false, reason: scope.reason ?? 'Outside what this session may do.' }
      try {
        await policy.authorize?.(call)
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : 'Tool unavailable in the settings.' }
      }
      const requiresApproval = !!scope.requiresApproval || (scope.allowed && !!scope.humanOnly)
      return {
        allowed: scope.allowed,
        requiresApproval,
        reason: scope.reason ?? null,
        rememberable: scope.allowed && !scope.humanOnly,
        ...(scope.humanOnly ? { standing: scope.allowGlobalApproval ? 'switch' as const : 'none' as const } : {})
      }
    }
    // With no application policy: reads run, a read-only session refuses the rest, and anything else asks.
    const name = tool.toLowerCase()
    if (name === SPAWN_SUBAGENT || name === WAIT_SUBAGENTS || READ_ONLY_TOOLS.has(name) || this.options.apps.toolNames.includes(name as never)) return { allowed: true }
    if (live.input.readOnly) return { allowed: false, reason: 'This session is read-only.' }
    return { allowed: false, requiresApproval: true, rememberable: true, reason: 'This native action requires approval.' }
  }

  private async subagentsCall(live: Live, call: string, params: Record<string, any>): Promise<unknown> {
    const service = this.options.subagents
    if (!service || live.input.subagents === null) {
      if (call === 'terminal.subagents.tools') return { tools: [] }
      throw invalid('Subagents are disabled for this terminal.')
    }
    if (call === 'terminal.subagents.tools') return { tools: subagentTools(service, '').map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters(Type) })) }
    const run = live.controller.activeRun
    if (!run) throw new HarnessError('run_not_active', 'This terminal has no active parent run.')
    if (call === 'terminal.subagents.register') {
      if (!Array.isArray(params.tools) || params.tools.some((name: unknown) => typeof name !== 'string')) throw invalid('Native tool names are required.')
      const readOnly = live.input.readOnly === true
      const readTools = new Set([...READ_ONLY_TOOLS, SPAWN_SUBAGENT, WAIT_SUBAGENTS, 'ask_user', 'mcp_list_tools', 'mcp_call_tool', 'history_search', 'history_read', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts', 'skill_load'])
      const tools = params.tools.filter((name: string) => !readOnly || readTools.has(name)) as string[]
      const capabilities = this.options.resolveCapabilities ? await this.options.resolveCapabilities(live.caller, tools, live.input.cwd) : { version: 1 as const, tools, connectors: [], contributions: [] }
      freezeRun(this.options.env.root, run.runId, live.caller, capabilities)
      service.register({
        run: { id: run.runId, sessionId: live.input.sessionId, mode: live.input.run?.mode ?? 'code', projectId: live.input.projectId, worktreeId: live.input.run?.worktreeId },
        cwd: live.input.cwd, sessionDir: this.historyDir(live.input), text: '', caller: live.caller,
        model: typeof params.model === 'string' ? params.model : live.input.model,
        effort: typeof params.effort === 'string' ? params.effort as Effort : null,
        launch: live.input.launch, tools: { allow: capabilities.tools, gated: capabilities.tools.filter(name => !readTools.has(name)) },
        connections: live.input.connections === false ? false : { readOnly }, subagents: live.input.subagents,
        capabilities
      }, live.account.id, capabilities)
      service.restore(run.runId, params.history ?? { owners: [], receipts: [] })
      return { runId: run.runId }
    }
    if (call === 'terminal.subagents.verify') { await service.verify(run.runId, params.history); return {} }
    if (call === 'terminal.subagents.delivery') return service.delivery(run.runId, params.history, params.settle === true)
    if (call === 'terminal.subagents.call') {
      const tool = subagentTools(service, run.runId).find(tool => tool.name === params.name)
      if (!tool) throw invalid('Unknown subagent tool.')
      const reason = await this.decide(live, run, tool.name, params.input ?? {})
      if (!reason.allowed) throw new HarnessError('tool_denied', reason.reason ?? 'Subagents are unavailable.')
      const result = await tool.execute(params.input ?? {})
      return typeof result === 'string' ? { text: result } : result
    }
    throw invalid('Unknown subagent operation.')
  }

  private trajectoryCall(live: Live, call: string, params: Record<string, unknown>): unknown {
    if (call === 'terminal.trajectory.list') {
      return { runs: listTerminalTrajectoryRuns(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId) }
    }
    if (call === 'terminal.trajectory.events') {
      if (typeof params.runId !== 'string' || !params.runId) throw invalid('A run id is required.')
      const afterSequence = params.afterSequence
      if (afterSequence !== undefined && typeof afterSequence !== 'number') throw invalid('The event sequence must be a number.')
      return readTerminalTrajectory(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId, params.runId, afterSequence as number | undefined)
    }
    throw new HarnessError('unknown_method', `Unknown call ${call}.`)
  }

  /**
   * Prepares a `pi` terminal session and returns what to spawn. The caller must report the
   * process's end with `dispose`, also when it never starts.
   */
  async prepare(input: TerminalPrepareInput): Promise<TerminalLaunch> {
    input = structuredClone(input)
    const { env, accounts, apps, bus } = this.options
    const { root } = env
    if (!input?.sessionId || !input.cwd || !input.sessionFolder) throw invalid('A terminal session needs an id, a working folder, and its own folder.')
    await this.dispose(input.sessionId)
    const command = resolvePiCommand({ platform: process.platform, node: this.assets.node, cli: this.assets.cli, programOverride: this.options.program })
    // A pinned account is used as it is; it is never exchanged for another one.
    const account = input.accountId ? accounts.find(input.accountId) : accounts.resolve(null, null)
    const launch = launchEnv(accounts.dir, account)
    const loading = (await this.options.plugins?.loading({ cwd: input.cwd, agentDir: configDir(accounts.dir, account), install: true, caller: { projectId: input.projectId ?? null } })) ?? null
    await this.socket.listen()
    await accounts.terminalBegin(account)

    const sessionId = input.sessionId
    const caller: CallerContext = { sessionId, projectId: input.projectId ?? null, actor: 'Code', surface: 'cli' }
    let token: string | null = null
    try {
      const broker = input.connections === false ? null : apps.grant({ sessionId, runId: null, caller, readOnly: !!input.readOnly, depth: 0 })
      // The session keeps these instructions; each of its runs records a copy, and a memory
      // block that changes later is sent along as a note.
      const pack = compile(env, caller, { input: '', ...input.launch })
      record(root, caller, pack)
      mkdirSync(this.historyDir(input), { recursive: true })
      saveForSession(input.sessionFolder, pack)

      const live: Live = {
        input,
        account,
        broker,
        caller,
        token: '',
        controller: new TerminalController({
          sessionId,
          nativeSessionId: input.nativeSessionId ?? null,
          begin: ({ reservedRunId, text }) => this.begin(live, reservedRunId, text),
          policy: (run, tool, args) => this.decide(live, run, tool, args),
          allowToolGlobally: target => { this.options.approvals.allowTool('pi', target) },
          native: (nativeSessionId) => bus.emit({ type: 'terminal.native', sessionId, nativeSessionId }),
          telemetry: (event) => bus.emit({ type: 'terminal.telemetry', sessionId, event }),
          interrupt: runId => this.options.runs.interrupt(runId),
          resolveApproval: (runId, id, decision) => this.options.runs.resolveApproval(runId, id, decision),
          answerQuestion: (runId, id, answer) => this.options.runs.answerQuestion(runId, id, answer),
          answerQuestions: (runId, batchId, answers) => this.options.runs.answerQuestions(runId, batchId, answers)
        })
      }
      token = this.socket.issue({
        sessionId,
        caller: () => ({ ...caller, runId: live.controller.activeRun?.runId ?? null }),
        broker,
        terminal: { accept: (event, data) => live.controller.accept(event, data), disconnected: () => live.controller.disconnected(), control: async (call, params) => {
          if (call.startsWith('terminal.subagents.')) return this.subagentsCall(live, call, params)
          if (call === 'terminal.logs.info') return harnessLogInfo(this.options.stateDir)
          if (call === 'terminal.logs.read') {
            const { snapshotSize, offset } = params
            if (typeof snapshotSize !== 'number' || !Number.isSafeInteger(snapshotSize) || snapshotSize < 0 || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= snapshotSize) {
              throw invalid('A valid diagnostics snapshot size and byte offset are required.')
            }
            const current = harnessLogInfo(this.options.stateDir).size
            if (current === null || snapshotSize > current) throw invalid('The diagnostics snapshot is no longer available.')
            return readHarnessLogChunk(this.options.stateDir, snapshotSize, offset)
          }
          if (call.startsWith('terminal.trajectory.')) return this.trajectoryCall(live, call, params)
          if (call === 'terminal.permissions.get') {
            const policy = this.options.approvals.read()
            return { full: this.options.approvals.isAuto('pi'), globalTools: policy.globalTools.pi ?? [] }
          }
          if (call === 'terminal.permissions.setFull') {
            if (typeof params.enabled !== 'boolean') throw invalid('A boolean permission state is required.')
            return { full: this.options.approvals.setAuto('pi', params.enabled).auto.pi === true }
          }
          if (call === 'terminal.permissions.setTool') {
            if (typeof params.tool !== 'string' || !params.tool.trim() || typeof params.allowed !== 'boolean') throw invalid('A tool name and boolean permission state are required.')
            const policy = params.allowed
              ? this.options.approvals.allowTool('pi', params.tool)
              : this.options.approvals.revokeTool('pi', params.tool)
            return { globalTools: policy.globalTools.pi ?? [] }
          }
          if (call !== 'terminal.resources') return live.controller.control(call, params)
          const current = await this.options.plugins?.loading({ cwd: input.cwd, agentDir: configDir(accounts.dir, account), install: false, caller: { projectId: input.projectId ?? null } }) ?? null
          if (resourceIdentity(current) !== resourceIdentity(loading)) throw new HarnessError('terminal_resources_changed', 'Trusted resources changed since this terminal was prepared. Review /plugins and reopen the terminal to load the new selection.')
          return {}
        } }
      })
      live.token = token
      this.sessions.set(sessionId, live)

      const args = [...command.argsPrefix, '--append-system-prompt', render(env, pack)]
      if (input.model) args.push('--model', input.model)
      if (loading) {
        // Pi's own discovery is off: the terminal loads what the harness found and nothing else.
        args.push('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes')
        const enabled = resources(root, input.projectId ?? null)
        for (const path of [...loading.extensionPaths, ...loading.builtins]) args.push('--extension', path)
        for (const path of [...enabled.skillPaths, ...loading.skillPaths]) args.push('--skill', path)
        for (const path of [...enabled.promptPaths, ...loading.promptPaths]) args.push('--prompt-template', path)
        for (const path of loading.themePaths) args.push('--theme', path)
      }
      // Last, so its gate sees a tool call as every other extension left it.
      args.push('--extension', this.assets.piExtension, '--session-dir', this.historyDir(input))
      if (input.nativeSessionId) args.push('--session', input.nativeSessionId)
      return {
        program: command.program,
        args,
        env: {
          ...launch,
          XINGULAR_HARNESS_NAME: env.productName,
          ...(process.platform === 'win32' ? { XINGULAR_HARNESS_NODE: this.assets.node, XINGULAR_HARNESS_CLI: this.assets.cli } : {}),
          ...prependSearchPath(this.ensureCommands(), searchPath()),
          [SOCKET_ENV]: this.socket.path,
          [TOKEN_ENV]: token
        },
        accountId: account.id,
        nativeSessionId: input.nativeSessionId ?? null
      }
    } catch (error) {
      if (token) this.socket.revoke(token)
      this.sessions.delete(sessionId)
      apps.revokeSession(sessionId)
      await accounts.terminalEnd(account).catch(() => undefined)
      throw error
    }
  }

  /** Hands the terminal an instruction as a new run. Resolves once the native session has taken it. */
  async send(input: { sessionId: string; runId?: string | null; text: string }): Promise<{ runId: string }> {
    const { env } = this.options
    const { root } = env
    if (!input.text?.trim()) throw invalid('Message is empty.')
    const live = this.live(input.sessionId)
    if (this.options.runs.activeForSession(input.sessionId) || live.controller.state().active) throw new HarnessError('session_busy', 'This session is still working.')
    const runId = input.runId || newId()
    if (findRun(root, runId)) throw invalid('This run already exists.')
    saveRun(root, this.runRecord(live, runId, input.text))
    const note = memoryDelta(env, live.input.sessionFolder, { ...live.caller, runId })
    copyToRun(root, live.input.sessionFolder, runId)
    try {
      await live.controller.send(runId, note ? `${note}\n\n${input.text}` : input.text)
    } catch (error) {
      updateRun(root, runId, (run) => {
        if (!isActiveStatus(run.status)) return
        run.status = 'failed'
        run.endedAt = now()
      })
      throw error
    }
    return { runId }
  }

  /** What the person typed into the terminal. */
  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.controller.onInput(data)
  }

  state(sessionId: string): { ready: boolean; dirty: boolean; active: boolean } {
    return this.live(sessionId).controller.state()
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** The terminal process ended (or never started): its turn, tokens, and written credentials go with it. */
  async dispose(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.sessions.delete(sessionId)
    live.controller.dispose()
    this.socket.revoke(live.token)
    this.options.apps.revokeSession(sessionId)
    await this.options.accounts.terminalEnd(live.account).catch((error) => log('terminal credentials', error instanceof Error ? error.message : String(error)))
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.dispose(sessionId)))
    await this.socket.close()
  }
}
