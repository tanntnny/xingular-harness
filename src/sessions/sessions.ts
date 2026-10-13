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
import type { CallerContext } from '../memory/caller'
import type { DispatchEnv } from '../memory/dispatch'
import type { Plugins } from '../plugins/plugins'
import { sessionLaunch, type Launch } from '../prompt/compile'
import * as attachments from '../plugins/attachments'
import { FIRST_PARTY_PLUGINS, firstPartyExtensions, type InlineExtension } from '../plugins/firstParty'
import * as registry from '../skills/registry'
import { ASK_USER, askUserTool } from '../tools/askUser'
import { PLUGIN_PROPOSE, pluginProposeTool } from '../tools/pluginPropose'
import { WIKI_TOOL_NAMES } from '../tools/definitions'
import { memoryTools } from '../tools/memoryTools'
import type { ToolProvider, ToolSession, ToolSpec } from '../tools/types'
import type { RunRecord } from './contracts'
import { selectHistory } from './history'
import { runLineageJoin } from './lineageJoin'
import type { ToolPolicy } from './policy'
import type { ActiveRun, RunRegistry } from './registry'
import { piSessionFactory, runTurn, summarize, type Effort, type PiSessionLike, type SessionFactory, type ToolGate, type TurnParams } from './runner'
import { loadRun, runDir, saveRun, updateRun } from './runStore'

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
  images?: { mediaType: string; data: string }[]
  /** Reject a resolved model that cannot inspect image content. */
  requiresImageInput?: boolean
  preamble?: string | null
  /** Unattended: no project extensions, no context files, nothing may ask a person. */
  automatic?: boolean
  /** Who the session works as, for memory and the prompt. */
  caller: CallerContext
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
}

/** The connected-apps broker, as a session sees it. */
export interface SessionBroker {
  toolNames: readonly string[]
  tools(session: ToolSession, options: { readOnly: boolean }): ToolSpec[]
}

export interface SessionsOptions {
  env: DispatchEnv
  accounts: Accounts
  runs: RunRegistry
  policy: ToolPolicy
  broker?: SessionBroker | null
  /** Chooses what a session loads. Without it Pi discovers extensions and skills on its own. */
  plugins?: Plugins
  /** Resolves the caller's capability set from the harness's stores. */
  resolveCapabilities?: (caller: CallerContext, tools: readonly string[]) => Promise<CapabilitySet>
  factory?: SessionFactory
}

/** The harness's own plugins a person switched on for this caller, with the numbers they set. */
function firstPartyFor(root: string, caller: CallerContext): InlineExtension[] {
  const choices = attachments.load(root)
  const scope = { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null }
  return firstPartyExtensions((id) => attachments.attached(choices, [id], scope, FIRST_PARTY_PLUGINS.find((plugin) => plugin.id === id)?.switchable?.on ?? false), choices.settings)
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
        if (scope.allowed && (scope.automatic || !gated.has(tool))) return null
        // A call outside the scope is approved one at a time; a gated tool may be remembered.
        const decision = await run.requestApproval({ target: tool, action: summarize(args), operation: { tool, args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> }, rememberable: scope.allowed })
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

  /**
   * Starts one turn. Returns once the Pi session is open; the reply arrives as run events. A
   * session that cannot be opened ends its run as failed and returns no native session id.
   */
  async run(input: SessionRunInput): Promise<{ runId: string; nativeSessionId: string | null }> {
    const { root } = this.env
    if (!input?.run?.id || !input.run.sessionId || typeof input.text !== 'string') throw invalid('A session turn needs a run id, a session, and text.')
    const historyFile = selectHistory({ sessionDir: input.sessionDir, resume: input.resume })
    const account = this.options.accounts.resolve(input.accountId, input.poolId)
    const context = this.options.accounts.context(account)
    const runId = input.run.id
    const caller: CallerContext = { ...input.caller, runId, sessionId: input.caller.sessionId ?? input.run.sessionId }
    const broker = input.connections ? this.options.broker : null
    const requestedTools = [...new Set([
      ...input.tools.allow,
      ASK_USER,
      ...(input.automatic ? [] : [PLUGIN_PROPOSE]),
      ...WIKI_TOOL_NAMES,
      ...(broker?.toolNames ?? [])
    ])]
    const available = this.options.resolveCapabilities
      ? await this.options.resolveCapabilities(caller, requestedTools)
      : { version: 1 as const, tools: requestedTools, connectors: [], contributions: [] }
    const requested = input.capabilities ? parseCapabilitySet(input.capabilities) : available
    const capabilities: CapabilitySet = {
      version: 1,
      tools: available.tools.filter((tool) => requested.tools.includes(tool)),
      connectors: available.connectors.filter((id) => requested.connectors.includes(id)),
      contributions: available.contributions.filter((id) => requested.contributions.includes(id))
    }
    freezeRun(root, runId, caller, capabilities)

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
      trigger: input.run.trigger ?? null
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
      const effectiveLaunch = {
        ...launch,
        tools: capabilities.tools,
        connectionTools: (launch.connectionTools ?? []).filter((name) => capabilities.tools.includes(name)),
        toolGroups: launch.toolGroups?.map((group) => ({ ...group, tools: group.tools.filter((name) => capabilities.tools.includes(name)) })).filter((group) => group.tools.length > 0)
      }
      ;({ system, update } = sessionLaunch(this.env, caller, effectiveLaunch, historyFile))
    } catch (error) {
      fail(error)
      throw error
    }

    const run = this.options.runs.start(input.run.sessionId, runId)
    if (run.finished) return { runId, nativeSessionId: null }
    // What every session has, after the tools the caller switched on and in a fixed order.
    const allow = capabilities.tools
    const session: ToolSession = { run, caller, allow, depth: input.depth ?? 0, cwd: input.cwd, capabilities }
    const { plugins } = this.options

    let pi: PiSessionLike
    try {
      const tools: ToolSpec[] = [
        ...(broker ? broker.tools(session, { readOnly: typeof input.connections === 'object' && input.connections.readOnly === true }) : []),
        ...memoryTools(this.options.env, caller),
        askUserTool(run),
        pluginProposeTool(this.options.env, caller)
      ]
      for (const provider of this.providers) tools.push(...(await provider(session)))
      const params: TurnParams = {
        runId,
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
        resources: registry.resources(root, caller.projectId ?? null, caller.agentId ?? null),
        inline: [...firstPartyFor(root, caller), runLineageJoin(root, runId)],
        ...(plugins ? { plugins: { loading: () => plugins.loading({ cwd: input.cwd, agentDir: context.configDir, install: true, caller: { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null } }), loaded: (extensions) => plugins.loaded(extensions) } } : {}),
        system,
        update
      }
      pi = await this.factory({
        params,
        allow,
        gate: this.gate(run, caller, new Set((input.tools.gated ?? []).filter((name) => capabilities.tools.includes(name)))),
        tools,
        runtime: () => this.options.accounts.runtime(context),
        // An unattended run loads no extension, so it has nobody to relay for.
        ...(input.automatic ? {} : { extensions: { ask: (question) => run.requestAnswer(question), notice: (notice) => run.emit('extension.notice', notice) } })
      })
      if ((input.requiresImageInput || input.images?.length) && !pi.model?.input.includes('image')) {
        pi.dispose()
        throw new HarnessError('image_input_unsupported', 'Choose a model that supports images, or remove the image attachments and send again.')
      }
      if (input.resume?.nativeSessionId && pi.sessionId !== input.resume.nativeSessionId) {
        pi.dispose()
        run.finish('failed', { code: 'native_resume_unavailable', message: 'The saved conversation could not be restored.' })
        throw new HarnessError('native_resume_unavailable', 'The saved conversation could not be restored.')
      }
      updateRun(root, runId, (record) => void (record.nativeSessionId = pi.sessionId))
      void runTurn(run, pi, params)
      return { runId, nativeSessionId: pi.sessionId }
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'native_resume_unavailable') throw error
      const message = error instanceof Error ? error.message : String(error)
      log('session failed to start', message)
      run.finish('failed', { code: error instanceof HarnessError ? error.code : 'provider_unavailable', message })
      return { runId, nativeSessionId: null }
    }
  }
}
