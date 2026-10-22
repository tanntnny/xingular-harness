// Starting a session turn: the account, the run record, the compiled prompt, the tools and
// their gate, then Pi. Everything before Pi answers is synchronous with the caller; the reply
// itself streams as run events.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Accounts } from '../accounts/accounts'
import { log } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import { capabilitySet as parseCapabilitySet, freezeRun } from '../capabilities/runSnapshot'
import type { CapabilitySet } from '../capabilities/types'
import { now, writeJson } from '../core/fs'
import { takeChars } from '../core/text'
import type { CallerContext } from '../core/caller'
import type { DispatchEnv } from '../tools/dispatch'
import type { Plugins } from '../plugins/plugins'
import { sessionLaunch, type Launch } from '../prompt/compile'
import * as attachments from '../plugins/attachments'
import { FIRST_PARTY_PLUGINS, firstPartyExtensions, type InlineExtension } from '../plugins/firstParty'
import { materialise, type HarnessChoice, type Materialised } from '../tree/materialise'
import type { TreeTrust } from '../tree/trust'
import { ASK_USER, askUserTool } from '../tools/askUser'
import { CHECKLIST_WRITE, checklistTool } from '../tools/checklist'
import { subagentTools } from '../tools/spawnSubagent'
import { DEFAULT_TOOL_NAMES } from '../tools/definitions'
import { harnessTools } from '../tools/harnessTools'
import type { ToolProvider, ToolSession, ToolSpec } from '../tools/types'
import type { RunRecord } from './contracts'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS, subagentDepth, subagentHistory, subagentNesting, type SubagentInput, type SubagentOptions } from './subagents'
import type { Subagents } from './subagentService'
import { selectHistory } from './history'
import { runLineageJoin } from './lineageJoin'
import type { ToolPolicy } from './policy'
import type { ActiveRun, RunRegistry } from './registry'
import { piSessionFactory, runTurn, summarize, type Effort, type PiSessionLike, type SessionFactory, type ToolGate, type TurnParams } from './runner'
import { loadRun, runDir, saveRun, updateRun } from './runStore'
import { planRefusal, planSection } from './planMode'
import { CONTINUATION_SECTION_ID, continuationOf, continuationSection, type Continuation } from './continuation'
import { deliveredSnapshot } from '../prompt/compile'

/** The fields of a run record the caller decides; the harness fills in the rest. */
export type RunFields = Pick<RunRecord, 'id' | 'sessionId'> & Partial<Pick<RunRecord, 'mode' | 'harness' | 'sessionType' | 'projectId' | 'agentId' | 'trigger' | 'goal' | 'attachmentCount' | 'resumedFromRunId' | 'parentRunId' | 'relation' | 'worktreeId' | 'handoffId'>>

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
   * The harness tree the session runs: a scope's head (or a version of it), or a tree on disk.
   * Its version is pinned for the whole run and recorded on it.
   */
  harness?: HarnessChoice | null
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
  /** Give the session the harness's own tools: History, the Wiki, skills, and asking the user (the default). */
  harnessTools?: boolean
  /**
   * Plan mode: the run may only read, search, recall and ask, and is told to end with a
   * `<proposed_plan>` block. Other calls are refused at the gate; the tool list is unchanged.
   */
  plan?: boolean
  /**
   * Continue a run that stopped before it finished: the earlier run's id. The new run reopens its
   * native history and pins its account, tree version and capability set, and the model is told
   * where it stopped. The harness never does this by itself; the application asks for it.
   */
  continueFrom?: string | null
}

const CONTINUE_TEXT = 'Continue from where you stopped.'

/** Fills a continuing run's input from the run it continues, refusing anything that would differ. */
function continueInput(root: string, input: SessionRunInput): Continuation {
  const continuation = continuationOf(root, input.continueFrom!, input.sessionDir)
  if (!continuation.resumable || !continuation.resume) throw new HarnessError('continuation_unavailable', `Run ${input.continueFrom} cannot be continued (${continuation.reason ?? 'history_missing'}).`)
  const mismatch = (what: string): HarnessError => new HarnessError('continuation_mismatch', `A continuation keeps the earlier run's ${what}.`)
  if (continuation.sessionId !== input.run.sessionId) throw mismatch('session')
  if (input.resume?.nativeSessionId && input.resume.nativeSessionId !== continuation.resume.nativeSessionId) throw mismatch('history')
  if (input.accountId && input.accountId !== continuation.accountId) throw mismatch('account')
  const pinned = continuation.harness
  const chosen = input.harness ?? null
  if (chosen && (!pinned || 'dir' in chosen || chosen.scope !== pinned.scope || (chosen.version && chosen.version !== pinned.version))) throw mismatch('harness version')
  input.resume = continuation.resume
  input.run.resumedFromRunId ??= continuation.runId
  input.accountId = continuation.accountId
  input.poolId = null
  if (pinned) input.harness = { scope: pinned.scope, version: pinned.version }
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
  factory?: SessionFactory
  /** Which plugin code in harness trees a person trusted. */
  trust?: TreeTrust | null
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

  private gate(run: ActiveRun, caller: CallerContext, gated: Set<string>): ToolGate {
    const { policy } = this.options
    return {
      ask: (names) => {
        for (const name of names) gated.add(name)
      },
      check: async (tool, args) => {
        const call = { run: loadRun(this.env.root, run.runId), caller, tool, args }
        const scope = (await policy.scope?.(call)) ?? { allowed: true }
        if (!scope.allowed && (scope.automatic || !scope.requiresApproval)) return scope.reason ?? 'Outside the approved work scope.'
        try {
          await policy.authorize?.(call)
        } catch (error) {
          return error instanceof Error ? error.message : 'Tool unavailable in the app settings.'
        }
        if (scope.allowed && !scope.humanOnly && (scope.automatic || !gated.has(tool))) return null
        // Refinement and reflection runs have nobody to ask: what would need a person is refused, never queued.
        if (call.run.trigger === 'probe' || call.run.trigger === 'improver') return scope.reason ? `Refused in a refinement run: ${scope.reason}` : 'Refused in a refinement run: this call needs a person to approve it.'
        if (call.run.trigger === 'reflection') return scope.reason ? `Refused in a reflection run: ${scope.reason}` : 'Refused in a reflection run: this call needs a person to approve it.'
        // A call outside the scope is approved one at a time; a gated tool may be remembered, unless only a person may decide it.
        const decision = await run.requestApproval({
          target: tool,
          action: summarize(args),
          operation: { tool, args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> },
          rememberable: scope.allowed && !scope.humanOnly,
          standing: scope.humanOnly ? (scope.allowGlobalApproval ? 'switch' : 'none') : undefined
        })
        if (decision !== 'approved') return 'The user denied this action. Ask how they would like to proceed.'
        try {
          await policy.authorize?.(call)
        } catch (error) {
          return error instanceof Error ? error.message : 'Tool was disabled while waiting.'
        }
        return null
      }
    }
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
    const { root } = this.env
    if (!input?.run?.id || !input.run.sessionId || typeof input.text !== 'string') throw invalid('A session turn needs a run id, a session, and text.')
    input = structuredClone(input)
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
    const continuation = input.continueFrom ? continueInput(root, input) : null
    const historyFile = selectHistory({ sessionDir: input.sessionDir, resume: input.resume })
    const account = this.options.accounts.resolve(input.accountId, input.poolId)
    const context = this.options.accounts.context(account)
    const runId = input.run.id
    const caller: CallerContext = { ...input.caller, runId, sessionId: input.caller.sessionId ?? input.run.sessionId }
    const broker = input.connections ? this.options.broker : null
    const depth = input.depth ?? 0
    const canSpawn = input.subagents !== null && (!input.automatic || input.subagents !== undefined) && subagentNesting(root, input.run) < subagentDepth(input.subagents ?? undefined)
    const requestedTools = [...new Set([
      ...input.tools.allow.filter((name) => name !== SPAWN_SUBAGENT && name !== WAIT_SUBAGENTS),
      ...(input.harnessTools === false ? [] : [ASK_USER, CHECKLIST_WRITE, ...DEFAULT_TOOL_NAMES]),
      ...(broker?.toolNames ?? []),
      ...(canSpawn ? [SPAWN_SUBAGENT, WAIT_SUBAGENTS] : [])
    ])]
    const available = this.options.resolveCapabilities
      ? await this.options.resolveCapabilities(caller, requestedTools, input.cwd)
      : { version: 1 as const, tools: requestedTools, connectors: [], contributions: [] }
    const requested = input.capabilities ? parseCapabilitySet(input.capabilities) : available
    const capabilities: CapabilitySet = {
      version: 1,
      tools: available.tools.filter((tool) => requested.tools.includes(tool)),
      connectors: available.connectors.filter((id) => requested.connectors.includes(id)),
      contributions: available.contributions.filter((id) => requested.contributions.includes(id))
    }
    freezeRun(root, runId, caller, capabilities)

    // The harness is resolved once and pinned: a child run or a later turn of this run uses the
    // same files even if the head moves meanwhile.
    let tree: Materialised | null = null
    if (input.harness) {
      const scope = input.harness.scope ?? null
      const trust = this.options.trust ?? null
      tree = materialise(root, input.harness, { trust, probeCode: input.run.trigger === 'probe' && Boolean(scope && trust?.probeCode(scope)), subagents: capabilities.tools.includes(SPAWN_SUBAGENT) })
      input.harness = { dir: tree.dir, scope: tree.scope }
    }

    saveRun(root, {
      resumedFromRunId: input.run.resumedFromRunId ?? null,
      parentRunId: input.run.parentRunId ?? null,
      relation: input.run.relation ?? null,
      terminalReason: null,
      id: runId,
      projectId: input.run.projectId ?? caller.projectId ?? null,
      mode: input.run.mode ?? 'chat',
      harness: input.run.harness ?? 'pi',
      sessionType: input.run.sessionType ?? 'structured',
      sessionId: input.run.sessionId,
      nativeSessionId: null,
      workingDirectory: input.cwd,
      worktreeId: input.run.worktreeId ?? null,
      goal: input.run.goal ?? takeChars(input.text, 4000),
      attachmentCount: input.run.attachmentCount ?? 0,
      startedAt: now(),
      endedAt: null,
      status: 'queued',
      exitCode: null,
      handoffId: input.run.handoffId ?? null,
      accountId: account.id,
      agentId: input.run.agentId ?? caller.agentId ?? null,
      trigger: input.run.trigger ?? null,
      harnessScope: tree?.scope ?? null,
      harnessVersion: tree?.fingerprint ?? null
    })

    // What the session is, kept with the run so later consolidation knows which memory it had.
    try {
      writeJson(join(runDir(root, runId), 'caller.json'), caller)
    } catch {
      // Consolidation falls back to what the run record says.
    }

    const fail = (error: unknown, code = 'provider_unavailable'): void => {
      const message = error instanceof Error ? error.message : String(error)
      updateRun(root, runId, (record) => Object.assign(record, { status: 'failed', endedAt: now(), terminalReason: message }))
      log(`session ${runId} did not start: ${message}`, code)
    }

    let system: string
    let update: TurnParams['update']
    try {
      if (!existsSync(input.sessionDir)) mkdirSync(input.sessionDir, { recursive: true })
      const launch = input.launch ?? {}
      const plan = planSection(input.plan === true, historyFile)
      const delivered = historyFile ? deliveredSnapshot(historyFile) : null
      const resumed = continuationSection(continuation, delivered?.some((entry) => entry.id === CONTINUATION_SECTION_ID) ?? false)
      const own = [plan, resumed].filter((section): section is NonNullable<typeof section> => section !== null)
      const effectiveLaunch = {
        ...launch,
        sections: own.length ? [...(launch.sections ?? []).filter((section) => !own.some((entry) => entry.id === section.id)), ...own] : launch.sections,
        tools: capabilities.tools,
        connectionTools: (launch.connectionTools ?? []).filter((name) => capabilities.tools.includes(name)),
        toolGroups: launch.toolGroups?.map((group) => ({ ...group, tools: group.tools.filter((name) => capabilities.tools.includes(name)) })).filter((group) => group.tools.length > 0)
      }
      ;({ system, update } = sessionLaunch(this.env, caller, effectiveLaunch, historyFile, tree))
    } catch (error) {
      fail(error)
      throw error
    }

    const run = this.options.runs.start(input.run.sessionId, runId)
    if (run.finished) return { runId, nativeSessionId: null }
    if (tree?.untrustedPlugins.length) {
      run.emit('extension.notice', { kind: 'notify', level: 'warning', text: `Harness plugins not loaded until their code is trusted: ${tree.untrustedPlugins.join(', ')}.` })
    }
    // What every session has, after the tools the caller switched on and in a fixed order.
    const allow = capabilities.tools
    const session: ToolSession = { run, caller, allow, depth, cwd: input.cwd, capabilities }
    const { plugins } = this.options

    let pi: PiSessionLike | undefined
    try {
      const tools: ToolSpec[] = [
        ...(broker ? broker.tools(session, { readOnly: typeof input.connections === 'object' && input.connections.readOnly === true }) : []),
        ...(input.harnessTools === false ? [] : [...harnessTools(this.options.env, caller, { treeDir: tree?.dir ?? null }), askUserTool(run), checklistTool(run)]),
        ...subagentTools(this.options.subagents, runId).filter(tool => allow.includes(tool.name))
      ]
      if (input.providers !== false) for (const provider of this.providers) tools.push(...(await provider(session)))
      const readOnly = new Set(tools.filter((tool) => tool.readOnly).map((tool) => tool.name))
      const planModeSafety = new Map<string, NonNullable<ToolSpec['planModeSafe']>>()
      for (const tool of tools) if (tool.planModeSafe) planModeSafety.set(tool.name, tool.planModeSafe)
      const gate = (() => {
        const baseGate = this.gate(run, caller, new Set((input.tools.gated ?? []).filter((name) => capabilities.tools.includes(name))))
        return {
          ...baseGate,
          check: (name: string, args: unknown) => {
            if (input.run.relation === 'subagent' && !capabilities.tools.includes(name)) return Promise.resolve('This tool is outside the child capability snapshot.')
            const refusal = input.plan ? planRefusal(name, readOnly, args, planModeSafety.get(name)) : null
            return refusal ? Promise.resolve(refusal) : baseGate.check(name, args)
          }
        }
      })()
      const params: TurnParams = {
        runId,
        ...(input.initialBashCommand !== undefined && input.initialBashCommand !== null ? { initialBashCommand: input.initialBashCommand, initialBashAvailable: capabilities.tools.includes('bash') } : {}),
        ...(input.initialBashContext !== undefined && input.initialBashContext !== null ? { initialBashContext: input.initialBashContext } : {}),
        gate,
        restrictTools: input.run.relation === 'subagent',
        cwd: input.cwd,
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
        resources: { ids: [], skillPaths: tree?.skillPaths ?? [], promptPaths: [] },
        treeExtensions: tree?.extensionPaths ?? [],
        inline: [...firstPartyFor(root, capabilities.contributions), runLineageJoin(root, runId), this.options.subagents.extension(runId)],
        ...(plugins ? { plugins: { loading: () => plugins.loading({ cwd: input.cwd, agentDir: context.configDir, install: true, caller: { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null }, contributions: capabilities.contributions }), loaded: (extensions) => plugins.loaded(extensions) } } : {}),
        system,
        update
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
      const opened = pi
      updateRun(root, runId, (record) => void (record.nativeSessionId = opened.sessionId))
      this.options.subagents.register(input, account.id, capabilities, Boolean(pi.sessionManager))
      if (pi.model?.id && pi.model.provider) this.options.subagents.resolvedModel(runId, `${pi.model.provider}/${pi.model.id}`, pi.thinkingLevel)
      params.settle = () => this.options.subagents.verify(runId, opened.sessionManager ? subagentHistory(opened.sessionManager.getBranch()) : undefined)
      void runTurn(run, pi, params)
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
