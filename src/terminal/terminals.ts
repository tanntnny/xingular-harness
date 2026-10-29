import { runDetails } from '../context/runDetails'
// A host owns the PTY and process supervision; Harness owns the terminal application inside it.
// This service prepares the isolated account, compiled context, trusted resource selection and
// socket bridge. The default launch runs our frontend with Pi's persistent SDK runtime.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Type } from 'typebox'

import type { CapabilitySet } from '../capabilities/types'
import { freezeRun } from '../capabilities/runSnapshot'
import type { Subagents } from '../sessions/subagentService'
import type { SideQuestions, SideQuestionContext } from '../sessions/sideQuestions'
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
import { formatBashCommandForApproval } from '../core/workspaceBashTool'
import { resolveWorkspaceRoot } from '../core/workspace'
import { prependSearchPath, searchPath } from '../core/path'
import type { BrokerSession, ConnectedApps } from '../mcp/service'
import type { CallerContext } from '../core/caller'
import { dispatch } from '../tools/dispatch'
import { defaultSkillPaths } from '../tools/defaultSkills'
import { materialise, type Materialised, type VariantChoice } from '../variant/materialise'
import * as componentLibrary from '../variant/components'
import * as variantStore from '../variant/store'
import type { VariantTrust } from '../variant/trust'
import type { AttachParams, PluginScope } from '../plugins/api'
import type { Proposal } from '../plugins/proposals'
import type { Loading, Plugins } from '../plugins/plugins'
import type { Plugin } from '../plugins/types'
import type { Hub } from '../hub/hub'
import { attribution, rowText } from '../context/attribution'
import { compile, copyToRun, record, render, saveForSession, type Launch } from '../prompt/compile'
import type { RunRecord } from '../sessions/contracts'
import { isActiveStatus } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import type { ActiveRun, RunRegistry } from '../sessions/registry'
import { findRun, listRuns, loadRun, readEvents, recordedSubagents, saveRun, updateRun } from '../sessions/runStore'
import { combineWorkspaceScope, inspectRunWorkspaceWrite } from '../sessions/workspaceBoundary'
import type { ToolSpec } from '../tools/types'
import { TODO_WRITE } from '../tools/todo'
import { DEFAULT_TOOL_NAMES } from '../tools/definitions'
import { harnessTools } from '../tools/harnessTools'
import { HARNESS_PLUGINS } from '../plugins/builtin'
import * as attachments from '../plugins/attachments'
import { FIRST_PARTY_PLUGINS } from '../plugins/firstParty'
import { createProfile, listProfiles, profileDirs, profileSection, removeProfile, resolveProfile, type ProfileScope } from '../agents/profiles'
import type { TerminalSubagentProfile } from './subagentMonitor'
import type { MonitorEntry } from './controller'
import { SESSION_NAME } from '../tools/sessionName'
import { contributionId } from '../plugins/identity'
import type { World } from '../world/world'
import type { Worktrees } from '../worktrees/service'
import { setupScript } from '../worktrees/setup'
import type { AnnotationCapture, CaptureTargetSpec } from '../annotations/capture'
import type { NoteDeliveries } from '../annotations/delivery'
import type { Usage } from '../usage/service'
import type { UsageLimits } from '../usage/limits/service'
import { inspectStep } from '../annotations/inspect'
import * as pageNotes from '../annotations/store'
import { APPS_COMMAND, WIKI_COMMAND } from './cli'
import { SOCKET_ENV, TOKEN_ENV } from './client'
import { TerminalController, type PolicyReply } from './controller'
import { terminalCommandFiles } from './launch'
import { SessionSocket, socketPath } from './socket'
import { harnessLogInfo, readHarnessLogChunk } from './logs'
import { listTerminalTrajectoryRuns, readTerminalTrajectory, latestTerminalTodo } from './trajectory'
import { BrowserControl } from './browserControl'
import { RemoteControl, type RemoteControlOptions, type RemoteSessionPort } from '../remote/service'
import type { RemoteInterfaceChoice } from '../remote/addresses'

/** Identity of the exact resource decision that this terminal was prepared with. */
function resourceIdentity(loading: Loading | null): string {
  if (!loading) return 'null'
  return JSON.stringify({
    extensions: loading.extensionPaths, builtins: loading.builtins, skills: loading.skillPaths,
    prompts: loading.promptPaths, resourceOwners: loading.found.filter(item => (item.kind === 'prompt' || item.kind === 'extension') && item.packageRoot), themes: loading.themePaths, profiles: loading.profilePaths, detached: loading.detached,
    project: loading.projectCode, packages: loading.packageCode
  })
}

/** The files a terminal session needs on disk, outside this process. */
export interface TerminalAssets {
  /** The Node binary that runs the commands. */
  node: string
  /** The built `xagent` command (`dist/cli.js`). */
  cli: string
  /** The built Pi extension (`dist/terminal-pi.js`). */
  piExtension: string
  /** The built OpenTUI frontend (`dist/terminal-opentui.js`). */
  openTui: string
}

/** Where the package's own build puts them. An application that bundles the harness passes its own. */
export function defaultAssets(): TerminalAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const dist = [here, join(here, '..', '..'), join(here, '..', '..', 'dist'), join(here, '..', 'dist')].find((folder) => existsSync(join(folder, 'terminal-pi.js'))) ?? here
  return {
    node: process.execPath,
    cli: join(dist, 'cli.js'),
    piExtension: join(dist, 'terminal-pi.js'),
    openTui: join(dist, 'terminal-opentui.js')
  }
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
  /** The variant the session runs; its version is pinned for the session. */
  variant?: VariantChoice | null
  /** Give the session the connected-apps broker. Defaults to yes. */
  connections?: boolean
  /** Fields copied onto each run this session records. */
  run?: Partial<Pick<RunRecord, 'mode' | 'worktreeId'>>
}

/** What a session asked to restart as: another account, or another folder (a worktree or the main checkout). */
export interface TerminalRelaunch {
  accountId: string
  nativeSessionId: string | null
  /** Restart in this folder, as a new conversation there. */
  cwd?: string
  /** The managed worktree the new folder belongs to; null for the main checkout. */
  worktreeId?: string | null
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
  variant: Materialised | null
}

export interface TerminalsOptions {
  doctor?: import('../doctor/service').Doctor
  /** Which plugin code in variants a person trusted. */
  trust?: VariantTrust | null
  subagents?: Subagents
  /** Shared tool-free side-question runs. */
  sideQuestions?: SideQuestions
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
  /** Web, browser and computer tools, offered when their plugins are on. */
  world?: World
  /** Managed worktrees: a session naming one works in it and holds it while it lives. */
  worktrees?: Worktrees
  /** The visible browser a person captures page notes in. */
  noteCapture?: AnnotationCapture
  /** Page notes on their way to a session (PROP-0018). */
  pageNotes?: NoteDeliveries
  /** Usage analytics over the derived ledger (`/usage:analysis`). */
  usage?: Usage
  /** Provider plan windows, balances and rate limits (`/usage:limit`). */
  usageLimits?: UsageLimits
  /** Where `/remote-control` listens; tests bind loopback here. */
  remoteControl?: RemoteControlOptions
}

/** What `/plugins` in a terminal can do. Each takes the session's folder, account and project. */
export interface PluginControl {
  list(scope: PluginScope): Promise<Plugin[]>
  attach(params: AttachParams, on: boolean): Promise<Plugin[]>
  trust(scope: PluginScope & { hash: string }): Promise<Plugin[]>
  untrust(scope: PluginScope & { hash: string }): Promise<Plugin[]>
  /** Saves numbers a person set on a plugin; each is checked against the plugin's settings. */
  configure(params: PluginScope & { pluginId: string; settings: Record<string, unknown> }): Promise<Plugin[]>
  install?(params: PluginScope & { source: string }): Promise<Plugin[]>
  remove?(params: PluginScope & { pluginId: string }): Promise<Plugin[]>
  proposals?: {
    list(): Proposal[] | Promise<Proposal[]>
    preview(id: string): Proposal | Promise<Proposal>
    accept(id: string, hash: string): Proposal | Promise<Proposal>
    reject(id: string, hash: string): Proposal | Promise<Proposal>
  }
}

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export class Terminals {
  private readonly sessions = new Map<string, Live>()
  private readonly diagnosticOwners = new Map<string, string>()
  /** The variant each live session runs, for loading its skills. */
  private readonly variantDirs = new Map<string, string>()
  /** The subagent profile files each live session's packages bring, chosen when it started. */
  private readonly packageProfiles = new Map<string, string[]>()
  /** The world tools each session was given, so a call can only reach one of them. */
  private readonly worldNames = new Map<string, Set<string>>()
  private readonly worldReadOnly = new Set<string>()
  private readonly socket: SessionSocket
  private readonly assets: TerminalAssets
  /** A session's `/accounts` or `/worktree` switch, taken once its Pi process has ended. */
  private readonly relaunches = new Map<string, TerminalRelaunch>()
  /** The managed worktree each live session holds. */
  private readonly worktreeLeases = new Map<string, string>()
  /** `/remote-control` for each live session that opened it. */
  private readonly remotes = new Map<string, RemoteControl>()

  /** Each child's profile name and colour, looked up once per child run. */
  private readonly childProfiles = new Map<string, TerminalSubagentProfile | null>()

  private subagentProfile(record: RunRecord): TerminalSubagentProfile | null {
    if (!record.profile) return null
    if (!this.childProfiles.has(record.id)) {
      if (this.childProfiles.size > 500) this.childProfiles.clear()
      let color = 'blue'
      try { color = resolveProfile(this.options.env.root, record.workingDirectory, record.profile)?.color ?? color } catch {}
      this.childProfiles.set(record.id, { name: record.profile, color })
    }
    return this.childProfiles.get(record.id) ?? null
  }

  /** Account, model and effort for a monitor row, from the run record. */
  private monitorRuntime(live: Live, record: RunRecord): MonitorEntry['runtime'] {
    let accountLabel: string | null = record.accountId === live.account.id ? live.account.label : null
    if (accountLabel === null && record.accountId) {
      try { accountLabel = this.options.accounts.find(record.accountId).label } catch {}
    }
    return { accountLabel, model: record.model ?? null, effort: (record.effort as Effort | null | undefined) ?? null }
  }

  /**
   * Shows the reopened conversation's latest parent run again: the last owner on its native branch
   * that ran in this folder, with every descendant flat, as each ended.
   */
  private hydrateMonitor(live: Live, owners: readonly string[]): void {
    const { root } = this.options.env
    const native = live.controller.nativeSessionId
    if (!native) return
    for (const id of [...owners].reverse()) {
      const record = findRun(root, id)
      if (!record || record.relation || record.nativeSessionId !== native || record.workingDirectory !== live.input.cwd) continue
      const children: RunRecord[] = []
      const seen = new Set([record.id])
      const visit = (parentId: string): void => {
        for (const childId of recordedSubagents(root, parentId)) {
          if (seen.has(childId)) continue
          seen.add(childId)
          const child = findRun(root, childId)
          if (child?.relation !== 'subagent') continue
          children.push(child)
          visit(child.id)
        }
      }
      visit(record.id)
      const entry = (run: RunRecord, profile: TerminalSubagentProfile | null = null): MonitorEntry => ({ record: run, events: readEvents(root, run.id), profile, runtime: this.monitorRuntime(live, run) })
      live.controller.restoreMonitor(entry(record), children.map(child => entry(child, this.subagentProfile(child))))
      return
    }
  }

  constructor(private readonly options: TerminalsOptions) {
    this.assets = options.assets ?? defaultAssets()
    options.runs.listen(event => {
      const session = this.sessions.get(event.sessionId)
      session?.controller.observe(event)
      const record = findRun(options.env.root, event.runId)
      if (record && !record.relation && session) {
        session.controller.observeMain(record, event, this.monitorRuntime(session, record))
        return
      }
      if (record?.relation !== 'subagent') return
      let parentId = record.parentRunId
      const seen = new Set<string>()
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = findRun(options.env.root, parentId)
        if (!parent) break
        const owner = this.sessions.get(parent.sessionId)
        if (owner?.controller.activeRun?.runId === parent.id) {
          owner.controller.observe(event, true)
          const settings = options.subagents?.runtimeSettings(record.id)
          owner.controller.observeSubagent(parent.id, record, event, this.subagentProfile(record), {
            accountLabel: owner.account.label,
            model: settings?.model ?? record.model ?? null,
            effort: settings?.effort ?? (record.effort as Effort | null | undefined) ?? null
          })
          break
        }
        parentId = parent.parentRunId
      }
    })
    this.socket = new SessionSocket(socketPath(options.stateDir), {
      memory: (caller, call, params) => dispatch(options.env, caller, call, params, { variantDir: (caller.sessionId && this.variantDirs.get(caller.sessionId)) || null }),
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

  /**
   * The harness's own History, Wiki and skill tools, then the broker's, then the world tools whose
   * plugins are on for this session: the same tools a structured session has (INV-PAR-1).
   */
  private async tools(session: BrokerSession, listing: boolean): Promise<ToolSpec[]> {
    const brokered = this.options.apps.brokerTools(session)
    const live = this.sessions.get(session.sessionId)
    if (!live) return brokered
    const own = await this.ownTools(live, listing)
    const { world } = this.options
    if (!world) return [...own, ...brokered]
    const context = { run: live.controller.activeRun, caller: live.caller, attended: true, subagent: false, sessionKey: session.sessionId, cwd: live.input.cwd }
    if (!listing) return [...own, ...brokered, ...world.tools(context, (_plugin, tool) => this.worldNames.get(session.sessionId)?.has(tool) ?? false)]
    const on = await this.worldOn(live)
    const tools = world.tools(context, (plugin, tool) => on(plugin, tool))
    this.worldNames.set(session.sessionId, new Set(tools.map((tool) => tool.name)))
    for (const tool of tools) if (tool.readOnly) this.worldReadOnly.add(tool.name)
    return [...own, ...brokered, ...tools]
  }

  private readonly ownNames = new Map<string, Set<string>>()

  private async ownTools(live: Live, listing: boolean): Promise<ToolSpec[]> {
    const sessionId = live.caller.sessionId!
    const caller = { ...live.caller, runId: live.controller.activeRun?.runId ?? null }
    const all = harnessTools(this.options.env, caller, { variantDir: this.variantDirs.get(sessionId) ?? null })
      .filter((tool) => DEFAULT_TOOL_NAMES.includes(tool.name))
    if (!listing) return all.filter((tool) => this.ownNames.get(sessionId)?.has(tool.name) ?? false)
    const on = await this.worldOn(live)
    const owner = (tool: string): string | null => HARNESS_PLUGINS.find((plugin) => plugin.tools?.some((entry) => entry.name === tool))?.id ?? null
    const tools = all.filter((tool) => {
      const plugin = owner(tool.name)
      return !plugin || on(plugin, tool.name)
    })
    this.ownNames.set(sessionId, new Set(tools.map((tool) => tool.name)))
    for (const tool of tools) if (tool.readOnly) this.worldReadOnly.add(tool.name)
    return tools
  }

  /** The world tools a new session will have, named in its instructions. */
  private async worldToolNames(input: TerminalPrepareInput, account: Account): Promise<string[]> {
    const { world } = this.options
    if (!world || input.connections === false) return []
    const list = this.options.pluginControl?.list
    const plugins = list ? await list({ cwd: input.cwd, accountId: account.id, projectId: input.projectId ?? null }) : null
    const on = plugins ? new Set(plugins.flatMap((plugin) => plugin.contributions.filter((item) => item.state === 'on').map((item) => item.id))) : null
    return world.plugins.flatMap((plugin) => (plugin.tools ?? []).map((tool) => tool.name).filter((name) => !on || on.has(contributionId(plugin.id, 'tool', name))))
  }

  /** The harness's own History, Wiki and skill tools a new session will have. */
  private async ownToolNames(input: TerminalPrepareInput, account: Account): Promise<string[]> {
    const list = this.options.pluginControl?.list
    const plugins = list ? await list({ cwd: input.cwd, accountId: account.id, projectId: input.projectId ?? null }) : null
    const on = plugins ? new Set(plugins.flatMap((plugin) => plugin.contributions.filter((item) => item.state === 'on').map((item) => item.id))) : null
    return DEFAULT_TOOL_NAMES.filter((name) => {
      const plugin = HARNESS_PLUGINS.find((entry) => entry.tools?.some((tool) => tool.name === name))
      return !on || !plugin || on.has(contributionId(plugin.id, 'tool', name))
    })
  }

  /** Whether a world tool's plugin is switched on for a session's folder, account and project. */
  private async worldOn(live: Live): Promise<(plugin: string, tool: string) => boolean> {
    const list = this.options.pluginControl?.list
    if (!list) return () => true
    const plugins = await list({ cwd: live.input.cwd, accountId: live.account.id, projectId: live.input.projectId ?? null })
    const on = new Set(plugins.flatMap((plugin) => plugin.contributions.filter((item) => item.state === 'on').map((item) => item.id)))
    return (plugin, tool) => on.has(contributionId(plugin, 'tool', tool))
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
        return { tools: (await this.tools(session, true)).map((tool) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters(Type) })) }
      }
      case 'firstParty.list': {
        // The harness's own extensions switched on for this session, with their settings.
        const live = this.sessions.get(session.sessionId)
        const list = this.options.pluginControl?.list
        if (!live || !list) return { plugins: [] }
        const plugins = await list({ cwd: live.input.cwd, accountId: live.account.id, projectId: live.input.projectId ?? null })
        const on = new Set(plugins.flatMap((plugin) => plugin.contributions.filter((item) => item.state === 'on').map((item) => item.id)))
        const settings = attachments.load(this.options.env.root).settings
        return { plugins: FIRST_PARTY_PLUGINS.filter((plugin) => plugin.code?.some((code) => on.has(`${plugin.id}/code/${code.name}`))).map((plugin) => ({ id: plugin.id, settings: settings[plugin.id] ?? {} })) }
      }
      case 'tools.call': {
        const tool = (await this.tools(session, false)).find((candidate) => candidate.name === params.name)
        if (!tool) throw new HarnessError('unknown_method', `Unknown tool ${String(params.name)}.`)
        const result = await tool.execute((params.input && typeof params.input === 'object' ? params.input : {}) as Record<string, unknown>)
        if (typeof result === 'string') return { text: result }
        const images = [...(result.image ? [result.image] : []), ...(result.images ?? [])]
        return { text: result.text, ...(images.length ? { images } : {}), ...(result.details ? { details: result.details } : {}) }
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
      case 'plugins.proposals.list':
        if (!api.proposals) throw invalid('Proposal review is unavailable in this host.')
        return api.proposals.list()
      case 'plugins.proposals.preview':
        if (!api.proposals) throw invalid('Proposal review is unavailable in this host.')
        return api.proposals.preview(text('id'))
      case 'plugins.proposals.accept':
      case 'plugins.proposals.reject':
        if (!api.proposals) throw invalid('Proposal review is unavailable in this host.')
        return api.proposals[call === 'plugins.proposals.accept' ? 'accept' : 'reject'](text('id'), text('hash'))
      case 'plugins.attach':
      case 'plugins.detach':
        return api.attach({ ...scope, id: text('id'), scope: params.everywhere === true || !projectId ? {} : { projectId } }, call === 'plugins.attach')
      case 'plugins.trust':
        return api.trust({ ...scope, hash: text('hash') })
      case 'plugins.untrust':
        return api.untrust({ ...scope, hash: text('hash') })
      case 'plugins.configure': {
        const settings = params.settings && typeof params.settings === 'object' && !Array.isArray(params.settings) ? params.settings as Record<string, unknown> : {}
        return api.configure({ ...scope, pluginId: text('pluginId'), settings })
      }
      case 'plugins.install':
        if (!api.install) throw invalid('Package installation is unavailable in this host.')
        return api.install({ ...scope, source: text('source') })
      case 'plugins.remove':
        if (!api.remove) throw invalid('Package removal is unavailable in this host.')
        return api.remove({ ...scope, pluginId: text('pluginId') })
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
      // A terminal reads and writes only its own account's choices, never the id a caller names.
      case 'accounts.choices.get':
        return accounts.choices(live.account.id)
      case 'accounts.choices.set':
        return accounts.choose(live.account.id, text('mode'), {
          ...(typeof params.model === 'string' ? { model: params.model } : {}),
          ...(typeof params.effort === 'string' ? { effort: params.effort as Effort } : {})
        })
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

  /** `/agents`: the agent profiles this session's folder can use (PROP-0029). */
  private agentsCall(live: Live, call: string, params: Record<string, unknown>): unknown {
    const root = this.options.env.root
    const cwd = live.input.cwd
    const name = (): string => {
      if (typeof params.name !== 'string' || !params.name.trim()) throw invalid('A profile name is required.')
      return params.name.trim()
    }
    const scope = (): ProfileScope => {
      if (params.scope !== 'global' && params.scope !== 'project') throw invalid('scope must be global or project.')
      return params.scope
    }
    switch (call.slice('terminal.agents.'.length)) {
      case 'list': return { ...listProfiles(root, cwd, this.variantDirs.get(live.input.sessionId) ?? null, this.packageProfiles.get(live.input.sessionId)), dirs: profileDirs(root, cwd) }
      case 'create': return createProfile(root, cwd, { name: name(), scope: scope(), from: typeof params.from === 'string' && params.from ? params.from : null })
      case 'remove': removeProfile(root, cwd, { name: name(), scope: scope() }); return {}
      default: throw invalid('Unknown profile operation.')
    }
  }

  /** `/worktree`: the managed worktrees of the repository this session works in. */
  private async worktreesCall(live: Live, call: string, params: Record<string, unknown>): Promise<unknown> {
    const worktrees = this.options.worktrees
    if (!worktrees) throw invalid('Worktrees are unavailable in this host.')
    const sessionId = live.input.sessionId
    const cwd = live.input.cwd
    const current = this.worktreeLeases.get(sessionId) ?? null
    const id = (): string => {
      if (typeof params.id !== 'string' || !params.id) throw invalid('A worktree id is required.')
      return params.id
    }
    const action = call.slice('terminal.worktrees.'.length)
    switch (action) {
      case 'list': {
        let repo: string
        try {
          repo = await worktrees.repositoryOf(cwd)
        } catch (error) {
          return { repo: null, current, worktrees: [], removed: [], reason: error instanceof Error ? error.message : String(error) }
        }
        const statuses = await Promise.all((await worktrees.list(repo)).map((record) => worktrees.status(record.id)))
        return { repo, current, worktrees: statuses, removed: worktrees.removed(repo), reason: null }
      }
      case 'status': return worktrees.status(id())
      case 'create': return worktrees.create({
        repo: cwd,
        ...(typeof params.name === 'string' && params.name ? { name: params.name } : {}),
        ...(typeof params.branch === 'string' && params.branch ? { branch: params.branch } : {}),
        kind: params.kind === 'permanent' ? 'permanent' : 'managed'
      })
      case 'branch':
        if (typeof params.name !== 'string' || !params.name) throw invalid('A branch name is required.')
        return worktrees.branch(id(), params.name)
      case 'handoff': {
        const direction = params.direction === 'toSource' || params.direction === 'toWorktree' ? params.direction : null
        if (!direction) throw invalid('direction is toSource or toWorktree.')
        return worktrees.handoff(id(), direction, { move: params.move !== false })
      }
      case 'remove':
        if (id() === current) throw new HarnessError('worktree_in_use', 'This session works in that worktree. Switch to another folder first.')
        return worktrees.remove(id(), { force: params.force === true })
      case 'restore': return worktrees.restore(id())
      case 'prune': return worktrees.prune({ repo: cwd, ...(typeof params.keep === 'number' ? { keep: params.keep } : {}) })
      case 'trustSetup': {
        const repo = await worktrees.repositoryOf(cwd)
        const script = setupScript(repo)
        if (!script) throw invalid('This repository has no .xharness/worktree-setup.')
        await worktrees.trustSetup(repo, script.hash)
        return { hash: script.hash }
      }
      case 'switch': {
        // A new conversation in the chosen folder: Pi keeps one history per working folder.
        const target = params.main === true ? null : id()
        const folder = target ? worktrees.pathOf(target) : await worktrees.repositoryOf(cwd)
        if (!folder) throw new HarnessError('worktree_missing', 'That worktree has no folder.')
        this.relaunches.set(sessionId, { accountId: live.account.id, nativeSessionId: null, cwd: folder, worktreeId: target })
        return { cwd: folder, worktreeId: target }
      }
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  /** `/context`: the selected run's request, and one row's text on request. */
  private contextCall(live: Live, params: Record<string, unknown>): unknown {
    if (params.runId !== undefined && (typeof params.runId !== 'string' || !params.runId)) throw invalid('A valid run id is required.')
    const runId = typeof params.runId === 'string' ? params.runId : live.controller.lastRun
    if (!runId) return { attribution: null, text: null }
    if (params.runId !== undefined) readTerminalTrajectory(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId, runId)
    const text = typeof params.section === 'string' && params.section ? rowText(this.options.env, runId, params.section) : null
    return { attribution: attribution(this.options.env, runId), text }
  }

  /** `/usage:analysis` and `/usage:limit`: usage for this session's own account, project or session. */
  private async usageCall(live: Live, call: string, params: Record<string, unknown>): Promise<unknown> {
    const usage = this.options.usage
    const limits = this.options.usageLimits
    if (!usage || !limits) throw invalid('Usage is unavailable in this host.')
    if (call === 'terminal.usage.summary') {
      const scope = params.scope === 'session' || params.scope === 'project' || params.scope === 'all' ? params.scope : 'account'
      if (scope === 'project' && !live.input.projectId) throw invalid('This session has no project to report usage for.')
      const period = params.period === 'today' || params.period === '30d' || params.period === 'all' ? params.period : '7d'
      return usage.summary({
        scope,
        sessionId: live.input.sessionId,
        accountId: live.account.id,
        projectId: live.input.projectId ?? null,
        period,
        timezoneOffsetMinutes: typeof params.timezoneOffsetMinutes === 'number' ? params.timezoneOffsetMinutes : 0
      })
    }
    if (call === 'terminal.usage.limits') {
      return params.refresh === true ? limits.refresh(live.account.id, { force: true }) : limits.read(live.account.id)
    }
    if (call === 'terminal.usage.allLimits') {
      return params.refresh === true ? limits.refresh() : limits.read()
    }
    if (call === 'terminal.usage.headers') {
      if (typeof params.provider !== 'string' || !params.provider) throw invalid('A provider is required.')
      if (typeof params.status !== 'number' || !Number.isFinite(params.status)) throw invalid('A response status is required.')
      const headers = params.headers && typeof params.headers === 'object' && !Array.isArray(params.headers)
        ? Object.fromEntries(Object.entries(params.headers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {}
      if (!Object.keys(headers).length) return {}
      limits.recordHeaders(live.account.id, params.provider, { status: params.status, headers })
      return {}
    }
    throw invalid('Unknown usage operation.')
  }

  /** `/annotate:notes` and `/annotate:`: Web annotations and their visible capture browser. */
  private async annotationsCall(live: Live, call: string, params: Record<string, unknown>): Promise<unknown> {
    const root = this.options.env.root
    const sessionId = live.input.sessionId
    const capture = this.options.noteCapture
    const id = (): string => {
      if (typeof params.id !== 'string' || !params.id) throw invalid('A note id is required.')
      return params.id
    }
    const version = (): number => {
      if (typeof params.expectedVersion !== 'number') throw invalid('The note version you last read is required.')
      return params.expectedVersion
    }
    const needCapture = (): AnnotationCapture => {
      if (!capture) throw invalid('This host has no capture browser.')
      return capture
    }
    const needNotes = (): NoteDeliveries => {
      if (!this.options.pageNotes) throw invalid('This host cannot send page notes.')
      return this.options.pageNotes
    }
    const action = call.slice('terminal.annotations.'.length)
    switch (action) {
      case 'list': {
        const result = pageNotes.list(root, {
          query: typeof params.query === 'string' ? params.query : null,
          url: typeof params.url === 'string' ? params.url : null,
          status: params.status === 'open' || params.status === 'resolved' ? params.status : null,
          limit: 200
        })
        return { ...result, sessionId }
      }
      case 'read': return pageNotes.read(root, id())
      case 'create': {
        const note = pageNotes.create(root, { source: params.source as pageNotes.NoteSource, target: params.target as pageNotes.NoteTarget, body: params.body as string, tags: params.tags as string[] })
        return params.share === true ? needNotes().share(note.id, undefined, sessionId) : note
      }
      case 'update': return pageNotes.update(root, id(), version(), (params.patch ?? {}) as pageNotes.NotePatch)
      case 'delete': pageNotes.remove(root, id(), version()); return {}
      // A terminal shares with, and withdraws from, its own session only.
      case 'share': return needNotes().share(id(), undefined, sessionId)
      case 'unshare': return pageNotes.unshare(root, id(), { sessionId })
      case 'open': return needCapture().open(sessionId, typeof params.url === 'string' && params.url ? params.url : null)
      case 'identity': return needCapture().identity(sessionId)
      case 'begin':
        if (params.kind !== 'text' && params.kind !== 'element') throw invalid('kind is text or element.')
        return needCapture().begin(sessionId, params.kind)
      case 'capture':
        if (typeof params.captureId !== 'string') throw invalid('A capture id is required.')
        return needCapture().capture(sessionId, params.captureId)
      case 'cancel': await needCapture().cancel(sessionId, typeof params.captureId === 'string' ? params.captureId : undefined); return {}
      case 'reveal': {
        const note = pageNotes.read(root, id())
        return needCapture().reveal(sessionId, note.source.url, note.target)
      }
      // ---- The inspector and sending (PROP-0018, PROP-0042); a terminal shares with and sends to its own session.
      case 'target': return { ...needCapture().describe(sessionId), windows: await needCapture().windows(sessionId).catch(() => []) }
      case 'attach': {
        const kind = params.kind
        if (kind !== 'web' && kind !== 'cdp' && kind !== 'bridge') throw invalid('kind is web, cdp or bridge.')
        const spec: CaptureTargetSpec = kind === 'cdp'
          ? { kind, endpoint: typeof params.endpoint === 'string' ? params.endpoint : '', name: typeof params.name === 'string' ? params.name : null }
          : kind === 'bridge' ? { kind, name: typeof params.name === 'string' ? params.name : null } : { kind }
        return needCapture().attach(sessionId, spec)
      }
      case 'windows': return needCapture().windows(sessionId)
      case 'selectWindow':
        if (typeof params.window !== 'string') throw invalid('A window id is required.')
        await needCapture().selectWindow(sessionId, params.window)
        return {}
      case 'inspect': return needCapture().inspect(sessionId)
      case 'stopInspect': await needCapture().stopInspect(sessionId); return {}
      case 'next': return inspectStep(needCapture(), needNotes(), sessionId, sessionId, 'terminal')
      case 'confirm': return needNotes().confirm(id(), version())
      case 'confirmAll': return { notes: needNotes().confirmAll(sessionId) }
      case 'clear': return { notes: needNotes().clear(sessionId) }
      case 'send': return needNotes().send(sessionId, {
        ids: Array.isArray(params.ids) ? params.ids.filter((entry): entry is string => typeof entry === 'string') : null,
        prompt: typeof params.prompt === 'string' ? params.prompt : null
      })
      case 'discover': return { apps: await needCapture().discover() }
      case 'launch':
        if (typeof params.path !== 'string' || !params.path.trim()) throw invalid('Give the path of the app to start.')
        return needCapture().launchApp(sessionId, params.path, Array.isArray(params.args) ? params.args.filter((entry): entry is string => typeof entry === 'string') : [])
      default:
        throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    }
  }

  /** The account a session asked to switch to. Taken once, after its Pi process has ended and before `dispose`. */
  takeRelaunch(sessionId: string): TerminalRelaunch | null {
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
      workspaceRoot: resolveWorkspaceRoot(input.cwd),
      worktreeId: input.run?.worktreeId ?? null,
      goal: text,
      attachmentCount: 0,
      startedAt: now(),
      endedAt: null,
      status: 'queued',
      loadedSkills: [],
      exitCode: null,
      handoffId: null,
      accountId: live.account.id,
      variantScope: live.variant?.scope ?? null,
      variantVersion: live.variant?.fingerprint ?? null
    }
  }

  /** The run a native turn reports into: the one reserved by `send`, or a new one for what the person typed. */
  private begin(live: Live, reservedRunId: string | null, text: string, launch: { model?: string | null; effort?: string | null } = {}): ActiveRun {
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
    if (launch.model || launch.effort) {
      updateRun(root, runId, (record) => {
        if (launch.model) record.model = launch.model
        if (launch.effort) record.effort = launch.effort
      })
    }
    return this.options.runs.start(sessionId, runId)
  }

  private async decide(live: Live, run: ActiveRun, tool: string, args: unknown): Promise<PolicyReply> {
    const record = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(record.status)) throw invalid(`The run is no longer active (its status is ${record.status}).`)
    const name = tool.toLowerCase()
    const workspaceRoot = record.workspaceRoot ?? resolveWorkspaceRoot(record.workingDirectory ?? live.input.cwd)
    if (live.input.readOnly && ['bash', 'edit', 'write'].includes(name)) return { allowed: false, reason: 'This session is read-only.', workspaceRoot }

    let inspection: ReturnType<typeof inspectRunWorkspaceWrite>
    try {
      inspection = inspectRunWorkspaceWrite(record, tool, args)
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : 'The active project workspace could not be verified.', workspaceRoot }
    }
    const call = { run: record, caller: { ...live.caller, runId: run.runId }, tool, args: inspection.input }
    const { policy } = this.options
    if (policy.scope) {
      const scope = combineWorkspaceScope(await policy.scope(call), inspection)
      if (!scope.allowed && (scope.automatic || !scope.requiresApproval)) return { allowed: false, reason: scope.reason ?? 'Outside what this session may do.', workspaceRoot }
      try {
        await policy.authorize?.(call)
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : 'Tool unavailable in the settings.', workspaceRoot }
      }
      const requiresApproval = !!scope.requiresApproval || (scope.allowed && !!scope.humanOnly)
      return {
        allowed: scope.allowed,
        requiresApproval,
        reason: scope.reason ?? null,
        workspaceRoot,
        rememberable: scope.allowed && !scope.humanOnly,
        ...(scope.humanOnly ? { standing: scope.allowGlobalApproval ? 'switch' as const : 'none' as const } : {})
      }
    }
    if (inspection.outside) return { allowed: false, requiresApproval: true, rememberable: false, standing: 'switch', reason: inspection.reason, workspaceRoot }
    if (name === SESSION_NAME || name === TODO_WRITE || name === SPAWN_SUBAGENT || name === WAIT_SUBAGENTS || READ_ONLY_TOOLS.has(name) || this.worldReadOnly.has(name) || this.options.apps.toolNames.includes(name as never) || ['bash', 'edit', 'write'].includes(name)) {
      return { allowed: true, workspaceRoot }
    }
    return { allowed: false, requiresApproval: true, rememberable: true, reason: 'This native action requires approval.', workspaceRoot }
  }

  private async workspaceEscape(live: Live, run: ActiveRun, tool: string, args: unknown, reason: string): Promise<boolean> {
    if (tool !== 'bash' || live.input.readOnly) return false
    const record = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(record.status) || (record.trigger != null && record.trigger !== 'user')) return false
    const call = { run: record, caller: { ...live.caller, runId: run.runId }, tool, args }
    const scope = (await this.options.policy.scope?.(call)) ?? { allowed: true }
    if (scope.automatic || (!scope.allowed && !scope.requiresApproval)) return false
    try {
      await this.options.policy.authorize?.(call)
    } catch {
      return false
    }
    const operationArgs = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>
    const command = typeof operationArgs.command === 'string' ? operationArgs.command : ''
    if (operationArgs.workspaceWriteScope !== 'outside' || !command) return false
    const workspaceRoot = record.workspaceRoot ?? resolveWorkspaceRoot(record.workingDirectory ?? live.input.cwd)
    const decision = await run.requestApproval({
      target: 'workspace-write',
      action: `${reason} Workspace: ${workspaceRoot}. This exact command will run once with broader filesystem access.\n\nCommand:\n${formatBashCommandForApproval(command)}`,
      operation: { tool, args: operationArgs },
      rememberable: false,
      standing: 'none'
    })
    if (decision !== 'approved') return false
    const currentRecord = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(currentRecord.status) || (currentRecord.trigger != null && currentRecord.trigger !== 'user')) return false
    const currentCall = { run: currentRecord, caller: { ...live.caller, runId: run.runId }, tool, args: operationArgs }
    const currentScope = (await this.options.policy.scope?.(currentCall)) ?? { allowed: true }
    if (currentScope.automatic || (!currentScope.allowed && !currentScope.requiresApproval)) return false
    try {
      await this.options.policy.authorize?.(currentCall)
      return true
    } catch {
      return false
    }
  }

  private async workspaceBoundaryBypass(live: Live, run: ActiveRun, tool: string, args: unknown): Promise<boolean> {
    if (tool !== 'bash' || live.input.readOnly || !this.options.approvals.isAuto('pi')) return false
    const record = loadRun(this.options.env.root, run.runId)
    if (!isActiveStatus(record.status) || (record.trigger != null && record.trigger !== 'user')) return false
    const operationArgs = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>
    if (typeof operationArgs.command !== 'string' || !operationArgs.command) return false
    const call = { run: record, caller: { ...live.caller, runId: run.runId }, tool, args: operationArgs }
    try {
      const scope = (await this.options.policy.scope?.(call)) ?? { allowed: true }
      if (scope.automatic || (!scope.allowed && !scope.requiresApproval) || (scope.humanOnly && !scope.allowGlobalApproval)) return false
      await this.options.policy.authorize?.(call)
      return true
    } catch {
      return false
    }
  }

  private async subagentsCall(live: Live, call: string, params: Record<string, any>): Promise<unknown> {
    if (call === 'terminal.subagents.monitor') return { children: live.controller.subagentSnapshot() }
    const service = this.options.subagents
    if ((!service || live.input.subagents === null) && call !== 'terminal.subagents.register') {
      if (call === 'terminal.subagents.tools') return { tools: [] }
      throw invalid('Subagents are disabled for this terminal.')
    }
    if (call === 'terminal.subagents.tools') {
      const variantDir = this.variantDirs.get(live.input.sessionId) ?? null
      const packaged = this.packageProfiles.get(live.input.sessionId) ?? []
      return {
        tools: subagentTools(service!, '').map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters(Type) })),
        profiles: {
          normal: profileSection(this.options.env.root, live.input.cwd, variantDir, false, undefined, packaged).body,
          plan: profileSection(this.options.env.root, live.input.cwd, variantDir, true, undefined, packaged).body
        }
      }
    }
    const run = live.controller.activeRun
    if (!run) throw new HarnessError('run_not_active', 'This terminal has no active parent run.')
    if (call === 'terminal.subagents.planSafe') {
      const reason = service!.planSpawnRefusal(run.runId, params.input)
      return { allowed: reason === null, ...(reason ? { reason } : {}) }
    }
    if (call === 'terminal.subagents.register') {
      if (!Array.isArray(params.tools) || params.tools.some((name: unknown) => typeof name !== 'string')) throw invalid('Native tool names are required.')
      if (params.plan !== undefined && typeof params.plan !== 'boolean') throw invalid('plan must be a boolean.')
      const readOnly = live.input.readOnly === true
      const readTools = new Set([...READ_ONLY_TOOLS, SESSION_NAME, TODO_WRITE, SPAWN_SUBAGENT, WAIT_SUBAGENTS, 'ask_user', 'mcp_list_tools', 'mcp_call_tool', 'history_search', 'history_read', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts', 'skill_load'])
      const tools = [...new Set(params.tools as string[])].filter(name =>
        (!readOnly || readTools.has(name)) && (params.plan === true || (name !== 'ask_user' && name !== 'ask_user_question')))
      const caller = { ...live.caller, runId: run.runId }
      const capabilities = this.options.resolveCapabilities ? await this.options.resolveCapabilities(caller, tools, live.input.cwd) : { version: 1 as const, tools, connectors: [], contributions: [] }
      const variantDir = this.variantDirs.get(live.input.sessionId) ?? null
      const packaged = this.packageProfiles.get(live.input.sessionId) ?? []
      const subagentProfiles = {
        normal: profileSection(this.options.env.root, live.input.cwd, variantDir, false, undefined, packaged).body,
        plan: profileSection(this.options.env.root, live.input.cwd, variantDir, true, {
          frozenTools: capabilities.tools,
          contributions: capabilities.contributions,
          descriptors: HARNESS_PLUGINS
        }, packaged).body
      }
      freezeRun(this.options.env.root, run.runId, caller, capabilities)
      updateRun(this.options.env.root, run.runId, (record) => { record.effectiveMode = params.plan === true ? 'plan' : 'normal' })
      if (!service || live.input.subagents === null) return { runId: run.runId, connectors: capabilities.connectors, subagentProfiles }
      service.register({
        run: { id: run.runId, sessionId: live.input.sessionId, mode: live.input.run?.mode ?? 'code', projectId: live.input.projectId, worktreeId: live.input.run?.worktreeId },
        cwd: live.input.cwd, sessionDir: this.historyDir(live.input), text: '', caller: live.caller,
        model: typeof params.model === 'string' ? params.model : live.input.model,
        effort: typeof params.effort === 'string' ? params.effort as Effort : null,
        launch: live.input.launch, tools: { allow: capabilities.tools, gated: capabilities.tools.filter(name => !readTools.has(name)) },
        connections: live.input.connections === false ? false : { readOnly }, subagents: live.input.subagents,
        plan: params.plan === true,
        variant: live.variant ? { dir: live.variant.dir, scope: live.variant.scope } : null,
        packageProfiles: packaged,
        capabilities
      }, live.account.id, capabilities)
      const history = params.history ?? { owners: [], receipts: [] }
      service.restore(run.runId, history)
      // Children an earlier reply left stopped, reported before the model answers.
      const notice = await service.delivery(run.runId, history, false)
      return { runId: run.runId, connectors: capabilities.connectors, subagentProfiles, notice }
    }
    if (call === 'terminal.subagents.verify') { await service!.verify(run.runId, params.history); return {} }
    if (call === 'terminal.subagents.delivery') return service!.delivery(run.runId, params.history, params.settle === true)
    if (call === 'terminal.subagents.call') {
      const tool = subagentTools(service!, run.runId).find(tool => tool.name === params.name)
      if (!tool) throw invalid('Unknown subagent tool.')
      const reason = await this.decide(live, run, tool.name, params.input ?? {})
      if (!reason.allowed) throw new HarnessError('tool_denied', reason.reason ?? 'Subagents are unavailable.')
      const result = await tool.execute(params.input ?? {})
      return typeof result === 'string' ? { text: result } : result
    }
    throw invalid('Unknown subagent operation.')
  }

  private componentsCall(live: Live, call: string, params: Record<string, unknown>): unknown {
    const root = this.options.env.root
    const choice = live.input.variant
    const scope = choice && 'scope' in choice ? choice.scope ?? null : null
    const head = scope ? variantStore.headVariant(root, scope) : null
    const items = componentLibrary.list(root)

    if (call === 'terminal.components.list') {
      return {
        items,
        addedIds: head ? items.filter(item => componentLibrary.isInVariant(root, head.variant, item.id)).map(item => item.id) : [],
        writable: Boolean(scope && head),
        fingerprint: head?.fingerprint ?? null
      }
    }
    if (call === 'terminal.components.add') {
      if (typeof params.id !== 'string' || !params.id) throw invalid('A component id is required.')
      if (!scope || !head) throw invalid('This terminal has no writable Harness scope.')
      const item = items.find(candidate => candidate.id === params.id)
      if (!item) throw invalid('That component is no longer in the library.')
      if (item.kind === 'prompts') throw invalid('Prompts stay in the library and cannot be added to a Variant.')
      if (componentLibrary.isInVariant(root, head.variant, item.id)) {
        return { fingerprint: head.fingerprint, alreadyPresent: true }
      }
      const variant = componentLibrary.addToVariant(root, head.variant, item.id)
      const record = variantStore.commit(root, scope, variant, {
        kind: 'edit', note: 'Added library component ' + item.id, components: [item.id]
      })
      this.options.bus.emit({ type: 'variants.changed', scope })
      return { fingerprint: record.fingerprint, alreadyPresent: false }
    }
    throw new HarnessError('unknown_method', 'Unknown terminal component operation.')
  }

  private trajectoryCall(live: Live, call: string, params: Record<string, unknown>): unknown {
    if (call === 'terminal.trajectory.list') {
      return { runs: listTerminalTrajectoryRuns(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId) }
    }
    if (call === 'terminal.trajectory.details') {
      if (typeof params.runId !== 'string' || !params.runId) throw invalid('A run id is required.')
      readTerminalTrajectory(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId, params.runId)
      return runDetails(this.options.env.root, params.runId)
    }
    if (call === 'terminal.trajectory.events') {
      if (typeof params.runId !== 'string' || !params.runId) throw invalid('A run id is required.')
      const afterSequence = params.afterSequence
      if (afterSequence !== undefined && typeof afterSequence !== 'number') throw invalid('The event sequence must be a number.')
      return readTerminalTrajectory(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId, params.runId, afterSequence as number | undefined)
    }
    throw new HarnessError('unknown_method', `Unknown call ${call}.`)
  }

  private async sideQuestionCall(live: Live, call: string, params: Record<string, unknown>): Promise<unknown> {
    const service = this.options.sideQuestions
    if (!service) throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    if (call === 'terminal.sideQuestions.start') {
      if (typeof params.question !== 'string') throw invalid('A side question is required.')
      const context = params.context && typeof params.context === 'object' && !Array.isArray(params.context)
        ? params.context as SideQuestionContext
        : undefined
      const latest = listTerminalTrajectoryRuns(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId)
        .find(run => findRun(this.options.env.root, run.id)?.trigger !== 'side-question')
      return service.start({
        sessionId: live.input.sessionId,
        parentRunId: live.controller.activeRun?.runId ?? latest?.id ?? null,
        parentSessionId: live.input.sessionId,
        accountId: live.account.id,
        model: typeof params.model === 'string' ? params.model : live.input.model ?? null,
        effort: typeof params.effort === 'string' ? params.effort as Effort : undefined,
        cwd: live.input.cwd,
        caller: live.caller,
        question: params.question,
        context
      })
    }
    if (typeof params.runId !== 'string') throw invalid('A side-question run id is required.')
    if (call === 'terminal.sideQuestions.read') {
      const afterSequence = params.afterSequence === undefined ? -1 : params.afterSequence
      if (typeof afterSequence !== 'number') throw invalid('A side-question event sequence is required.')
      return service.read(params.runId, live.input.sessionId, afterSequence)
    }
    if (call === 'terminal.sideQuestions.interrupt') return service.interrupt(params.runId, live.input.sessionId)
    throw new HarnessError('unknown_method', `Unknown call ${call}.`)
  }

  /** The only terminal frontend: the Bun-run OpenTUI application. */
  private frontendCommand(): { program: string; argsPrefix: string[] } {
    return {
      program: process.env.XINGULAR_HARNESS_BUN || 'bun',
      // Solid must resolve to its client build for OpenTUI's effects, wherever it is imported.
      argsPrefix: ['--conditions=browser', this.assets.openTui]
    }
  }

  /**
   * Prepares an OpenTUI terminal session and returns what to spawn. The caller must report the
   * process's end with `dispose`, also when it never starts.
   */
  async prepare(input: TerminalPrepareInput): Promise<TerminalLaunch> {
    input = structuredClone(input)
    const { env, accounts, apps, bus } = this.options
    const { root } = env
    if (!input?.sessionId || !input.cwd || !input.sessionFolder) throw invalid('A terminal session needs an id, a working folder, and its own folder.')
    await this.dispose(input.sessionId)
    const sessionId = input.sessionId
    let acquiredWorktreeId: string | null = null
    let account: Account | null = null
    let accountStarted = false
    let token: string | null = null
    try {
      const worktreeId = input.run?.worktreeId ?? null
      const worktreePath = worktreeId ? this.options.worktrees?.pathOf(worktreeId) ?? null : null
      if (worktreeId && worktreePath) {
        await this.options.worktrees!.acquire(worktreeId, sessionId)
        acquiredWorktreeId = worktreeId
        this.worktreeLeases.set(sessionId, worktreeId)
        input.cwd = worktreePath
      }
      const command = this.frontendCommand()
      // A pinned account is used as it is; it is never exchanged for another one.
      const preparedAccount = input.accountId ? accounts.find(input.accountId) : accounts.resolve(null, null)
      account = preparedAccount
      const launch = launchEnv(accounts.dir, preparedAccount)
      const loading = (await this.options.plugins?.loading({ cwd: input.cwd, agentDir: configDir(accounts.dir, preparedAccount), install: true, caller: { projectId: input.projectId ?? null } })) ?? null
      await this.socket.listen()
      await accounts.terminalBegin(preparedAccount)
      accountStarted = true

      const caller: CallerContext = { sessionId, projectId: input.projectId ?? null, actor: 'Code', surface: 'cli' }
      const broker = input.connections === false ? null : apps.grant({ sessionId, runId: null, caller, readOnly: !!input.readOnly, depth: 0 })
      // The session keeps these instructions; each of its runs records a copy, and a memory
      // block that changes later is sent along as a note.
      const variant = input.variant ? materialise(root, input.variant, { trust: this.options.trust ?? null }) : null
      const browser = new BrowserControl({ root, cwd: input.cwd, pinned: variant,
        writable: Boolean(input.variant && !('dir' in input.variant)), apps, hub: this.options.hub,
        plugins: () => this.options.pluginControl?.list({ cwd: input.cwd, accountId: preparedAccount.id, projectId: input.projectId ?? null }) ?? Promise.resolve([]) })
      if (variant) this.variantDirs.set(sessionId, variant.dir)
      this.packageProfiles.set(sessionId, loading?.profilePaths ?? [])
      const worldTools = await this.worldToolNames(input, preparedAccount)
      const ownTools = await this.ownToolNames(input, preparedAccount)
      const launchTools = [...new Set([...(input.launch?.tools ?? []), TODO_WRITE, SESSION_NAME, ...ownTools, ...(broker ? apps.toolNames : []), ...worldTools])]
      // The profiles replace the variant's own subagent list, which they include.
      const profiles = this.options.subagents && input.subagents !== null ? profileSection(root, input.cwd, variant?.dir ?? null, false, undefined, loading?.profilePaths ?? []) : null
      const launchSections = profiles ? [...(input.launch?.sections ?? []).filter((section) => section.id !== profiles.id), profiles] : input.launch?.sections
      // A terminal is a person's own session: the same standard sections a host's session has.
      const standard = input.launch?.standard === null ? null : input.launch?.standard ?? { cwd: input.cwd }
      const pack = compile(env, caller, { ...input.launch, standard, sections: launchSections, tools: launchTools }, variant && profiles ? { ...variant, sections: variant.sections.filter((section) => section.id !== profiles.id) } : variant)
      record(root, pack)
      mkdirSync(this.historyDir(input), { recursive: true })
      saveForSession(input.sessionFolder, pack)

      const live: Live = {
        input,
        variant,
        account: preparedAccount,
        broker,
        caller,
        token: '',
        controller: new TerminalController({
          sessionId,
          nativeSessionId: input.nativeSessionId ?? null,
          begin: ({ reservedRunId, text, model, effort }) => this.begin(live, reservedRunId, text, { model, effort }),
          hydrate: (owners) => this.hydrateMonitor(live, owners),
          policy: (run, tool, args) => this.decide(live, run, tool, args),
          workspaceRoot: run => {
            const record = loadRun(this.options.env.root, run.runId)
            return record.workspaceRoot ?? resolveWorkspaceRoot(record.workingDirectory ?? live.input.cwd)
          },
          workspaceEscape: (run, tool, args, reason) => this.workspaceEscape(live, run, tool, args, reason),
          workspaceBoundaryBypass: (run, tool, args) => this.workspaceBoundaryBypass(live, run, tool, args),
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
          if (call === 'terminal.browser.config') {
            const world = this.options.world
            if (!world) throw invalid('Browser settings are unavailable in this host.')
            return { allowPrivate: world.browserConfig().allowPrivate }
          }
          if (call === 'terminal.browser.configure') {
            const world = this.options.world
            if (!world) throw invalid('Browser settings are unavailable in this host.')
            if (typeof params.allowPrivate !== 'boolean') throw invalid('allowPrivate must be a boolean.')
            return { allowPrivate: world.configureBrowser({ allowPrivate: params.allowPrivate }).allowPrivate }
          }
          if (call === 'terminal.browser.snapshot') return browser.snapshot(params.refresh === true)
          if (call === 'terminal.browser.read') {
            if (typeof params.id !== 'string') throw invalid('A resource id is required.')
            return browser.read(params.id, params.latest === true)
          }
          if (call === 'terminal.browser.importSkill') {
            if (typeof params.path !== 'string' || !params.path.trim()) throw invalid('A skill folder is required.')
            browser.importSkill(params.path)
            bus.emit({ type: 'plugins.changed' })
            return {}
          }
          if (call.startsWith('terminal.browser.connections.')) return browser.connection(call.slice('terminal.browser.connections.'.length), params)
          if (call === 'terminal.browser.hubPreview') {
            if (!this.options.hub || typeof params.id !== 'string' || typeof params.version !== 'string') throw invalid('A catalog entry and version are required.')
            return this.options.hub.preview(params.id, params.version, typeof params.offset === 'number' ? params.offset : 0)
          }
          if (call === 'terminal.browser.hubDocument') {
            if (!this.options.hub || typeof params.id !== 'string' || typeof params.version !== 'string') throw invalid('An installed document and version are required.')
            return this.options.hub.readDocument(params.id, params.version)
          }
          if (call.startsWith('terminal.doctor.')) {
            const doctor = this.options.doctor
            if (!doctor) throw invalid('Diagnostics are unavailable in this host.')
            if (call === 'terminal.doctor.start') {
              const model = typeof params.model === 'string' ? params.model : live.input.model ?? null
              const tools = [...new Set([
                ...(Array.isArray(params.tools) ? params.tools.filter((name): name is string => typeof name === 'string') : []),
                ...await this.worldToolNames(live.input, live.account)
              ])]
              const variantDir = this.variantDirs.get(sessionId)
              const report = doctor.start({
                context: { caller: live.caller, cwd: live.input.cwd, accountId: live.account.id, model, tools,
                  variant: variantDir ? { dir: variantDir, scope: live.input.variant?.scope } : null },
                mode: params.mode === 'live' ? 'live' : 'local',
                checks: Array.isArray(params.checks) ? params.checks.filter((id): id is string => typeof id === 'string') : [],
                confirmed: params.confirmed === true
              })
              this.diagnosticOwners.set(report.id, sessionId)
              return report
            }
            const id = typeof params.id === 'string' ? params.id : ''
            if (this.diagnosticOwners.get(id) !== sessionId) throw invalid('This diagnostic job belongs to another terminal.')
            if (call === 'terminal.doctor.read') return doctor.read(id)
            if (call === 'terminal.doctor.cancel') return doctor.cancel(id)
            throw invalid('Unknown diagnostic operation.')
          }
          if (call.startsWith('terminal.agents.')) return this.agentsCall(live, call, params)
          if (call.startsWith('terminal.subagents.')) return this.subagentsCall(live, call, params)
          if (call.startsWith('terminal.sideQuestions.')) return this.sideQuestionCall(live, call, params)
          if (call.startsWith('terminal.worktrees.')) return this.worktreesCall(live, call, params)
          if (call.startsWith('terminal.annotations.')) return this.annotationsCall(live, call, params)
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
          if (call.startsWith('terminal.components.')) return this.componentsCall(live, call, params)
          if (call.startsWith('terminal.trajectory.')) return this.trajectoryCall(live, call, params)
          if (call === 'terminal.todo') return latestTerminalTodo(this.options.env.root, live.input.sessionId, live.controller.nativeSessionId)
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
          if (call.startsWith('terminal.usage.')) return this.usageCall(live, call, params)
          if (call === 'terminal.context') return this.contextCall(live, params)
          if (call.startsWith('terminal.remoteControl.')) return this.remoteCall(live, call, params)
          if (call !== 'terminal.resources') return live.controller.control(call, params)
          const current = await this.options.plugins?.loading({ cwd: input.cwd, agentDir: configDir(accounts.dir, preparedAccount), install: false, caller: { projectId: input.projectId ?? null } }) ?? null
          const currentVariant = variant ? materialise(root, { dir: variant.dir, scope: variant.scope }, { trust: this.options.trust ?? null }) : null
          if (resourceIdentity(current) !== resourceIdentity(loading) || (variant && (currentVariant?.fingerprint !== variant.fingerprint || JSON.stringify(currentVariant.extensionPaths) !== JSON.stringify(variant.extensionPaths)))) {
            throw new HarnessError('terminal_resources_changed', 'Trusted resources changed since this terminal was prepared. Review /plugins and reopen the terminal to load the new selection.')
          }
          const resourceOwners = (current?.found ?? []).filter(item => item.packageRoot && (item.kind === 'prompt' && current?.promptPaths.includes(item.path) || item.kind === 'extension' && current?.extensionPaths.includes(item.path)))
          return resourceOwners.length ? { resourceOwners } : {}
        } }
      })
      live.token = token
      this.sessions.set(sessionId, live)

      const args = [...command.argsPrefix, '--append-system-prompt', render(env, pack)]
      if (input.model) args.push('--model', input.model)
      {
        // Pi's own discovery is off: the terminal loads what the harness found and nothing else.
        args.push('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes')
        // The pi command's own extensions are not loaded: a host's session cannot have them (PROP-0039).
        for (const path of [...(loading?.extensionPaths ?? []), ...(variant?.extensionPaths ?? [])]) args.push('--extension', path)
        for (const path of [...(variant?.skillPaths ?? []), ...defaultSkillPaths(variant?.dir), ...(loading?.skillPaths ?? [])]) args.push('--skill', path)
        for (const path of loading?.promptPaths ?? []) args.push('--prompt-template', path)
        for (const path of loading?.themePaths ?? []) args.push('--theme', path)
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
        accountId: preparedAccount.id,
        nativeSessionId: input.nativeSessionId ?? null
      }
    } catch (error) {
      if (token) this.socket.revoke(token)
      this.sessions.delete(sessionId)
      this.variantDirs.delete(sessionId)
      this.packageProfiles.delete(sessionId)
      this.worldNames.delete(sessionId)
      if (this.worktreeLeases.get(sessionId) === acquiredWorktreeId) this.worktreeLeases.delete(sessionId)
      apps.revokeSession(sessionId)
      if (accountStarted && account) await accounts.terminalEnd(account).catch(() => undefined)
      if (acquiredWorktreeId) await this.options.worktrees?.release(acquiredWorktreeId, sessionId).catch(() => undefined)
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
    copyToRun(root, live.input.sessionFolder, runId)
    try {
      await live.controller.send(runId, input.text)
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

  private remote(live: Live): RemoteControl {
    const sessionId = live.input.sessionId
    let remote = this.remotes.get(sessionId)
    if (!remote) {
      remote = new RemoteControl(this.remotePort(live), { productName: this.options.env.productName, ...this.options.remoteControl })
      this.remotes.set(sessionId, remote)
    }
    return remote
  }

  /**
   * What a paired phone reaches: this session's own runs and the same send, interrupt and
   * decision calls the terminal makes (INV-RC-3).
   */
  private remotePort(live: Live): RemoteSessionPort {
    const { root } = this.options.env
    const sessionId = live.input.sessionId
    const own = new Map<string, boolean>()
    const isOwn = (runId: string): boolean => {
      let known = own.get(runId)
      if (known === undefined) {
        const record = findRun(root, runId)
        known = !!record && !record.relation && record.trigger !== 'side-question'
        if (own.size > 1000) own.clear()
        if (record) own.set(runId, known)
      }
      return known
    }
    return {
      sessionId,
      title: () => basename(live.input.cwd) || this.options.env.productName,
      send: (text) => this.send({ sessionId, text }),
      control: (call, params) => live.controller.control(call, params) as Promise<unknown>,
      history: () => {
        const native = live.controller.nativeSessionId
        if (!native) return []
        const runs = listRuns(root, { sessionId })
          .filter((run) => run.nativeSessionId === native && !run.relation && run.trigger !== 'side-question')
          .slice(0, 20)
          .reverse()
        return runs.flatMap((run) => readEvents(root, run.id))
      },
      listen: (listener) => this.options.runs.listen((event) => {
        if (event.sessionId === sessionId && isOwn(event.runId)) listener(event)
      }),
      state: () => {
        const state = live.controller.state()
        return { ready: state.ready, active: state.active }
      }
    }
  }

  private async remoteCall(live: Live, call: string, params: Record<string, any>): Promise<unknown> {
    const remote = this.remote(live)
    if (call === 'terminal.remoteControl.status') return remote.status()
    if (call === 'terminal.remoteControl.status.wait') return remote.waitStatus(params.revision)
    if (call === 'terminal.remoteControl.start') {
      const choice = params.interface ?? 'auto'
      if (!['auto', 'tailscale', 'lan'].includes(choice)) throw invalid('Choose auto, tailscale or lan.')
      return remote.start(choice as RemoteInterfaceChoice)
    }
    if (call === 'terminal.remoteControl.stop') return remote.stop()
    if (call === 'terminal.remoteControl.rotate') return remote.rotate()
    if (call === 'terminal.remoteControl.confirm') {
      if (typeof params.requestId !== 'string' || typeof params.allow !== 'boolean') throw invalid('A pairing request id and a boolean choice are required.')
      return remote.confirm(params.requestId, params.allow)
    }
    throw new HarnessError('unknown_method', `Unknown terminal control ${call}.`)
  }

  /** The terminal process ended (or never started): its turn, tokens, and written credentials go with it. */
  async dispose(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    for (const [id, owner] of this.diagnosticOwners) if (owner === sessionId) {
      this.options.doctor?.cancel(id)
      this.diagnosticOwners.delete(id)
    }
    this.sessions.delete(sessionId)
    this.worldNames.delete(sessionId)
    const remote = this.remotes.get(sessionId)
    this.remotes.delete(sessionId)
    await remote?.dispose().catch(() => undefined)
    const worktreeId = this.worktreeLeases.get(sessionId)
    this.worktreeLeases.delete(sessionId)
    if (worktreeId) await this.options.worktrees?.release(worktreeId, sessionId).catch(() => undefined)
    void this.options.noteCapture?.release(sessionId).catch(() => undefined)
    void this.options.world?.release(sessionId).catch(() => undefined)
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
