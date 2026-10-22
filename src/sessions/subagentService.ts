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
import { subagentOf } from '../variant/materialise'
import { findRun, loadRun, readEvents, recordedSubagents, recordSubagent, saveRun } from './runStore'
import { SPAWN_SUBAGENT, SUBAGENT_RELATION, SUBAGENT_OWNER, SUBAGENT_RECEIPT, SUBAGENT_RESULTS, subagentHistory, type SubagentInput, type SubagentReceipt, type SubagentResult, type SubagentSelection } from './subagents'

type Started = { runId: string; nativeSessionId: string | null }
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

  constructor(private readonly env: HarnessEnv, private readonly runs: RunRegistry, private readonly launch: (input: SessionRunInput) => Promise<Started>) {
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

  resolvedModel(runId: string, model: string, effort?: Effort): void {
    const parent = this.parents.get(runId)
    if (parent) {
      parent.input.model = model
      parent.input.effort = effort ?? parent.input.effort
    }
  }

  private parent(runId: string): Parent {
    const parent = this.parents.get(runId)
    if (!parent || !this.runs.active(runId)) throw new HarnessError('run_not_active', 'The parent run is not accepting subagents.')
    return parent
  }

  async spawn(request: SubagentInput): Promise<Started> {
    const parent = this.parent(request.parentRunId)
    const { input, accountId, capabilities } = parent
    if (!capabilities.tools.includes(SPAWN_SUBAGENT)) throw invalid('Subagents are not enabled for this run.')
    const brief = typeof request.brief === 'string' ? request.brief.trim() : ''
    if (!brief) throw invalid('Give the subagent a brief.')
    if (request.wait !== undefined && typeof request.wait !== 'boolean') throw invalid('wait must be a boolean.')
    if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some((name) => typeof name !== 'string'))) throw invalid('Tools must be an array of tool names.')
    const outside = request.tools?.filter((name) => !capabilities.tools.includes(name)) ?? []
    if (outside.length) throw invalid(`A subagent cannot have tools you do not have: ${outside.join(', ')}.`)
    const tools = capabilities.tools.filter((name) => !request.tools || request.tools.includes(name))
    await until(parent.ready, parent.stopped.signal)
    let variant = input.variant ?? null
    let launch = input.launch
    if (request.agent !== undefined) {
      if (typeof request.agent !== 'string' || !request.agent.trim()) throw invalid('agent must be the name of one of your subagents.')
      const dir = variant && 'dir' in variant ? variant.dir : null
      const definition = dir ? subagentOf(dir, request.agent.trim()) : null
      if (!definition) throw invalid(`There is no subagent named ${request.agent.trim()}.`)
      // A named subagent works from its own definition, not from the parent's instructions.
      variant = null
      launch = { ...(input.launch ?? {}), sections: [...(input.launch?.sections ?? []).filter((section) => section.id !== 'subagent'), { id: 'subagent', title: `Your role: ${definition.name}`, body: definition.instructions || definition.description, budget: 16_000, order: 22 }] }
    }
    const runId = randomUUID()
    const sessionId = randomUUID()
    recordSubagent(this.env.root, request.parentRunId, runId)
    const child: SessionRunInput = {
      ...input,
      run: { ...input.run, id: runId, sessionId, parentRunId: request.parentRunId, relation: SUBAGENT_RELATION, goal: takeChars(brief, 4000), attachmentCount: 0, resumedFromRunId: null, handoffId: null },
      accountId, poolId: null, sessionDir: join(input.sessionDir, 'subagents', runId), resume: null,
      text: brief, images: undefined, requiresImageInput: false, preamble: null,
      caller: { ...input.caller, runId: undefined, sessionId },
      tools: { allow: tools, gated: (input.tools.gated ?? []).filter((name) => tools.includes(name)) },
      capabilities: { ...capabilities, tools }, depth: (input.depth ?? 0) + 1,
      variant, launch
    }
    const started = this.launch(child).catch((error) => {
      if (!findRun(this.env.root, runId)) {
        const source = loadRun(this.env.root, request.parentRunId)
        saveRun(this.env.root, { ...source, id: runId, sessionId, parentRunId: request.parentRunId, relation: SUBAGENT_RELATION, nativeSessionId: null, resumedFromRunId: null, handoffId: null, exitCode: null, goal: takeChars(brief, 4000), attachmentCount: 0, status: 'failed', startedAt: now(), endedAt: now(), terminalReason: error instanceof HarnessError ? error.message : 'Subagent startup failed before its session opened.' })
      }
      return { runId, nativeSessionId: null }
    })
    parent.launching.set(runId, started)
    void started.finally(() => parent.launching.delete(runId))
    const result = await until(started, parent.stopped.signal)
    if (request.wait) await this.wait({ parentRunId: request.parentRunId, runIds: [runId] })
    return result
  }

  private selected(selection: SubagentSelection, parent?: Parent): string[] {
    const owned = new Set([...recordedSubagents(this.env.root, selection.parentRunId), ...(parent?.recovered ?? [])])
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
      if (!old || old.sessionId !== current.sessionId || old.accountId !== current.accountId || old.agentId !== current.agentId || old.projectId !== current.projectId || old.workingDirectory !== current.workingDirectory || !old.nativeSessionId || old.nativeSessionId !== current.nativeSessionId) continue
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
    const pending = this.results({ parentRunId }).filter((result) => !isActiveStatus(result.status) && !delivered.has(result.runId))
    const chunks: string[] = []
    const ids: string[] = []
    let size = 0
    for (const result of pending) {
      const text = `Subagent run ${result.runId} · ${result.status}\n${result.text || result.terminalReason || 'No written reply.'}`
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
      pi.on('before_agent_start', (_event, ctx) => {
        if (!this.parents.has(runId)) return
        this.restore(runId, subagentHistory(ctx.sessionManager.getBranch()))
        pi.appendEntry(SUBAGENT_OWNER, { runId })
        this.parent(runId).started()
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
