// Starting a session turn: the account, the run record, the compiled prompt, the tools and
// their gate, then Pi. Everything before Pi answers is synchronous with the caller; the reply
// itself streams as run events.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { Accounts } from '../accounts/accounts'
import { log } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import { formatBashCommandForApproval } from '../core/workspaceBashTool'
import { capabilitySet as parseCapabilitySet, freezeRun } from '../capabilities/runSnapshot'
import type { CapabilitySet } from '../capabilities/types'
import { now, writeJson } from '../core/fs'
import { resolveWorkspaceRoot, verifyWorkspaceRoot } from '../core/workspace'
import { takeChars } from '../core/text'
import type { CallerContext } from '../core/caller'
import type { Plugins } from '../plugins/plugins'
import { BUILTIN_PLUGIN_REGISTRY } from '../plugins/builtin'
import { sessionLaunch, type Launch } from '../prompt/compile'
import * as attachments from '../plugins/attachments'
import { FIRST_PARTY_PLUGINS, firstPartyExtensions, type InlineExtension } from '../plugins/firstParty'
import { imagePruning } from '../world/images'
import { materialise, type VariantChoice, type Materialised } from '../variant/materialise'
import { snapshotWorkingTree } from '../worktrees/snapshot'
import type { VariantTrust } from '../variant/trust'
import { ASK_USER } from '../tools/askUser'
import { defaultSkillPaths } from '../tools/defaultSkills'
import { TODO_WRITE } from '../tools/todo'
import { LEGACY_CHECKPOINT_WRITE, checkpointOf } from './checkpoint'
import { FINISH } from '../tools/finish'
import { createStopGateState, stopGate, STOP_GATE_EXTENSION } from './stopGate'
import { SESSION_NAME, deriveSessionName, sessionNameTool } from '../tools/sessionName'
import { DEFAULT_TOOL_NAMES } from '../tools/definitions'
import { GET_CAPABILITIES, getCapabilitiesTool } from '../tools/getCapabilities'
import type { ToolProvider, ToolSession, ToolSpec } from '../tools/types'
import type { DispatchEnv } from '../tools/dispatch'
import { isActiveStatus, stopCodeOf, type RunRecord } from './contracts'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS, subagentDepth, subagentHistory, subagentNesting, type SubagentInput, type SubagentOptions } from './subagents'
import type { Subagents } from './subagentService'
import { selectHistory } from './history'
import { runLineageJoin } from './lineageJoin'
import { latestSessionName, type SessionState } from './sessionState'
import { compactionCheckpoint, COMPACTION_CHECKPOINT_EXTENSION } from './compactionCheckpoint'
import { createSliceState, parseWorkSlice, sliceOf, workSliceGuard, WorkSliceError, WORK_SLICE_EXTENSION, type SlicePolicy, type WorkSliceInput } from './workSlice'
import type { ToolPolicy } from './policy'
import type { ActiveRun, RunRegistry } from './registry'
import { piSessionFactory, runTurn, summarize, type Effort, type PiSessionLike, type SessionCommand, type SessionFactory, type ToolGate, type TurnParams } from './runner'
import { loadRun, readEvents, runDir, saveRun, updateRun } from './runStore'
import { combineWorkspaceScope, inspectRunWorkspaceWrite } from './workspaceBoundary'
import { PLAN_INSTRUCTIONS, PLAN_RESEARCH_SUBAGENT_INSTRUCTIONS, planRefusal, planSection } from './planMode'
import { CONTINUATION_SECTION_ID, continuationOf, continuationSection, type Continuation } from './continuation'
import { deliveredSnapshot } from '../prompt/compile'
import { profileSection } from '../agents/profiles'

/** The fields of a run record the caller decides; the harness fills in the rest. */
export type RunFields = Pick<RunRecord, 'id' | 'sessionId'> & Partial<Pick<RunRecord, 'mode' | 'harness' | 'sessionType' | 'projectId' | 'agentId' | 'trigger' | 'goal' | 'attachmentCount' | 'resumedFromRunId' | 'parentRunId' | 'relation' | 'worktreeId' | 'handoffId' | 'profile' | 'title'>>

export interface SessionRunInput {
  run: RunFields
  /** The account this session is pinned to. A new session may name a pool, or neither for the default. */
  accountId?: string | null
  poolId?: string | null
  model?: string | null
  effort?: Effort | null
  cwd: string
  /** Where this session's native history lives. */
  sessionDir: string
  /** Continue exactly this recorded history; never another one. */
  resume?: { sessionFile?: string | null; nativeSessionId?: string | null } | null
  text: string
  /** Run this user-authored Bash command before prompting the model. */
  initialBashCommand?: string
  /** A prior run's Bash attempt and result, supplied when retrying a ! command. */
  initialBashContext?: {
    runId: string
    status: 'completed' | 'incomplete' | 'unknown'
    ok?: boolean
    output?: string
  }
  images?: { mediaType: string; data: string }[]
  /** Reject a resolved model that cannot inspect image content. */
  requiresImageInput?: boolean
  preamble?: string | null
  /** Unattended: no project extensions, no context files, nothing may ask a person. */
  automatic?: boolean
  /** Who the session works as, for history, the Wiki and the prompt. */
  caller: CallerContext
  /**
   * The variant the session runs: a scope's head (or a version of it), or a variant on disk.
   * Its version is pinned for the whole run and recorded on it.
   */
  variant?: VariantChoice | null
  /**
   * The subagent profile files this session's switched-on packages bring, chosen when it starts.
   * The harness sets it; children of the run resolve their profiles from the same list.
   */
  packageProfiles?: string[]
  /** What the application adds to the prompt, and which tools it describes. */
  launch?: Launch
  /** The tools switched on, in the order the model sees them, and those that ask before each call. */
  tools: { allow: string[]; gated?: string[] }
  /** Give the session the connected-apps broker. */
  connections?: boolean | { readOnly?: boolean }
  /** Optional narrower set for a child run; the harness intersects it with current availability. */
  capabilities?: CapabilitySet
  /** Hops from the user to this session (0 when the user started it). */
  depth?: number
  /** Interactive default: native child tools. Null disables; unattended callers must opt in. */
  subagents?: SubagentOptions | null
  /** Ask the application's tool providers for tools (the default). False runs with the harness's own tools only. */
  providers?: boolean
  /** Give the session the harness's own tools: History, the Wiki, skills, and other defaults. */
  harnessTools?: boolean
  /** Set a provisional name when a top-level session starts unnamed. Defaults to true. */
  autoName?: boolean
  /**
   * Plan mode: an attended run may read, search, recall and ask, and is told to end with a
   * `<proposed_plan>` block. Other calls are refused at the gate; the system prompt stays stable.
   */
  plan?: boolean
  /**
   * Continue a run that stopped before it finished: the earlier run's id. The new run reopens its
   * native history and pins its account, variant version and capability set, and the model is told
   * where it stopped. A work-slice policy may also ask for it when a reply reaches its budget.
   */
  continueFrom?: string | null
  /**
   * Bound this reply (PROP-0041): a tool-call, minute and token budget, then a checkpoint and a
   * continuation. Absent uses the foundation defaults; the policy is carried to the next slice.
   */
  workSlice?: WorkSliceInput
  /**
   * Run a session command instead of sending `text`: compact the context, navigate the history
   * with a summary of the branch left behind, or export it to HTML. It pins the account like a turn.
   */
  command?: SessionCommand
}

/** A session command acts on a saved conversation and is never combined with a request of its own. */
function checkCommand(command: SessionCommand, historyFile: string | null, input: SessionRunInput): void {
  if (!historyFile) throw invalid('There is no saved conversation for this command yet.')
  if (input.plan || input.continueFrom || input.automatic || input.initialBashCommand != null || input.images?.length) {
    throw invalid('A session command runs on its own, without plan mode, a continuation, Bash or images.')
  }
  switch (command?.name) {
    case 'compact': return
    case 'navigate':
      if (typeof command.entryId !== 'string' || !command.entryId) throw invalid('navigate needs the entry to go to.')
      return
    case 'export':
      if (typeof command.path !== 'string' || !isAbsolute(command.path) || !command.path.endsWith('.html')) throw invalid('export needs an absolute .html path.')
      return
    default: throw invalid('Unknown session command.')
  }
}

const CONTINUE_TEXT = 'Continue from where you stopped.'

/** Fills a continuing run's input from the run it continues, refusing anything that would differ. */
function continueInput(root: string, input: SessionRunInput): Continuation {
  const continuation = continuationOf(root, input.continueFrom!, input.sessionDir)
  if (!continuation.resumable || !continuation.resume) throw new HarnessError('continuation_unavailable', `Run ${input.continueFrom} cannot be continued (${continuation.reason ?? 'history_missing'}).`)
  const mismatch = (what: string): HarnessError => new HarnessError('continuation_mismatch', `A continuation keeps the earlier run's ${what}.`)
  if (continuation.capabilities?.tools.includes(ASK_USER)
    && (input.automatic || ['probe', 'improver', 'reflection'].includes(input.run.trigger ?? ''))) {
    throw mismatch('attended question capability')
  }
  if (continuation.sessionId !== input.run.sessionId) throw mismatch('session')
  if (input.resume?.nativeSessionId && input.resume.nativeSessionId !== continuation.resume.nativeSessionId) throw mismatch('history')
  if (input.accountId && input.accountId !== continuation.accountId) throw mismatch('account')
  const pinned = continuation.variant
  const chosen = input.variant ?? null
  if (chosen && (!pinned || 'dir' in chosen || chosen.scope !== pinned.scope || (chosen.version && chosen.version !== pinned.version))) throw mismatch('harness version')
  input.resume = continuation.resume
  input.run.resumedFromRunId ??= continuation.runId
  input.accountId = continuation.accountId
  input.poolId = null
  if (pinned) input.variant = { scope: pinned.scope, version: pinned.version }
  if (!input.capabilities && continuation.capabilities) input.capabilities = continuation.capabilities
  if (!input.text.trim()) input.text = CONTINUE_TEXT
  return continuation
}

/** The connected-apps broker, as a session sees it. */
export interface SessionBroker {
  toolNames: readonly string[]
  tools(session: ToolSession, options: { readOnly: boolean }): ToolSpec[]
}

export interface SessionsOptions {
  subagents: Subagents
  env: DispatchEnv
  accounts: Accounts
  runs: RunRegistry
  policy: ToolPolicy
  broker?: SessionBroker | null
  /** Chooses what a session loads. Without it Pi discovers extensions and skills on its own. */
  plugins?: Plugins
  /** Resolves the caller's capability set from the harness's stores. */
  resolveCapabilities?: (caller: CallerContext, tools: readonly string[], cwd: string) => Promise<CapabilitySet>
  /** Whether the run's explicit Full Permission switch is enabled (remembered tool grants do not count). */
  fullPermission?: (run: RunRecord) => boolean | Promise<boolean>
  factory?: SessionFactory
  /** Which plugin code in variants a person trusted. */
  trust?: VariantTrust | null
  /** Managed worktrees: a run naming one works in its folder and holds it until the run settles. */
  worktrees?: {
    pathOf(id: string): string | null
    acquire(id: string, holder: string): Promise<unknown>
    release(id: string, holder: string): Promise<void>
  } | null
}

/** The harness's own plugins a person switched on for this caller, with the numbers they set. */
function firstPartyFor(root: string, contributions: readonly string[]): InlineExtension[] {
  const choices = attachments.load(root)
  const allowed = new Set(contributions)
  return firstPartyExtensions((id) => FIRST_PARTY_PLUGINS.find((plugin) => plugin.id === id)?.code?.some((code) => allowed.has(`${id}/code/${code.name}`)) ?? false, choices.settings)
}

export class Sessions {
  private readonly providers: ToolProvider[] = []
  private readonly factory: SessionFactory

  constructor(private readonly options: SessionsOptions) {
    this.factory = options.factory ?? piSessionFactory

  }

  private get env(): HarnessEnv {
    return this.options.env
  }

  /** Adds tools an application provides. Providers are asked in the order they were added. */
  provide(provider: ToolProvider): void {
    this.providers.push(provider)
  }

  async diagnostics(context: import('../doctor/types').DoctorContext): Promise<import('../doctor/types').DoctorCheck[]> {
    const results = await Promise.allSettled(this.providers.map(provider => Promise.resolve().then(() => provider.diagnostics?.(context) ?? [])))
    return results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : [{
      id: `provider.${index}`, category: 'tools', title: 'Provider diagnostics',
      local: async () => ({ status: 'fail' as const, evidence: 'This provider could not describe its readiness checks.', remedy: 'Review the provider configuration.' })
    }])
  }

  /** The same registered providers used by real runs; no native Pi session is constructed. */
  async diagnosticTools(session: import('../tools/types').ToolSession): Promise<import('../tools/types').ToolSpec[]> {
    return (await Promise.all(this.providers.map(provider => provider(session)))).flat()
  }

  diagnosticGate(run: ActiveRun, caller: CallerContext) {
    return this.gate(run, caller, new Set(), true)
  }

  private gate(run: ActiveRun, caller: CallerContext, gated: Set<string>, diagnostic = false, automatic = false): ToolGate {
    const { policy } = this.options
    const gate: ToolGate = {
      check: async (name, input) => (await gate.checkDetailed!(name, input))?.reason ?? null,
      ask: (names) => {
        for (const name of names) gated.add(name)
      },
      checkDetailed: async (tool, args) => {
        let record: RunRecord
        let inspection
        try {
          record = loadRun(this.env.root, run.runId)
          inspection = inspectRunWorkspaceWrite(record, tool, args)
        } catch (error) {
          return { code: 'workspace', reason: error instanceof Error ? error.message : 'The active project workspace could not be verified.' }
        }
        const call = { run: record, caller, tool, args: inspection.input }
        const hostScope = (await policy.scope?.(call)) ?? { allowed: true }
        const scope = combineWorkspaceScope(hostScope, inspection)
        if (!scope.allowed && (scope.automatic || (automatic && inspection.outside) || !scope.requiresApproval)) return { code: inspection.outside ? 'workspace' : 'scope', reason: scope.reason ?? 'Outside the approved work scope.' }
        try {
          await policy.authorize?.(call)
        } catch (error) {
          return { code: 'policy', reason: error instanceof Error ? error.message : 'Tool unavailable in the app settings.' }
        }
        if (scope.allowed && !scope.humanOnly && (scope.automatic || !gated.has(tool))) return null
        if (diagnostic) return { code: 'unattended', reason: 'This diagnostic call requires a separate per-call approval.' }
        // Refinement and reflection runs have nobody to ask: what would need a person is refused, never queued.
        if (call.run.trigger === 'probe' || call.run.trigger === 'improver') return { code: 'unattended', reason: scope.reason ? `Refused in a refinement run: ${scope.reason}` : 'Refused in a refinement run: this call needs a person to approve it.' }
        if (call.run.trigger === 'reflection') return { code: 'unattended', reason: scope.reason ? `Refused in a reflection run: ${scope.reason}` : 'Refused in a reflection run: this call needs a person to approve it.' }
        if (automatic) return { code: 'unattended', reason: scope.reason ?? 'Refused in an unattended run: this call needs a person to approve it.' }
        const boundaryAction = inspection.outside ? `${inspection.reason} ${summarize(call.args, tool)}` : summarize(call.args)
        const decision = await run.requestApproval({
          target: tool,
          action: boundaryAction,
          operation: { tool, args: (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown> },
          rememberable: scope.allowed && !scope.humanOnly,
          standing: scope.humanOnly ? (scope.allowGlobalApproval ? 'switch' : 'none') : undefined
        })
        if (decision !== 'approved') return { code: 'approval_denied', reason: 'The user denied this action. Do not repeat it or ask for permission in a message; choose another approach or report what is blocked.' }
        try {
          await policy.authorize?.(call)
        } catch (error) {
          return { code: 'policy', reason: error instanceof Error ? error.message : 'Tool was disabled while waiting.' }
        }
        return null
      },
      workspaceBoundaryBypass: async (tool, args) => {
        if (diagnostic || automatic || tool.toLowerCase() !== 'bash') return false
        const record = loadRun(this.env.root, run.runId)
        if (record.trigger != null && record.trigger !== 'user') return false
        if (!await this.options.fullPermission?.(record)) return false
        const call = { run: record, caller, tool, args }
        const scope = (await policy.scope?.(call)) ?? { allowed: true }
        if (scope.automatic || (!scope.allowed && !scope.requiresApproval) || (scope.humanOnly && !scope.allowGlobalApproval)) return false
        try {
          await policy.authorize?.(call)
          return true
        } catch {
          return false
        }
      },
      requestWorkspaceWriteScope: async (tool, args, reason) => {
        if (diagnostic || automatic || tool.toLowerCase() !== 'bash') return false
        const record = loadRun(this.env.root, run.runId)
        if (!isActiveStatus(record.status) || (record.trigger != null && record.trigger !== 'user')) return false
        const operationArgs = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>
        if (operationArgs.workspaceWriteScope !== 'outside' || typeof operationArgs.command !== 'string' || !operationArgs.command) return false
        const call = { run: record, caller, tool, args: operationArgs }
        const scope = (await policy.scope?.(call)) ?? { allowed: true }
        if (scope.automatic || (!scope.allowed && !scope.requiresApproval)) return false
        try {
          await policy.authorize?.(call)
        } catch {
          return false
        }
        const decision = await run.requestApproval({
          target: 'workspace-write',
          action: `${reason}\n\nCommand to be run once after approval:\n${formatBashCommandForApproval(operationArgs.command)}`,
          operation: { tool, args: operationArgs },
          rememberable: false,
          standing: 'none'
        })
        if (decision !== 'approved') return false
        const currentRecord = loadRun(this.env.root, run.runId)
        if (!isActiveStatus(currentRecord.status) || (currentRecord.trigger != null && currentRecord.trigger !== 'user')) return false
        const currentCall = { run: currentRecord, caller, tool, args: operationArgs }
        const currentScope = (await policy.scope?.(currentCall)) ?? { allowed: true }
        if (currentScope.automatic || (!currentScope.allowed && !currentScope.requiresApproval)) return false
        try {
          await policy.authorize?.(currentCall)
          return true
        } catch {
          return false
        }
      }
    }
    return gate
  }

  /** Compatibility alias for the shared native service. */
  spawnSubagent(request: SubagentInput): Promise<{ runId: string; nativeSessionId: string | null }> {
    return this.options.subagents.spawn(request)
  }

  /**
   * Starts one turn. Returns once the Pi session is open; the reply arrives as run events. A
   * session that cannot be opened ends its run as failed and returns no native session id.
   */
  async run(input: SessionRunInput): Promise<{ runId: string; nativeSessionId: string | null }> {
    if (!input?.run?.id || !input.run.sessionId || typeof input.text !== 'string') throw invalid('A session turn needs a run id, a session, and text.')
    input = structuredClone(input)
    const worktree = await this.enterWorktree(input)
    try {
      return await this.start(input)
    } catch (error) {
      await worktree?.release()
      throw error
    }
  }

  /**
   * A run that names a worktree the harness manages works in that worktree's folder and holds it
   * until the run settles. An id the harness does not know is kept as the caller's own field.
   */
  private async enterWorktree(input: SessionRunInput): Promise<{ release: () => Promise<void> } | null> {
    const id = input.run.worktreeId
    const worktrees = this.options.worktrees
    if (!id || !worktrees) return null
    const path = worktrees.pathOf(id)
    if (!path) return null
    const holder = input.run.sessionId
    await worktrees.acquire(id, holder)
    input.cwd = path
    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      stop()
      await worktrees.release(id, holder).catch(() => undefined)
    }
    const stop = this.options.runs.listen((event) => {
      if (event.runId !== input.run.id) return
      const settled = event.type === 'completed' || event.type === 'failed' || (event.type === 'status.changed' && (event.payload as { status?: string }).status === 'interrupted')
      if (settled) void release()
    })
    return { release }
  }

  /**
   * Starts the next slice when a reply stopped at its work-slice boundary (PROP-0041). Never for
   * unattended, plan, subagent, command or worktree runs, after a blocked or fruitless slice, or
   * past the policy's slice cap. The earlier record is never reopened; this is a new run with the
   * same pins, exactly as an application-asked continuation.
   */
  private async continueSlice(input: { root: string; runId: string; source: SessionRunInput; policy: SlicePolicy }): Promise<void> {
    const { root, runId, source, policy } = input
    if (!policy.enabled || !policy.continue || policy.maxSlices <= 0) return
    if (source.automatic || source.plan || source.command || source.run.relation || source.run.worktreeId) return
    if ((source.depth ?? 0) > 0) return
    const record = loadRun(root, runId)
    if (record.terminalReason !== 'slice_complete') return
    const events = readEvents(root, runId)
    const checkpoint = checkpointOf(events)
    if (checkpoint?.blocked) return
    const progressed = events.some((event) => event.type === 'file.changed')
      || events.some((event) => {
        const payload = event.payload as { name?: unknown; ok?: unknown }
        return event.type === 'tool.completed' && payload.name === 'bash' && payload.ok === true
      })
      || (checkpoint?.done.length ?? 0) > 0
    if (!progressed) return
    if (sliceOf(root, runId) >= policy.maxSlices) return
    const next: SessionRunInput = {
      ...source,
      run: { ...source.run, id: randomUUID(), resumedFromRunId: null, parentRunId: null, relation: null },
      continueFrom: runId,
      text: CONTINUE_TEXT
    }
    next.initialBashCommand = undefined
    next.initialBashContext = undefined
    next.images = undefined
    next.resume = null
    next.command = undefined
    await this.run(next).catch((error) => log(`the next work slice did not start: ${error instanceof Error ? error.message : String(error)}`))
  }

  private async start(input: SessionRunInput): Promise<{ runId: string; nativeSessionId: string | null }> {
    const { root } = this.env
    if ((input.initialBashCommand !== undefined && input.initialBashCommand !== null) || (input.initialBashContext !== undefined && input.initialBashContext !== null)) {
      const request = input.text.trimStart()
      const requestedCommand = /^!\s*([\s\S]+)$/u.exec(request)?.[1]
      if (!requestedCommand?.trim()) throw invalid('An initial Bash command must match a non-empty leading ! command in the user text.')
      if (input.initialBashCommand != null) {
        const matchesRequest = requestedCommand === input.initialBashCommand || requestedCommand.startsWith(`${input.initialBashCommand}\n\nAttached saved file references:`)
        if (!input.initialBashCommand.trim() || !matchesRequest) throw invalid('An initial Bash command must match a non-empty leading ! command in the user text.')
      }
      if (input.initialBashContext != null && (
        input.initialBashCommand != null
        || typeof input.initialBashContext.runId !== 'string'
        || !input.initialBashContext.runId.trim()
        || input.initialBashContext.runId.length > 256
        || typeof input.initialBashContext.status !== 'string'
        || !['completed', 'incomplete', 'unknown'].includes(input.initialBashContext.status)
        || input.initialBashContext.output !== undefined && typeof input.initialBashContext.output !== 'string'
        || (input.initialBashContext.output?.length ?? 0) > 24_000
        || input.initialBashContext.ok !== undefined && typeof input.initialBashContext.ok !== 'boolean'
      )) {
        throw invalid('A prior Bash result must be bounded and must not be combined with a new initial Bash command.')
      }
      if (input.automatic || input.plan || input.resume || input.continueFrom || input.run.relation || input.run.trigger != null && input.run.trigger !== 'user') {
        throw invalid('An initial Bash command is available only for a new interactive user turn.')
      }
    }
    let slicePolicy: SlicePolicy
    try {
      slicePolicy = parseWorkSlice(input.workSlice)
    } catch (error) {
      if (error instanceof WorkSliceError) throw invalid(error.message)
      throw error
    }
    const continuation = input.continueFrom ? continueInput(root, input) : null
    const previousRun = continuation ? loadRun(root, continuation.runId) : null
    const workspaceRoot = previousRun?.workspaceRoot
      ? verifyWorkspaceRoot(previousRun.workspaceRoot)
      : resolveWorkspaceRoot(previousRun?.workingDirectory ?? input.cwd)
    const historyFile = selectHistory({ sessionDir: input.sessionDir, resume: input.resume })
    if (input.command) checkCommand(input.command, historyFile, input)
    const account = this.options.accounts.resolve(input.accountId, input.poolId)
    const context = this.options.accounts.context(account)
    const runId = input.run.id
    const caller: CallerContext = { ...input.caller, runId, sessionId: input.caller.sessionId ?? input.run.sessionId }
    const broker = input.connections ? this.options.broker : null
    const depth = input.depth ?? 0
    const canSpawn = input.subagents !== null && (!input.automatic || input.subagents !== undefined) && subagentNesting(root, input.run) < subagentDepth(input.subagents ?? undefined)
    const pinnedAskUser = continuation?.capabilities?.tools.includes(ASK_USER) ?? false
    const interactivePlan = input.plan === true
      && !input.automatic
      && (input.run.trigger === undefined || input.run.trigger === null || input.run.trigger === 'user')
    const harnessToolsEnabled = input.harnessTools !== false || pinnedAskUser
    const canAskUser = pinnedAskUser || (interactivePlan && harnessToolsEnabled)
    const requestedTools = [...new Set([
      ...input.tools.allow.filter((name) => name !== SPAWN_SUBAGENT && name !== WAIT_SUBAGENTS && (name !== ASK_USER || canAskUser)),
      ...(harnessToolsEnabled ? [...(canAskUser ? [ASK_USER] : []), TODO_WRITE, FINISH, SESSION_NAME, GET_CAPABILITIES, ...DEFAULT_TOOL_NAMES] : []),
      ...(broker?.toolNames ?? []),
      ...(canSpawn ? [SPAWN_SUBAGENT, WAIT_SUBAGENTS] : [])
    ])]
    const available = this.options.resolveCapabilities
      ? await this.options.resolveCapabilities(caller, requestedTools, input.cwd)
      : { version: 1 as const, tools: requestedTools, connectors: [], contributions: [] }
    const requested = input.capabilities ? parseCapabilitySet(input.capabilities) : available
    // A capability set pinned before ADR-0069 names checkpoint_write; finish took its place.
    const pinnedTools = requested.tools.includes(LEGACY_CHECKPOINT_WRITE) ? [...requested.tools, FINISH] : requested.tools
    const capabilities: CapabilitySet = {
      version: 1,
      tools: available.tools.filter((tool) => pinnedTools.includes(tool)),
      connectors: available.connectors.filter((id) => requested.connectors.includes(id)),
      contributions: available.contributions.filter((id) => requested.contributions.includes(id))
    }
    freezeRun(root, runId, caller, capabilities)

    // The harness is resolved once and pinned: a child run or a later turn of this run uses the
    // same files even if the head moves meanwhile.
    let variant: Materialised | null = null
    if (input.variant) {
      const scope = input.variant.scope ?? null
      const trust = this.options.trust ?? null
      variant = materialise(root, input.variant, { trust, probeCode: input.run.trigger === 'probe' && Boolean(scope && trust?.probeCode(scope)), subagents: capabilities.tools.includes(SPAWN_SUBAGENT) })
      input.variant = { dir: variant.dir, scope: variant.scope }
    }

    saveRun(root, {
      resumedFromRunId: input.run.resumedFromRunId ?? null,
      parentRunId: input.run.parentRunId ?? null,
      relation: input.run.relation ?? null,
      terminalReason: null,
      id: runId,
      projectId: input.run.projectId ?? caller.projectId ?? null,
      mode: input.run.mode ?? 'chat',
      effectiveMode: input.plan ? 'plan' : 'normal',
      harness: input.run.harness ?? 'pi',
      sessionType: input.run.sessionType ?? 'structured',
      sessionId: input.run.sessionId,
      nativeSessionId: null,
      workingDirectory: input.cwd,
      workspaceRoot,
      worktreeId: input.run.worktreeId ?? null,
      goal: input.run.goal ?? takeChars(input.text, 4000),
      attachmentCount: input.run.attachmentCount ?? 0,
      startedAt: now(),
      endedAt: null,
      status: 'queued',
      loadedSkills: [],
      exitCode: null,
      handoffId: input.run.handoffId ?? null,
      accountId: account.id,
      agentId: input.run.agentId ?? caller.agentId ?? null,
      trigger: input.run.trigger ?? null,
      variantScope: variant?.scope ?? null,
      variantVersion: variant?.fingerprint ?? null,
      ...(input.run.profile ? { profile: input.run.profile } : {}),
      ...(input.run.title ? { title: input.run.title } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {})
    })

    // What the session is, kept with the run so later consolidation knows which memory it had.
    try {
      writeJson(join(runDir(root, runId), 'caller.json'), caller)
    } catch {
      // Consolidation falls back to what the run record says.
    }

    const fail = (error: unknown, code = 'provider_unavailable'): void => {
      const message = error instanceof Error ? error.message : String(error)
      updateRun(root, runId, (record) => Object.assign(record, { status: 'failed', endedAt: now(), terminalReason: message, terminalCode: stopCodeOf(code) }))
      log(`session ${runId} did not start: ${message}`, code)
    }

    // Plugins are resolved once per run: for the profiles the prompt lists, then for what Pi loads.
    const { plugins } = this.options
    let pluginLoading: ReturnType<Plugins['loading']> | null = null
    const loadPlugins = plugins
      ? () => (pluginLoading ??= plugins.loading({ cwd: input.cwd, agentDir: context.configDir, install: true, caller: { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null }, contributions: capabilities.contributions }))
      : null

    // A person's main session sees its current name and whether this run's todo is empty. A
    // command, child, side question or unattended run has no such state to show.
    const stateEligible = !input.command
      && !input.run.relation
      && (input.depth ?? 0) === 0
      && !input.automatic
      && (input.run.trigger == null || input.run.trigger === 'user')
    // The working tree as the person's turn found it, so refinement can replay the request later.
    if (stateEligible) {
      const snapshot = await snapshotWorkingTree(input.cwd)
      if (snapshot) updateRun(root, runId, (record) => { record.workspaceSnapshot = snapshot })
    }
    const existingName = stateEligible ? latestSessionName(historyFile) : null
    const sessionState: SessionState | undefined = stateEligible
      ? {
          name: existingName,
          todo: [],
          ...(continuation?.todo.length ? { previousTodo: continuation.todo } : {}),
          firstTurn: !historyFile
        }
      : undefined

    let system: string
    let update: TurnParams['update']
    try {
      if (!existsSync(input.sessionDir)) mkdirSync(input.sessionDir, { recursive: true })
      const launch = input.launch ?? {}
      const plan = planSection(input.plan === true, historyFile, input.run.relation === 'subagent')
      const delivered = historyFile ? deliveredSnapshot(historyFile) : null
      const resumed = continuationSection(continuation, delivered?.some((entry) => entry.id === CONTINUATION_SECTION_ID) ?? false)
      // The profiles replace the variant's own subagent list, which they include.
      const researchContext = input.plan === true ? {
        frozenTools: capabilities.tools,
        contributions: capabilities.contributions,
        descriptors: BUILTIN_PLUGIN_REGISTRY.descriptors()
      } : undefined
      if (capabilities.tools.includes(SPAWN_SUBAGENT) && loadPlugins && !input.automatic) input.packageProfiles = (await loadPlugins()).profilePaths
      const profiles = capabilities.tools.includes(SPAWN_SUBAGENT)
        ? profileSection(root, input.cwd, variant?.dir ?? null, input.plan === true, researchContext, input.packageProfiles ?? [])
        : null
      if (profiles && variant) variant = { ...variant, sections: variant.sections.filter((section) => section.id !== profiles.id) }
      const own = [plan, resumed, profiles].filter((section): section is NonNullable<typeof section> => section !== null)
      const effectiveLaunch = {
        ...launch,
        ...(sessionState ? { sessionState } : {}),
        sections: own.length ? [...(launch.sections ?? []).filter((section) => !own.some((entry) => entry.id === section.id)), ...own] : launch.sections,
        tools: capabilities.tools,
        connectionTools: (launch.connectionTools ?? []).filter((name) => capabilities.tools.includes(name)),
        toolGroups: launch.toolGroups?.map((group) => ({ ...group, tools: group.tools.filter((name) => capabilities.tools.includes(name)) })).filter((group) => group.tools.length > 0)
      }
      ;({ system, update } = sessionLaunch(this.env, caller, effectiveLaunch, historyFile, variant))
    } catch (error) {
      fail(error)
      throw error
    }

    // A run with the harness's own tools is bounded; plan-research children are bounded too, though
    // their read-only capability set omits those tools. `finish` marks the harness tool set.
    const harnessStateTools = capabilities.tools.includes(FINISH)
    const planResearchChild = input.plan === true && input.run.relation === 'subagent'
    const sliceEnabled = slicePolicy.enabled && (harnessStateTools || planResearchChild)
    const sliceState = createSliceState(slicePolicy, sliceOf(root, runId))
    // The stop gate (ADR-0069) keeps an attended top-level reply working while its todo list has open
    // items. Never for plan, command, automatic, subagent or other related runs.
    const gateEnabled = harnessStateTools && depth === 0 && !input.plan && !input.command && !input.automatic && !input.run.relation
    const stopGateState = gateEnabled ? createStopGateState(continuation?.todo) : null
    const run = this.options.runs.start(input.run.sessionId, runId)
    if (run.finished) return { runId, nativeSessionId: null }
    if (variant?.untrustedPlugins.length) {
      run.emit('extension.notice', { kind: 'notify', level: 'warning', text: `Harness plugins not loaded until their code is trusted: ${variant.untrustedPlugins.join(', ')}.` })
    }
    // What every session has, after the tools the caller switched on and in a fixed order.
    const allow = capabilities.tools
    const session: ToolSession = { run, caller, allow, depth, cwd: input.cwd, capabilities }

    let pi: PiSessionLike | undefined
    const naming = sessionNameTool(() => {
      const current = pi
      if (!current?.setSessionName) return undefined
      return {
        get sessionName() { return current.sessionName },
        setSessionName: name => current.setSessionName!(name)
      }
    })
    try {
      const tools: ToolSpec[] = [
        ...(harnessToolsEnabled && allow.includes(GET_CAPABILITIES) ? [getCapabilitiesTool(() => ({
          capabilities,
          active: pi?.getActiveToolNames?.() ?? [],
          registered: pi?.getAllTools?.() ?? []
        }))] : []),
        ...BUILTIN_PLUGIN_REGISTRY.tools({
          env: this.options.env,
          caller,
          variantDir: variant?.dir ?? null,
          run,
          runId,
          allowedTools: allow,
          harnessTools: harnessToolsEnabled,
          subagents: this.options.subagents,
          sessionName: naming,
          ...(stopGateState ? { stopGate: stopGateState } : {}),
          ...(broker ? { connectionTools: () => broker.tools(session, { readOnly: typeof input.connections === 'object' && input.connections.readOnly === true }) } : {})
        })
      ]
      if (input.providers !== false) {
        const named = new Set(tools.map((tool) => tool.name))
        for (const provider of this.providers) {
          for (const tool of await provider(session)) {
            // The first tool of a name wins: the harness's own world tools are asked first.
            if (named.has(tool.name)) continue
            named.add(tool.name)
            tools.push(tool)
          }
        }
      }
      const readOnly = new Set(tools.filter((tool) => tool.readOnly).map((tool) => tool.name))
      const checkpointPlanInstructions = input.plan
        ? () => input.run.relation === 'subagent' ? PLAN_RESEARCH_SUBAGENT_INSTRUCTIONS : PLAN_INSTRUCTIONS
        : undefined
      const planModeSafety = new Map<string, NonNullable<ToolSpec['planModeSafe']>>()
      for (const tool of tools) if (tool.planModeSafe) planModeSafety.set(tool.name, tool.planModeSafe)
      const gate = (() => {
        const baseGate = this.gate(run, caller, new Set((input.tools.gated ?? []).filter((name) => capabilities.tools.includes(name))), false, input.automatic === true)
        const checkDetailed = (name: string, args: unknown) => {
          if (input.run.relation === 'subagent' && !capabilities.tools.includes(name)) return Promise.resolve({ code: 'capability' as const, reason: 'This tool is outside the child capability snapshot.' })
          const refusal = input.plan ? planRefusal(name, readOnly, args, planModeSafety.get(name)) : null
          return refusal ? Promise.resolve({ code: 'plan_mode' as const, reason: refusal }) : baseGate.checkDetailed!(name, args)
        }
        return { ...baseGate, checkDetailed, check: async (name: string, args: unknown) => (await checkDetailed(name, args))?.reason ?? null }
      })()
      const params: TurnParams = {
        runId,
        ...(input.initialBashCommand !== undefined && input.initialBashCommand !== null ? { initialBashCommand: input.initialBashCommand, initialBashAvailable: capabilities.tools.includes('bash') } : {}),
        ...(input.initialBashContext !== undefined && input.initialBashContext !== null ? { initialBashContext: input.initialBashContext } : {}),
        gate,
        onRefusal: (toolCallId, name, refusal) => run.emit('tool.refused', { toolCallId, name, ...refusal, reason: refusal.reason.slice(0, 2000) }),
        restrictTools: input.run.relation === 'subagent',
        ...(input.plan ? { plan: true } : {}),
        ...(stateEligible && input.plan ? { repairPlan: true } : {}),
        cwd: input.cwd,
        workspaceRoot,
        sessionDir: input.sessionDir,
        historyFile,
        model: input.model ?? null,
        effort: input.effort ?? null,
        text: input.text,
        images: input.images,
        requiresImageInput: input.requiresImageInput,
        preamble: input.preamble ?? null,
        automatic: input.automatic,
        account: context,
        resources: { ids: [], skillPaths: [...(variant?.skillPaths ?? []), ...defaultSkillPaths(variant?.dir)], promptPaths: [] },
        variantExtensions: variant?.extensionPaths ?? [],
        inline: [
          ...firstPartyFor(root, capabilities.contributions),
          runLineageJoin(root, runId),
          this.options.subagents.extension(runId),
          { name: 'image-pruning', factory: imagePruning() },
          { name: COMPACTION_CHECKPOINT_EXTENSION, factory: compactionCheckpoint({ initialTodo: continuation?.todo, planInstructions: checkpointPlanInstructions }) },
          ...(sliceEnabled ? [{ name: WORK_SLICE_EXTENSION, factory: workSliceGuard({ policy: slicePolicy, state: sliceState, onRefuse: (event, reason) => { if (typeof event.toolCallId === 'string') run.emit('tool.refused', { toolCallId: event.toolCallId, name: event.toolName, code: 'work_slice', reason: reason.slice(0, 2000) }) } }) }] : []),
          // Last, so delivered subagent results and plan repair continue first and the gate sees them.
          ...(stopGateState ? [{ name: STOP_GATE_EXTENSION, factory: stopGate({
            state: stopGateState,
            initialTodo: continuation?.todo,
            sliceEnded: () => sliceEnabled && sliceState.endedBy !== null,
            onNudge: (count, open) => run.emit('extension.notice', { kind: 'notify', level: 'info', extension: STOP_GATE_EXTENSION, text: `Stop gate ${count}: the reply ended with ${open.length} open todo item${open.length === 1 ? '' : 's'}; continuing.` })
          }) }] : [])
        ],
        ...(plugins && loadPlugins ? { plugins: { loading: loadPlugins, loaded: (extensions) => plugins.loaded(extensions) } } : {}),
        activatedPlugins: (ids) => updateRun(root, runId, (record) => { record.activatedPlugins = ids }),
        system,
        ...(sliceEnabled ? { slice: { state: sliceState, maxToolCalls: slicePolicy.maxToolCalls } } : {}),
        ...(stopGateState ? { stopGate: stopGateState } : {}),
        // A command sends no request of its own, so the context update waits for the next turn.
        update: input.command ? null : update,
        ...(input.command ? { command: input.command } : {})
      }
      pi = await this.factory({
        params,
        allow,
        gate,
        tools,
        runtime: () => this.options.accounts.runtime(context),
        // An unattended run loads no extension, so it has nobody to relay for.
        ...(input.automatic ? {} : { extensions: { ask: (question) => run.requestAnswer(question), notice: (notice) => run.emit('extension.notice', notice) } })
      })
      if (run.finished) {
        pi.dispose()
        return { runId, nativeSessionId: null }
      }
      if ((input.requiresImageInput || input.images?.length) && !pi.model?.input.includes('image')) {
        throw new HarnessError('image_input_unsupported', 'Choose a model that supports images, or remove the image attachments and send again.')
      }
      if (input.resume?.nativeSessionId && pi.sessionId !== input.resume.nativeSessionId) {
        run.finish('failed', { code: 'native_resume_unavailable', message: 'The saved conversation could not be restored.' })
        throw new HarnessError('native_resume_unavailable', 'The saved conversation could not be restored.')
      }
      // The fallback is a name, not a task step: a refused or failed name never fails the run.
      if (stateEligible && input.autoName !== false && !existingName && !pi.sessionName
        && pi.setSessionName && capabilities.tools.includes(SESSION_NAME)) {
        const name = deriveSessionName(input.text)
        if (name) {
          try {
            if (await gate.check(SESSION_NAME, { name }) === null) pi.setSessionName(name)
          } catch {
            // Session naming is metadata; leave the session unnamed.
          }
        }
      }
      const opened = pi
      const openedModel = pi.model?.id && pi.model.provider ? `${pi.model.provider}/${pi.model.id}` : null
      updateRun(root, runId, (record) => {
        record.nativeSessionId = opened.sessionId
        if (openedModel) record.model = openedModel
        if (opened.thinkingLevel) record.effort = opened.thinkingLevel
      })
      this.options.subagents.register(input, account.id, capabilities, Boolean(pi.sessionManager))
      if (openedModel) this.options.subagents.resolvedModel(runId, openedModel, pi.thinkingLevel)
      params.settle = () => this.options.subagents.verify(runId, opened.sessionManager ? subagentHistory(opened.sessionManager.getBranch()) : undefined)
      void runTurn(run, pi, params).then(() => (sliceEnabled && !input.command ? this.continueSlice({ root, runId, source: input, policy: slicePolicy }) : undefined))
      return { runId, nativeSessionId: pi.sessionId }
    } catch (error) {
      pi?.dispose()
      if (error instanceof HarnessError && error.code === 'native_resume_unavailable') throw error
      const message = error instanceof Error ? error.message : String(error)
      log('session failed to start', message)
      run.finish('failed', { code: error instanceof HarnessError ? error.code : 'provider_unavailable', message })
      return { runId, nativeSessionId: null }
    }
  }
}
