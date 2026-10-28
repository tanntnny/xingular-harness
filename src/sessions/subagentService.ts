import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { loadRun as loadCapabilities } from '../capabilities/runSnapshot'
import type { CapabilitySet } from '../capabilities/types'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import { now } from '../core/fs'
import { takeChars } from '../core/text'
import type { InlineExtension } from '../plugins/firstParty'
import type { RunRegistry } from './registry'
import type { Effort } from './runner'
import type { SessionRunInput } from './sessions'
import { isActiveStatus } from './contracts'
import { narrowForProfile } from '../agents/narrow'
import { planResearchEligibility, type PlanResearchEligibility } from '../agents/planResearch'
import { resolveProfile, type AgentProfile } from '../agents/profiles'
import type { PluginDescriptor } from '../plugins/types'
import type { RunRecord } from './contracts'
import { continuationOf } from './continuation'
import { findRun, loadRun, readEvents, recordedSubagents, recordSubagent, saveRun } from './runStore'
import { SPAWN_SUBAGENT, SUBAGENT_RELATION, SUBAGENT_OWNER, SUBAGENT_RECEIPT, SUBAGENT_RESULTS, UNPROFILED_SUBAGENT, briefTitle, continueHint, subagentHistory, subagentProfileKey, subagentProfileLimit, subagentQuota, subagentTitle, type SubagentInput, type SubagentQuota, type SubagentReceipt, type SubagentResult, type SubagentSelection } from './subagents'

type Started = { runId: string; nativeSessionId: string | null }
/** What a spawn returns: the child, the profile it started from, and profile tools missing here. */
export type SpawnedSubagent = Started & { agent?: string; unavailableTools?: string[]; continued?: string }
export interface SubagentRuntimeSettings { model: string | null; effort: Effort | null }

export interface SubagentServiceOptions {
  /** The plugin descriptors, so a profile's plugin list can drop the tools those plugins own. */
  descriptors?: () => readonly PluginDescriptor[]
}
interface Parent {
  input: SessionRunInput
  accountId: string
  capabilities: CapabilitySet
  stopped: AbortController
  recovered: Set<string>
  launching: Map<string, Promise<Started>>
  ready: Promise<void>
  started: () => void
}
export interface SubagentHistory {
  owners: string[]
  receipts: SubagentReceipt[]
}

function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {})
    return Promise.reject(new HarnessError('run_not_active', 'The parent run stopped.'))
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new HarnessError('run_not_active', 'The parent run stopped.'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** One owner of native child execution and delivery, shared by SDK and terminal adapters. */
export class Subagents {
  private readonly parents = new Map<string, Parent>()
  /** Child runs reserved synchronously at spawn, before their record exists, so parallel calls cannot overspend. */
  private readonly reserved = new Map<string, Map<string, string>>()
  private readonly runtimeSettingsByRun = new Map<string, SubagentRuntimeSettings>()

  constructor(private readonly env: HarnessEnv, private readonly runs: RunRegistry, private readonly launch: (input: SessionRunInput) => Promise<Started>, private readonly options: SubagentServiceOptions = {}) {
    runs.listen((event) => {
      if (event.type !== 'completed' && event.type !== 'failed' && !(event.type === 'status.changed' && (event.payload as { status?: string }).status === 'interrupted')) return
      this.parents.get(event.runId)?.stopped.abort()
      this.parents.delete(event.runId)
      if (event.type !== 'completed') for (const id of runs.activeRunIds()) {
        const child = findRun(this.env.root, id)
        if (child?.relation === SUBAGENT_RELATION && child.parentRunId === event.runId) void runs.interrupt(id).catch(() => {})
      }
    })
  }

  /** Internal adapter contract: context comes from a live run, never from model arguments. */
  register(input: SessionRunInput, accountId: string, capabilities: CapabilitySet, deferUntilPrompt = false): void {
    if (!this.runs.active(input.run.id)) throw new HarnessError('run_not_active', 'The parent run is not active.')
    if (this.parents.has(input.run.id)) return
    const frozen = loadCapabilities(this.env.root, input.run.id)
    if (!frozen) throw invalid('A native parent requires a frozen capability snapshot.')
    const ceiling: CapabilitySet = {
      version: 1,
      tools: capabilities.tools.filter(name => frozen.tools.includes(name)),
      connectors: capabilities.connectors.filter(id => frozen.connectors.includes(id)),
      contributions: capabilities.contributions.filter(id => frozen.contributions.includes(id))
    }
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    if (!deferUntilPrompt) started()
    this.parents.set(input.run.id, { ready, started, input: structuredClone({ ...input, text: '', images: undefined, requiresImageInput: false, preamble: null, resume: null }), accountId, capabilities: ceiling, stopped: new AbortController(), recovered: new Set(), launching: new Map() })
  }

  runtimeSettings(runId: string): SubagentRuntimeSettings | null {
    return this.runtimeSettingsByRun.get(runId) ?? null
  }

  /** The budget for a run, or the foundation defaults when it has not registered one. */
  quota(runId: string): SubagentQuota {
    return subagentQuota(this.parents.get(runId)?.input.subagents ?? undefined)
  }

  private rememberRuntimeSettings(runId: string, settings: SubagentRuntimeSettings): void {
    this.runtimeSettingsByRun.set(runId, settings)
    if (this.runtimeSettingsByRun.size > 500) {
      const oldest = this.runtimeSettingsByRun.keys().next().value
      if (oldest !== undefined) this.runtimeSettingsByRun.delete(oldest)
    }
  }

  resolvedModel(runId: string, model: string, effort?: Effort): void {
    const parent = this.parents.get(runId)
    if (parent) {
      parent.input.model = model
      parent.input.effort = effort ?? parent.input.effort
    }
    const settings = this.runtimeSettingsByRun.get(runId)
    if (settings) this.rememberRuntimeSettings(runId, { model, effort: effort ?? settings.effort })
  }

  private parent(runId: string): Parent {
    const parent = this.parents.get(runId)
    if (!parent || !this.runs.active(runId)) throw new HarnessError('run_not_active', 'The parent run is not accepting subagents.')
    return parent
  }

  private planSpawnCheck(parentRunId: string, args: unknown): {
    refusal: string | null
    profile?: AgentProfile
    eligibility?: PlanResearchEligibility
  } {
    const parent = this.parents.get(parentRunId)
    if (!parent || !this.runs.active(parentRunId)) return { refusal: 'The parent run is not accepting subagents.' }
    if (!parent.input.plan) return { refusal: 'Read-only research delegation is available only during plan mode.' }
    if (!parent.capabilities.tools.includes(SPAWN_SUBAGENT)) return { refusal: 'Subagents are not enabled for this run.' }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { refusal: 'Plan-mode delegation requires a named, eligible read-only research profile.' }
    let request = args as Record<string, unknown>
    if (request.continue !== undefined) {
      // A continued child keeps its own profile; judge that profile.
      const id = typeof request.continue === 'string' ? request.continue.trim() : ''
      const record = id && this.owned(parentRunId, parent).has(id) ? findRun(this.env.root, id) : null
      if (!record?.profile) return { refusal: 'Plan mode can continue only a stopped research subagent of this conversation that has a named profile.' }
      if (request.agent !== undefined || request.tools !== undefined) return { refusal: 'A continued subagent keeps its profile and tools; omit agent and tools.' }
      request = { agent: record.profile }
    }
    if (typeof request.agent !== 'string' || !request.agent.trim()) return { refusal: 'Plan-mode delegation requires a named, eligible read-only research profile.' }
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some(name => typeof name !== 'string'))) {
      return { refusal: 'The optional tools field must be an array of tool names. Omit it to inherit the selected profile’s safe research intersection.' }
    }
    const profile = resolveProfile(this.env.root, parent.input.cwd, request.agent.trim(), parent.input.variant && 'dir' in parent.input.variant ? parent.input.variant.dir : null, parent.input.packageProfiles)
    if (!profile) return { refusal: `There is no agent profile named ${request.agent.trim()}.` }
    const eligibility = planResearchEligibility(profile, {
      frozenTools: parent.capabilities.tools,
      contributions: parent.capabilities.contributions,
      descriptors: this.options.descriptors?.() ?? []
    }, request.tools as string[] | undefined)
    return { refusal: eligibility.refusal, profile, eligibility }
  }

  /** The plan-mode per-call gate and spawn implementation share this eligibility check. */
  planSpawnRefusal(parentRunId: string, args: unknown): string | null {
    return this.planSpawnCheck(parentRunId, args).refusal
  }

  async spawn(request: SubagentInput): Promise<SpawnedSubagent> {
    const parent = this.parent(request.parentRunId)
    const { input, accountId, capabilities } = parent
    if (!capabilities.tools.includes(SPAWN_SUBAGENT)) throw invalid('Subagents are not enabled for this run.')
    if (request.continue !== undefined) return this.continueChild(parent, request)
    const brief = typeof request.brief === 'string' ? request.brief.trim() : ''
    if (!brief) throw invalid('Give the subagent a brief.')
    const title = request.title === undefined ? briefTitle(brief) : subagentTitle(request.title)
    if (!title) throw invalid('Give the subagent a title of at most six words, with no control characters.')
    if (request.wait !== undefined && typeof request.wait !== 'boolean') throw invalid('wait must be a boolean.')
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some((name) => typeof name !== 'string'))) throw invalid('Tools must be an array of tool names.')
    let profile: AgentProfile | null = null
    let planEligibility: PlanResearchEligibility | null = null
    if (input.plan) {
      const check = this.planSpawnCheck(request.parentRunId, request)
      if (check.refusal || !check.profile || !check.eligibility) throw invalid(check.refusal ?? 'The selected profile has no eligible research tools in this run.')
      profile = check.profile
      planEligibility = check.eligibility
    } else {
      const outside = request.tools?.filter((name) => !capabilities.tools.includes(name)) ?? []
      if (outside.length) throw invalid(`A subagent cannot have tools you do not have: ${outside.join(', ')}.`)
      if (request.agent !== undefined) {
        if (typeof request.agent !== 'string' || !request.agent.trim()) throw invalid('agent must be the name of an agent profile.')
        profile = resolveProfile(this.env.root, input.cwd, request.agent.trim(), input.variant && 'dir' in input.variant ? input.variant.dir : null, input.packageProfiles)
        if (!profile) throw invalid(`There is no agent profile named ${request.agent.trim()}.`)
      }
    }
    const quota = subagentQuota(input.subagents ?? undefined)
    const runId = randomUUID()
    const usage = this.usage(request.parentRunId)
    const slot = (count: number, of = '') => `${count} ${of}subagent slot${count === 1 ? '' : 's'}`
    if (usage.total >= quota.children) throw invalid(`This run has used its ${slot(quota.children)}. Do the remaining work yourself.`)
    const profileKey = subagentProfileKey(profile?.name)
    const profileLimit = subagentProfileLimit(quota, profileKey)
    const profileUsed = usage.byProfile.get(profileKey) ?? 0
    if (profileUsed >= profileLimit) {
      const label = profileKey === UNPROFILED_SUBAGENT ? 'unprofiled ' : `${profileKey} `
      throw invalid(`This run has used its ${slot(profileLimit, label)}. Do the remaining work yourself.`)
    }
    // Reserve before the first await so two tool calls in one message cannot both pass the check.
    this.reserve(request.parentRunId, runId, profileKey)
    try {
      await until(parent.ready, parent.stopped.signal)
      let variant: SessionRunInput['variant'] = input.variant ?? null
      let launch = input.launch
      let model = input.model
      let effort = input.effort
      if (profile) {
        // A variant's own subagent works from its definition alone; a profile keeps the parent's
        // variant unless it names another one, or none.
        if (profile.source === 'variant' || profile.variant === 'none') variant = null
        else if (profile.variant) variant = { scope: profile.variant.scope, version: profile.variant.version }
        if (profile.model) model = profile.model
        if (profile.effort) effort = profile.effort
        launch = { ...(input.launch ?? {}), sections: [...(input.launch?.sections ?? []).filter((section) => section.id !== 'subagent'), { id: 'subagent', title: `Your role: ${profile.name}`, body: profile.instructions || profile.description, budget: 16_000, order: 22 }] }
      }
      const narrowed = input.plan
        ? { capabilities: planEligibility!.capabilities, unavailable: planEligibility!.unavailableTools }
        : narrowForProfile(capabilities, profile, request.tools, this.options.descriptors?.() ?? [])
      const childCapabilities = narrowed.capabilities
      const tools = childCapabilities.tools
      const sessionId = randomUUID()
      const child: SessionRunInput = {
        ...input,
        run: { ...input.run, ...(input.plan ? { worktreeId: null } : {}), id: runId, sessionId, parentRunId: request.parentRunId, relation: SUBAGENT_RELATION, goal: takeChars(brief, 4000), title, attachmentCount: 0, resumedFromRunId: null, handoffId: null, profile: profile?.name ?? null },
        accountId, poolId: null, sessionDir: join(input.sessionDir, 'subagents', runId), resume: null,
        text: brief, images: undefined, requiresImageInput: false, preamble: null,
        caller: { ...input.caller, runId: undefined, sessionId },
        tools: { allow: tools, gated: (input.tools.gated ?? []).filter((name) => tools.includes(name)) },
        capabilities: childCapabilities, depth: (input.depth ?? 0) + 1,
        variant, launch, model, effort,
        ...(input.plan ? { connections: false, subagents: null } : {})
      }
      const result = await this.launchChild(parent, request, child)
      return { ...result, ...(profile ? { agent: profile.name } : {}), ...(narrowed.unavailable.length ? { unavailableTools: narrowed.unavailable } : {}) }
    } finally {
      this.release(request.parentRunId, runId)
    }
  }

  /** Records ownership, starts the child, and writes a failed record when it never opened. */
  private async launchChild(parent: Parent, request: SubagentInput, child: SessionRunInput): Promise<Started> {
    const runId = child.run.id
    this.rememberRuntimeSettings(runId, { model: child.model ?? null, effort: child.effort ?? null })
    recordSubagent(this.env.root, request.parentRunId, runId)
    const started = this.launch(child).catch((error) => {
      if (!findRun(this.env.root, runId)) {
        const source = loadRun(this.env.root, request.parentRunId)
        saveRun(this.env.root, { ...source, id: runId, sessionId: child.run.sessionId, parentRunId: request.parentRunId, relation: SUBAGENT_RELATION, nativeSessionId: null, resumedFromRunId: child.run.resumedFromRunId ?? null, handoffId: null, exitCode: null, goal: child.run.goal ?? null, title: child.run.title ?? null, attachmentCount: 0, status: 'failed', startedAt: now(), endedAt: now(), terminalReason: error instanceof HarnessError ? error.message : 'Subagent startup failed before its session opened.', profile: child.run.profile ?? null, model: child.model ?? null, effort: child.effort ?? null })
      }
      return { runId, nativeSessionId: null }
    })
    parent.launching.set(runId, started)
    void started.finally(() => parent.launching.delete(runId))
    const result = await until(started, parent.stopped.signal)
    if (request.wait) await this.wait({ parentRunId: request.parentRunId, runIds: [runId] })
    return result
  }

  /** The children this parent may read or continue: its own, and those recovered from its history. */
  private owned(parentRunId: string, parent?: Parent): Set<string> {
    return new Set([...recordedSubagents(this.env.root, parentRunId), ...(parent?.recovered ?? [])])
  }

  /** The run and the runs it was continued from, so a work-slice continuation keeps the budget. */
  private ancestry(runId: string): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current: string | null = runId
    while (current && !seen.has(current) && chain.length < 20) {
      seen.add(current)
      chain.push(current)
      current = findRun(this.env.root, current)?.resumedFromRunId ?? null
    }
    return chain
  }

  /** Distinct child conversations this run has started, plus slots reserved before their record exists. */
  private usage(parentRunId: string): { total: number; byProfile: Map<string, number> } {
    const byProfile = new Map<string, number>()
    const seen = new Set<string>()
    let total = 0
    const add = (key: string) => {
      total += 1
      byProfile.set(key, (byProfile.get(key) ?? 0) + 1)
    }
    for (const owner of this.ancestry(parentRunId)) {
      for (const id of recordedSubagents(this.env.root, owner)) {
        const record = findRun(this.env.root, id)
        if (!record || record.relation !== SUBAGENT_RELATION) continue
        // Continuing a stopped child opens a new run of the same conversation: one slot.
        const first = this.firstLink(record).id
        if (seen.has(first)) continue
        seen.add(first)
        add(subagentProfileKey(record.profile))
      }
    }
    const reserved = this.reserved.get(parentRunId)
    if (reserved) for (const [id, key] of reserved) {
      if (seen.has(id) || findRun(this.env.root, id)) continue
      seen.add(id)
      add(key)
    }
    return { total, byProfile }
  }

  private reserve(parentRunId: string, runId: string, profile: string): void {
    const reserved = this.reserved.get(parentRunId) ?? new Map<string, string>()
    reserved.set(runId, profile)
    this.reserved.set(parentRunId, reserved)
  }

  private release(parentRunId: string, runId: string): void {
    const reserved = this.reserved.get(parentRunId)
    if (!reserved) return
    reserved.delete(runId)
    if (!reserved.size) this.reserved.delete(parentRunId)
  }

  /** The newest run in a continued child's chain, among the runs this parent owns. */
  private latestLink(start: RunRecord, owned: Set<string>): RunRecord {
    const records = [...owned].flatMap((id) => findRun(this.env.root, id) ?? [])
    let latest = start
    const seen = new Set([start.id])
    for (;;) {
      const next = records.filter((record) => record.resumedFromRunId === latest.id && !seen.has(record.id)).sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1)
      if (!next) return latest
      seen.add(next.id)
      latest = next
    }
  }

  /** The first run of a chain: its folder holds the child's history for every later link. */
  private firstLink(record: RunRecord): RunRecord {
    let first = record
    const seen = new Set([record.id])
    while (first.resumedFromRunId && !seen.has(first.resumedFromRunId)) {
      const previous = findRun(this.env.root, first.resumedFromRunId)
      if (!previous || previous.relation !== SUBAGENT_RELATION) break
      seen.add(previous.id)
      first = previous
    }
    return first
  }

  /**
   * Continues a stopped child as a new child run with `continueFrom`: the same history, profile,
   * account, variant version and capability set, which must still lie within the parent's.
   */
  private async continueChild(parent: Parent, request: SubagentInput): Promise<SpawnedSubagent> {
    const { root } = this.env
    const { input, accountId, capabilities } = parent
    const requested = typeof request.continue === 'string' ? request.continue.trim() : ''
    if (!requested) throw invalid('continue must be the run ID of a subagent that stopped.')
    if (request.agent !== undefined || request.tools !== undefined) throw invalid('A continued subagent keeps its profile and tools; omit agent and tools.')
    if (request.brief !== undefined && typeof request.brief !== 'string') throw invalid('brief must be text.')
    if (request.wait !== undefined && typeof request.wait !== 'boolean') throw invalid('wait must be a boolean.')
    await until(parent.ready, parent.stopped.signal)
    const owned = this.owned(request.parentRunId, parent)
    const named = owned.has(requested) ? findRun(root, requested) : null
    if (!named || named.relation !== SUBAGENT_RELATION) throw invalid('Continue only a subagent that this conversation started.')
    const latest = this.latestLink(named, owned)
    if (isActiveStatus(latest.status)) throw invalid(`Subagent ${latest.id} is still running; wait for it with wait_subagents.`)
    if (latest.status === 'completed') throw invalid(`Subagent ${latest.id} already finished and its result was delivered. Start a new subagent for more work.`)
    const sessionDir = join(input.sessionDir, 'subagents', this.firstLink(latest).id)
    const continuation = continuationOf(root, latest.id, sessionDir)
    if (!continuation.resumable || !continuation.resume) throw invalid(`Subagent ${latest.id} cannot be continued: ${continuation.reason === 'no_history' ? 'it stopped before its conversation started' : 'its saved conversation is missing'}. Start a new subagent instead.`)
    if (continuation.accountId !== accountId) throw invalid(`Subagent ${latest.id} ran on another account; start a new subagent instead.`)
    const pinned = continuation.capabilities
    if (!pinned) throw invalid(`Subagent ${latest.id} has no recorded capabilities; start a new subagent instead.`)
    const missing = [
      ...pinned.tools.filter((name) => !capabilities.tools.includes(name)),
      ...pinned.connectors.filter((id) => !capabilities.connectors.includes(id)),
      ...pinned.contributions.filter((id) => !capabilities.contributions.includes(id))
    ]
    if (missing.length) throw invalid(`Subagent ${latest.id} needs capabilities you do not have in this run: ${missing.join(', ')}. Start a new subagent instead.`)
    let profile: AgentProfile | null = null
    if (latest.profile) profile = resolveProfile(root, input.cwd, latest.profile, input.variant && 'dir' in input.variant ? input.variant.dir : null, input.packageProfiles)
    if (input.plan) {
      // A plan run continues only a research child whose pinned tools still qualify.
      const check = latest.profile ? this.planSpawnCheck(request.parentRunId, { agent: latest.profile }) : { refusal: 'Plan mode can continue only a stopped research subagent that has a named profile.' }
      if (check.refusal || !check.eligibility) throw invalid(check.refusal ?? 'This subagent is not eligible for plan-mode research.')
      const outside = pinned.tools.filter((name) => !check.eligibility!.capabilities.tools.includes(name))
      if (outside.length) throw invalid(`Subagent ${latest.id} has tools plan mode does not allow: ${outside.join(', ')}.`)
    }
    const launch = profile
      ? { ...(input.launch ?? {}), sections: [...(input.launch?.sections ?? []).filter((section) => section.id !== 'subagent'), { id: 'subagent', title: `Your role: ${profile.name}`, body: profile.instructions || profile.description, budget: 16_000, order: 22 }] }
      : input.launch
    const runId = randomUUID()
    const child: SessionRunInput = {
      ...input,
      run: { ...input.run, ...(input.plan ? { worktreeId: null } : {}), id: runId, sessionId: latest.sessionId, parentRunId: request.parentRunId, relation: SUBAGENT_RELATION, goal: latest.goal, title: latest.title ?? briefTitle(latest.goal), attachmentCount: 0, resumedFromRunId: latest.id, handoffId: null, profile: latest.profile ?? null },
      accountId, poolId: null, sessionDir, resume: null, continueFrom: latest.id,
      text: typeof request.brief === 'string' ? request.brief.trim() : '', images: undefined, requiresImageInput: false, preamble: null,
      caller: { ...input.caller, runId: undefined, sessionId: latest.sessionId },
      tools: { allow: pinned.tools, gated: (input.tools.gated ?? []).filter((name) => pinned.tools.includes(name)) },
      capabilities: pinned, depth: (input.depth ?? 0) + 1,
      variant: null, launch,
      model: latest.model ?? input.model, effort: (latest.effort as Effort | null | undefined) ?? input.effort,
      ...(input.plan ? { connections: false, subagents: null } : {})
    }
    const result = await this.launchChild(parent, request, child)
    return { ...result, continued: latest.id, ...(latest.profile ? { agent: latest.profile } : {}) }
  }

  private selected(selection: SubagentSelection, parent?: Parent): string[] {
    const owned = this.owned(selection.parentRunId, parent)
    if (selection.runIds !== undefined && (!Array.isArray(selection.runIds) || selection.runIds.some((id) => typeof id !== 'string'))) throw invalid('runIds must be an array of child run IDs.')
    const ids = [...new Set(selection.runIds ?? [...owned])]
    if (ids.some((id) => !owned.has(id))) throw invalid('Select only subagents owned by this parent.')
    return ids
  }

  results(selection: SubagentSelection): SubagentResult[] {
    loadRun(this.env.root, selection.parentRunId)
    const parent = this.parents.get(selection.parentRunId)
    return this.selected(selection, parent).map((runId) => {
      const run = findRun(this.env.root, runId)
      const reply = run && readEvents(this.env.root, runId).filter((event) => event.type === 'message.completed' && (event.payload as { role?: unknown }).role === 'assistant').at(-1)
      const payload = reply?.payload as { text?: string } | undefined
      return { runId, status: run?.status ?? 'queued', text: takeChars(payload?.text ?? '', 16_000), terminalReason: run?.terminalReason ?? null }
    })
  }

  async wait(selection: SubagentSelection, signal?: AbortSignal): Promise<SubagentResult[]> {
    const parent = this.parent(selection.parentRunId)
    const ids = this.selected(selection, parent)
    const abort = signal ? AbortSignal.any([signal, parent.stopped.signal]) : parent.stopped.signal
    await until(Promise.all(ids.map(async (id) => {
      const starting = parent.launching.get(id)
      if (starting) await starting
      const run = findRun(this.env.root, id)
      if (run && isActiveStatus(run.status)) await this.runs.wait(id, abort)
    })), abort)
    return this.results({ ...selection, runIds: ids })
  }

  /** Reconcile only owners present on the selected native branch, with matching account and caller. */
  restore(parentRunId: string, history: SubagentHistory): void {
    const parent = this.parent(parentRunId)
    const current = loadRun(this.env.root, parentRunId)
    for (const owner of history.owners) {
      if (owner === parentRunId) continue
      const old = findRun(this.env.root, owner)
      // The owner marker on this native branch is the lineage; a host may give each launch of the
      // same conversation a new session id (INV-RUN-4).
      if (!old || old.accountId !== current.accountId || old.agentId !== current.agentId || old.projectId !== current.projectId || old.workingDirectory !== current.workingDirectory || !old.nativeSessionId || old.nativeSessionId !== current.nativeSessionId) continue
      for (const id of recordedSubagents(this.env.root, owner)) {
        let child = findRun(this.env.root, id)
        if (!child) {
          // The process can die after reserving ownership but before sessions.run saves the child.
          saveRun(this.env.root, { ...old, id, sessionId: id, parentRunId: owner, relation: SUBAGENT_RELATION, nativeSessionId: null, resumedFromRunId: null, handoffId: null, exitCode: null, goal: null, attachmentCount: 0, status: 'interrupted', startedAt: now(), endedAt: now(), terminalReason: 'Subagent startup was interrupted before its session opened.' })
          child = findRun(this.env.root, id)
        }
        if (child?.parentRunId === owner && child.relation === SUBAGENT_RELATION && child.accountId === current.accountId) parent.recovered.add(id)
      }
    }
  }

  async delivery(parentRunId: string, history: SubagentHistory, settle: boolean, signal?: AbortSignal): Promise<{ text: string; receipt: SubagentReceipt } | null> {
    const parent = this.parent(parentRunId)
    this.restore(parentRunId, history)
    if (settle) {
      // A host may start another child while earlier children are settling.
      for (;;) {
        await this.wait({ parentRunId }, signal)
        if (!parent.launching.size && this.results({ parentRunId }).every((result) => !isActiveStatus(result.status))) break
      }
    }
    const delivered = new Set(history.receipts.flatMap((receipt) => receipt.delivered ?? []))
    const all = this.results({ parentRunId })
    const records = new Map(all.map((result) => [result.runId, findRun(this.env.root, result.runId)]))
    // A stopped child that was continued is reported through its continuation instead.
    const superseded = new Set([...records.values()].flatMap((record) => record?.resumedFromRunId ? [record.resumedFromRunId] : []))
    const pending = all.filter((result) => !isActiveStatus(result.status) && !delivered.has(result.runId) && !superseded.has(result.runId))
    const chunks: string[] = []
    const ids: string[] = []
    let size = 0
    for (const result of pending) {
      const record = records.get(result.runId)
      const label = [record?.profile, record?.title].filter(Boolean).join(' · ')
      const stopped = (result.status === 'interrupted' || result.status === 'failed') && continuationOf(this.env.root, result.runId).resumable
      const text = `Subagent run ${result.runId} · ${result.status}${label ? ` (${label})` : ''}\n${result.text || result.terminalReason || 'No written reply.'}${stopped ? `\nIt stopped before finishing. ${continueHint(result.runId)}` : ''}`
      if (size + text.length > 32_000 && ids.length) break
      chunks.push(text)
      ids.push(result.runId)
      size += text.length
    }
    return ids.length ? { text: chunks.join('\n\n'), receipt: { version: 1, ownerRunId: parentRunId, delivered: ids } } : null
  }

  /** A broken adapter must fail visibly rather than complete with an undelivered child result. */
  async verify(parentRunId: string, history?: SubagentHistory): Promise<void> {
    if (history) this.restore(parentRunId, history)
    await this.wait({ parentRunId })
    if (history && await this.delivery(parentRunId, history, false)) throw new HarnessError('subagent_delivery_failed', 'A child result was not persisted in this conversation. Resume this reply to recover it.')
  }

  extension(runId: string): InlineExtension {
    return { name: 'native-subagents', factory: (pi: ExtensionAPI) => {
      pi.on('before_agent_start', async (_event, ctx) => {
        if (!this.parents.has(runId)) return
        const history = subagentHistory(ctx.sessionManager.getBranch())
        this.restore(runId, history)
        pi.appendEntry(SUBAGENT_OWNER, { runId })
        this.parent(runId).started()
        // Children an earlier reply left stopped are reported before the model answers, so it can
        // continue them instead of starting over.
        const notice = await this.delivery(runId, history, false)
        if (notice) return { message: { customType: SUBAGENT_RESULTS, content: notice.text, display: false, details: { [SUBAGENT_RECEIPT]: notice.receipt } } }
      })
      const deliver = async (event: any, ctx: any, settle: boolean) => {
        if (!this.parents.has(runId) || (settle && event.outcome !== 'completed') || ctx.signal?.aborted) return
        const history = subagentHistory([...ctx.sessionManager.getBranch(), ...event.entries])
        const result = await this.delivery(runId, history, settle, ctx.signal)
        if (!result) return
        return { entries: [...event.entries, { type: 'custom_message' as const, customType: SUBAGENT_RESULTS, content: result.text, display: false, details: { [SUBAGENT_RECEIPT]: result.receipt } }], continue: true }
      }
      pi.on('turn_end', (event, ctx) => deliver(event, ctx, false))
      pi.on('agent_before_settle', (event, ctx) => deliver(event, ctx, true))
    } }
  }
}
