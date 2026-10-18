// The memory lifecycle. Imported sources and eligible settled runs become jobs; one job runs at
// a time, so the Wiki has a single writer. A job asks the maintainer session for proposals,
// checks every one against the evidence, applies the valid ones as one undoable operation, and
// sends the rest to the Inbox. When no job arrives for a while, memory blocks that are close to
// their limit are condensed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import type { Accounts } from '../accounts/accounts'
import { log, type Bus } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { newId, now, readJsonOr } from '../core/fs'
import { findProject } from '../core/projects'
import { charCount, takeChars } from '../core/text'
import type { RunEvent } from '../sessions/contracts'
import { findRun, readEvents } from '../sessions/runStore'
import { evidenceText, transcript } from './api'
import * as blocks from './blocks'
import { callerBlocks, type CallerContext } from './caller'
import * as facts from './facts'
import { piMaintainerFactory, runMaintenance, type ExistingBlock, type ExistingMemory, type ExistingPage, type MaintainerFactory, type MaintenanceRequest } from './maintainer'
import { inbox, undo } from './operations'
import { accept, apply, captureHashes, describeTrigger, parseProposalSet, writeIndex, type Evidence, type ProposalSet, type SourceRef, type Trigger } from './proposals'
import { looksSecret } from './secrets'
import { enqueueCuration, listCuration, curationJob, saveCuration, requireCurator, type CurationJob } from './curation'
import * as registry from '../skills/registry'
import * as attachments from '../plugins/attachments'
import { parkPluginProposal, pluginProposalSchema } from '../plugins/proposal'
import { registryProposalSchema } from './proposals'
import { writeJson } from '../core/fs'
import { invalid } from '../core/errors'
import * as store from './store'
import { namespaces, searchEntries } from './wiki'
import { reindexQuietly } from './wikiIndex'

export type Job = { kind: 'ingest'; namespace: string; sourceId: string } | { kind: 'run'; runId: string; namespace?: string } | { kind: 'consolidate'; blockIds: string[] } | { kind: 'review'; requestId?: string; manual?: boolean }

const FULL_PAGES = 5
const FULL_PAGE_LIMIT = 6000
/** A block this full is condensed when nothing else is happening. */
const NEAR_LIMIT_PERCENT = 90
const IDLE_CHECK_MS = 600_000

/** Conversations belong to no project, so only this setting can pause them. Absent means on. */
export function chatUpdatesPaused(settings: unknown): boolean {
  return (settings as { autoMaintenanceChat?: unknown } | null)?.autoMaintenanceChat === false
}

/** A run that automatic maintenance leaves alone for a settled reason: a setting, a pause, or no project. Not an error. */
class NotEligible extends Error {}

/** Where a settled run's knowledge is filed and what the job reads of it; throws the reason it is not eligible. */
function runEvidence(root: string, runId: string): { namespace: string; transcript: string } {
  const run = findRun(root, runId)
  if (!run) throw new Error('Run was not found.')
  const settings = readJsonOr<{ excludedSourceIds?: unknown } | null>(join(root, 'config/settings.json'), null)
  if (Array.isArray(settings?.excludedSourceIds) && settings.excludedSourceIds.includes(runId)) throw new NotEligible('run excluded in settings')
  const projectId = run.mode === 'chat' || run.mode === 'code' ? run.projectId : null
  let namespace: string
  if (projectId) {
    const project = findProject(root, projectId)
    if (!project.autoMaintenance) throw new NotEligible('automatic updates are paused for this project')
    namespace = project.wikiNamespace
  } else if (run.mode === 'chat') {
    if (chatUpdatesPaused(settings)) throw new NotEligible('automatic updates are paused for Chat')
    namespace = store.LIBRARY_NAMESPACE
  } else {
    throw new NotEligible('run has no project')
  }
  const text = transcript(run.goal ?? '', readEvents(root, runId))
  if (!text.includes('Assistant:')) throw new NotEligible('no recorded assistant output to use as evidence')
  if (looksSecret(text)) throw new NotEligible('the run contains text that looks like a credential')
  return { namespace, transcript: text }
}

/**
 * The blocks attached to a run, which its consolidation may rewrite: an agent's blocks for its
 * own conversation, or the `user` block and the project's brief for a session in a project.
 */
function runBlocks(env: HarnessEnv, runId: string): blocks.Block[] {
  const run = findRun(env.root, runId)
  if (!run) return []
  const chat = run.mode === 'chat'
  // What the session was told it is when it started, when that was recorded.
  const recorded = readJsonOr<CallerContext | null>(join(env.root, 'runs', run.id, 'caller.json'), null)
  const context: CallerContext = recorded ?? {
    runId: run.id,
    sessionId: run.sessionId,
    projectId: run.projectId,
    // A conversation's run names its agent; older records rely on the session being the agent's own.
    agentId: chat ? (run.agentId ?? (env.directory.agentName(run.sessionId) !== null ? run.sessionId : null)) : null,
    actor: chat ? 'Chat' : 'Code'
  }
  let attached: blocks.Block[]
  try {
    attached = callerBlocks(env, context).attached
  } catch {
    // A run with no single agent has only the shared user block attached.
    attached = [blocks.ensureUser(store.wikiDir(env.root))]
  }
  return attached.filter((block) => !block.front.readOnly)
}

/**
 * What the job sees of the Wiki: the target namespace's pages, entries relevant to the
 * evidence from anywhere (the closest few in full), and the facts that apply.
 */
function maintainerContext(root: string, namespace: string, evidence: string): { pages: ExistingPage[]; memories: ExistingMemory[] } {
  const wiki = store.wikiDir(root)
  const pages = store.loadPages(wiki)
  const query = evidence.split(/\s+/).filter((word) => Buffer.byteLength(word) > 4).slice(0, 12).join(' ')
  const ranked = searchEntries(root, query, { kinds: ['page'], limit: 30 }).map((hit) => hit.id)
  const inFull = new Set(ranked.slice(0, FULL_PAGES))
  const small = pages.filter((page) => page.location.namespace === namespace).length <= FULL_PAGES
  return {
    pages: pages
      .filter((page) => page.location.namespace === namespace || ranked.includes(page.frontmatter.id))
      .slice(0, 150)
      .map((page) => ({
        id: page.frontmatter.id,
        title: page.frontmatter.title,
        type: page.frontmatter.type,
        path: page.location.path,
        summary: store.firstParagraph(page.body),
        // An update replaces the whole body, so the job must see what the page says now.
        ...(inFull.has(page.frontmatter.id) || (page.location.namespace === namespace && small) ? { body: takeChars(page.body, FULL_PAGE_LIMIT) } : {})
      })),
    memories: facts
      .loadMemories(wiki)
      .filter((memory) => facts.appliesTo(memory.front, store.projectNamespaceOf(namespace)))
      .slice(0, 60)
      .map((memory) => ({ id: memory.front.id, title: memory.front.title, kind: memory.front.kind, namespace: memory.front.namespace, body: takeChars(memory.body, 300) }))
  }
}

/** Blocks at or over `NEAR_LIMIT_PERCENT` of their limit that have not been tried in this state. */
export function fullBlocks(wiki: string, tried: Set<string>): string[] {
  return blocks
    .loadAll(wiki)
    .filter((block) => !block.front.readOnly && block.front.limit > 0 && charCount(block.body) * 100 >= block.front.limit * NEAR_LIMIT_PERCENT)
    .filter((block) => {
      const key = `${block.id}\u0000${store.currentRevision(wiki, block.id) ?? ''}`
      return !tried.has(key) && Boolean(tried.add(key))
    })
    .map((block) => block.id)
}

const blockValues = (found: readonly blocks.Block[]): ExistingBlock[] => found.map((block) => ({ id: block.id, label: block.front.label, description: block.front.description, limit: block.front.limit, body: block.body }))

export interface MaintenanceBatchDecision {
  id: string
  decision: 'apply' | 'reject' | 'needs_user'
  reason: string
}

export interface MaintenanceOptions {
  env: HarnessEnv
  bus: Bus
  accounts: Accounts
  factory?: MaintainerFactory
  /** How long the queue stays empty before full blocks are condensed. */
  idleMs?: number
  external?: boolean
  excludedTriggers?: string[]
  /** False: a settled run queues no consolidation of its own. */
  runTrigger?: boolean
}

export class Maintenance {
  private chain: Promise<void> = Promise.resolve()
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly tried = new Set<string>()
  private stopped = false

  constructor(private readonly options: MaintenanceOptions) {}

  /** Starts the idle check. Jobs can be queued whether or not it runs. */
  start(): void {
    this.stopped = false
    if (this.options.external) {
      for (const job of this.jobs().filter((job) => job.status === 'running')) {
        job.status = 'failed'
        job.reason = 'The previous process stopped before this request settled. Retry it explicitly.'
        saveCuration(this.options.env.root, job)
      }
    }
    this.rest()
  }

  stop(): void {
    this.stopped = true
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }

  /** Resolves when every queued job has finished. */
  settled(): Promise<void> {
    return this.chain
  }

  private rest(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.stopped) return
    this.idle = setTimeout(() => {
      try {
        const blockIds = fullBlocks(store.wikiDir(this.options.env.root), this.tried)
        if (blockIds.length) this.enqueue({ kind: 'consolidate', blockIds })
        else this.rest()
      } catch {
        this.rest()
      }
    }, this.options.idleMs ?? IDLE_CHECK_MS)
    this.idle.unref?.()
  }

  enqueue(job: Job): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.options.external) {
      if (job.kind === 'run') {
        try {
          runEvidence(this.options.env.root, job.runId)
        } catch (error) {
          if (!(error instanceof NotEligible)) log('maintenance source skipped', error instanceof Error ? error.message : String(error))
          return
        }
        const run = findRun(this.options.env.root, job.runId)
        const namespace = run?.projectId ? findProject(this.options.env.root, run.projectId).wikiNamespace : store.LIBRARY_NAMESPACE
        enqueueCuration(this.options.env.root, { ...job, namespace })
      } else enqueueCuration(this.options.env.root, job)
      this.options.bus.emit({ type: 'maintenance.queued' })
      this.rest()
      return
    }
    this.chain = this.chain
      .then(() => this.process(job))
      .catch((error) => log('maintenance', error instanceof Error ? error.message : String(error)))
      .then(() => this.rest())
  }

  /** A settled run is evidence; whether it is eligible is decided when its job runs. */
  onRunEvent(event: RunEvent): void {
    if (this.options.runTrigger === false) return
    const caller = readJsonOr<CallerContext | null>(join(this.options.env.root, 'runs', event.runId, 'caller.json'), null)
    if (caller?.vaultAccess === 'curator' || this.options.excludedTriggers?.includes(findRun(this.options.env.root, event.runId)?.trigger ?? '')) return
    if (event.type === 'completed') this.enqueue({ kind: 'run', runId: event.runId })
  }

  jobs(): CurationJob[] { return listCuration(this.options.env.root) }

  /** Reads every request frozen into the current host-assigned review batch. */
  readBatch(context: CallerContext): { jobs: unknown[] } {
    requireCurator(context)
    const ids = context.maintenanceJobIds ?? (context.maintenanceJobId ? [context.maintenanceJobId] : [])
    return {
      jobs: ids.map((id) => {
        try {
          return this.readJob(context, id)
        } catch (error) {
          return { id, status: 'failed', error: error instanceof Error ? error.message : String(error) }
        }
      })
    }
  }

  /** Applies one evidence-checked Wiki change set for all accepted Wiki requests in a batch. */
  applyBatch(context: CallerContext, decisions: readonly MaintenanceBatchDecision[], replacement: unknown): { operationId: string | null; jobs: CurationJob[] } {
    requireCurator(context)
    if (!decisions.length) throw invalid('Decide every assigned request in the batch.')
    const ids = decisions.map((decision) => decision.id)
    if (new Set(ids).size !== ids.length) throw invalid('Each request can appear only once in a batch decision.')
    const assigned = context.maintenanceJobIds ?? (context.maintenanceJobId ? [context.maintenanceJobId] : [])
    const pending = assigned.map((id) => curationJob(this.options.env.root, id)).filter((job) => !['completed', 'rejected', 'needs_user'].includes(job.status))
    if (pending.some((job) => !ids.includes(job.id))) throw invalid('Decide every assigned request in one batch.')

    const entries = decisions.map((decision) => {
      if (!decision.reason.trim()) throw invalid('Explain every batch decision.')
      if (!['apply', 'reject', 'needs_user'].includes(decision.decision)) throw invalid('Choose apply, reject, or needs_user for every request.')
      const job = curationJob(this.options.env.root, decision.id)
      if (context.maintenanceJobIds !== undefined && !context.maintenanceJobIds.includes(decision.id) && !('caller' in job.input && job.input.caller.runId === context.runId)) throw invalid('This request is not assigned to this run.')
      if (job.runId && job.runId !== context.runId && job.status === 'running') throw invalid('Another run owns this request.')
      return { decision, job }
    })
    const wikiEntries = entries.filter(({ decision, job }) => decision.decision === 'apply' && !['registry', 'plugin'].includes(job.input.kind) && !['completed', 'rejected', 'needs_user'].includes(job.status))
    if (wikiEntries.length && replacement === undefined) throw invalid('Provide one combined, evidence-backed Wiki change set for the approved requests.')
    const proposals: ProposalSet | null = wikiEntries.length ? parseProposalSet(replacement) : null
    const operationId = wikiEntries.length ? `batch-${createHash('sha256').update(wikiEntries.map(({ job }) => job.id).sort().join('\0')).digest('hex').slice(0, 32)}` : null
    const results = new Map<string, CurationJob>()

    if (wikiEntries.length) {
      const prepared = wikiEntries.map(({ job }) => this.claim(context, job.id))
      const root = this.options.env.root
      const wiki = store.wikiDir(root)
      const evidence: Evidence = { runs: {}, sources: {}, blocks: [] }
      const blocksSeen = new Set<string>()
      const captured = new Map<string, string>()
      const conflicts = new Set<string>()
      for (const job of prepared) {
        const input = job.input
        for (const id of job.prepared?.evidence.blocks ?? (input.kind === 'proposal' ? input.proposals.blocks.map((proposal) => proposal.block) : [])) blocksSeen.add(id)
        for (const [id, hash] of job.hashes) {
          const previous = captured.get(id)
          if (previous !== undefined && previous !== hash) conflicts.add(id)
          else captured.set(id, hash)
        }
      }
      for (const id of conflicts) captured.set(id, `conflicting-batch-snapshot:${id}`)
      evidence.blocks = [...blocksSeen]

      const refs: SourceRef[] = [...proposals!.pages, ...proposals!.memories, ...proposals!.blocks].flatMap((proposal) => proposal.sourceRefs)
      const excluded = readJsonOr<{ excludedSourceIds?: unknown } | null>(join(root, 'config/settings.json'), null)?.excludedSourceIds
      const excludedIds = Array.isArray(excluded) ? excluded.filter((id): id is string => typeof id === 'string') : []
      for (const ref of refs) {
        if (ref.kind === 'run' && findRun(root, ref.ref)) {
          const caller = readJsonOr<CallerContext | null>(join(root, 'runs', ref.ref, 'caller.json'), null)
          if (!excludedIds.includes(ref.ref) && caller?.vaultAccess !== 'curator') {
            const text = evidenceText(root, ref.ref)
            if (!looksSecret(text)) evidence.runs![ref.ref] = takeChars(text, 60_000)
          }
        }
        if (ref.kind === 'source') {
          const source = store.listSources(wiki).find((item) => item.id === ref.ref)
          if (source) {
            try {
              const text = readFileSync(join(wiki, 'raw', source.id, source.name), 'utf8')
              if (!looksSecret(text)) evidence.sources![ref.ref] = takeChars(text, 60_000)
            } catch {
              // Missing or unreadable evidence is rejected by the proposal validator.
            }
          }
        }
      }

      const namespaceFor = (sourceRefs: readonly SourceRef[]): string => {
        for (const ref of sourceRefs) {
          const sourceJob = prepared.find((job) => {
            if (job.input.kind === 'proposal') return job.input.caller.runId === ref.ref
            if (job.input.kind === 'run') return job.input.runId === ref.ref
            if (job.input.kind === 'ingest') return job.input.sourceId === ref.ref
            return false
          })
          const namespace = sourceJob?.prepared?.namespace ?? (sourceJob?.input.kind === 'proposal' ? sourceJob.input.namespace : undefined)
          if (namespace) return namespace
        }
        return prepared[0]?.prepared?.namespace ?? (prepared[0]?.input.kind === 'proposal' ? prepared[0].input.namespace : undefined) ?? store.LIBRARY_NAMESPACE
      }
      const batchProposals: ProposalSet = {
        ...proposals!,
        pages: proposals!.pages.map((proposal) => ({ ...proposal, namespace: proposal.namespace ?? namespaceFor(proposal.sourceRefs) })),
        memories: proposals!.memories.map((proposal) => ({ ...proposal, namespace: proposal.namespace ?? namespaceFor(proposal.sourceRefs) }))
      }
      const trigger: Trigger = prepared.some((job) => job.input.kind === 'consolidate')
        ? { kind: 'consolidate' }
        : prepared.some((job) => job.input.kind === 'run')
          ? { kind: 'run', runId: (prepared.find((job) => job.input.kind === 'run')!.input as Extract<Job, { kind: 'run' }>).runId }
          : prepared.some((job) => job.input.kind === 'ingest')
            ? (prepared.find((job) => job.input.kind === 'ingest')!.prepared?.trigger ?? { kind: 'agent', runId: context.runId ?? null, actor: context.agentName ?? 'Curator' })
            : { kind: 'agent', runId: context.runId ?? null, actor: context.agentName ?? 'Curator' }
      const outcome = apply(wiki, namespaceFor(refs), trigger, batchProposals, captured, evidence, operationId!, context.agentName ?? 'Curator')
      if (outcome.operation) writeJson(join(wiki, 'operations', `${outcome.operation.id}.json`), { ...outcome.operation, protected: true })
      reindexQuietly(root)
      this.options.bus.emit({ type: 'wiki.changed' })
      let operationAssigned = false
      for (const { decision, job: original } of wikiEntries) {
        const job = curationJob(root, original.id)
        const jobReason = decision.reason.trim()
        job.status = outcome.parked ? 'needs_user' : 'completed'
        job.reason = jobReason
        job.receipt = {
          operationId: outcome.operation && !operationAssigned ? outcome.operation.id : null,
          notes: [...outcome.notes, ...(outcome.operation ? [`Combined batch operation ${outcome.operation.id}.`] : ['The combined review produced no Wiki changes.'])],
          parked: outcome.parked,
          flagged: outcome.flagged
        }
        if (outcome.operation && !operationAssigned) operationAssigned = true
        results.set(job.id, saveCuration(root, job))
      }
    }

    for (const { decision, job } of entries) {
      if (results.has(job.id) || ['completed', 'rejected', 'needs_user'].includes(job.status)) {
        results.set(job.id, curationJob(this.options.env.root, job.id))
        continue
      }
      if (decision.decision === 'apply') {
        results.set(job.id, this.applyJob(context, job.id, undefined, decision.reason))
      } else {
        results.set(job.id, this.decide(context, job.id, decision.decision, decision.reason))
      }
    }
    const receiptOperationId = [...results.values()].find((job) => job.receipt?.operationId)?.receipt?.operationId ?? null
    return { operationId: receiptOperationId, jobs: decisions.map(({ id }) => results.get(id) ?? curationJob(this.options.env.root, id)) }
  }

  claim(context: CallerContext, id: string, prepare = true): CurationJob {
    requireCurator(context)
    const root = this.options.env.root
    const job = curationJob(root, id)
    if (job.status === 'completed' || job.status === 'rejected' || job.status === 'needs_user') return job
    if (context.maintenanceJobIds !== undefined && !context.maintenanceJobIds.includes(id) && !('caller' in job.input && job.input.caller.runId === context.runId)) throw invalid('This request is not assigned to this run.')
    if (job.runId && job.runId !== context.runId && job.status === 'running') throw invalid('Another run owns this request.')
    job.runId = context.runId!
    if (prepare && job.input.kind !== 'proposal' && job.input.kind !== 'registry' && job.input.kind !== 'plugin' && !job.prepared) {
      let prepared: ReturnType<Maintenance['prepare']>
      try { prepared = this.prepare(job.input) } catch (error) { job.status = 'failed'; job.reason = error instanceof Error ? error.message : String(error); saveCuration(root, job); throw error }
      job.prepared = { request: prepared.request, evidence: prepared.evidence, namespace: prepared.namespace, trigger: prepared.trigger }
      job.hashes = [...prepared.captured]
      if (job.prepared.evidence.sourceText) job.prepared.evidence.sourceText = takeChars(job.prepared.evidence.sourceText, 60_000)
    }
    if (prepare && job.input.kind === 'proposal' && !job.prepared) {
      const input = job.input
      const origin = input.caller.runId
      const attached = input.proposals.blocks.map((proposal) => blocks.find(store.wikiDir(root), proposal.block))
      const evidence = origin && input.caller.vaultAccess !== 'curator' ? evidenceText(root, origin) : ''
      const context = maintainerContext(root, input.namespace, evidence)
      job.prepared = { request: { jobId: job.id, namespace: input.namespace, trigger: { kind: 'run', runId: origin ?? '', transcript: takeChars(evidence, 24_000) }, pages: context.pages, memories: context.memories, blocks: blockValues(attached), index: '' }, evidence: { runText: evidence, blocks: attached.map((block) => block.id) }, namespace: input.namespace, trigger: { kind: 'agent', runId: origin ?? null, actor: 'Curator' } }
    }
    job.status = 'running'
    job.runId = context.runId!
    return saveCuration(root, job)
  }

  readJob(context: CallerContext, id: string): unknown {
    const job = this.claim(context, id)
    return { id: job.id, status: job.status, input: job.input, context: job.prepared?.request ?? null, receipt: job.receipt }
  }

  decide(context: CallerContext, id: string, decision: 'reject' | 'needs_user', reason: string): CurationJob {
    if (!reason.trim()) throw invalid('Explain the decision.')
    const job = this.claim(context, id, false)
    if (job.status === 'completed' || job.status === 'rejected' || job.status === 'needs_user') return job
    job.status = decision === 'reject' ? 'rejected' : 'needs_user'
    job.reason = reason.trim()
    job.receipt = { operationId: null, notes: [job.reason], parked: decision === 'needs_user' ? 1 : 0, flagged: 0 }
    if (decision === 'needs_user') {
      const input = job.input
      if (input.kind === 'registry') {
        const proposal = input.proposal
        inbox(store.wikiDir(this.options.env.root), 'proposed', `Review ${proposal.kind}: ${proposal.name}`, reason, [], null, { kind: proposal.kind, proposal, curationJobId: id })
      } else if (input.kind === 'plugin') parkPluginProposal(store.wikiDir(this.options.env.root), `Curated request ${id}`, pluginProposalSchema.parse(input.proposal))
      else inbox(store.wikiDir(this.options.env.root), 'unresolved', 'Maintenance needs your decision', reason, [])
    }
    this.options.bus.emit({ type: 'wiki.changed' })
    return saveCuration(this.options.env.root, job)
  }

  applyJob(context: CallerContext, id: string, replacement?: unknown, reason = '', scope?: attachments.AttachScope): CurationJob {
    if (!reason.trim()) throw invalid('Explain why this change should be applied.')
    const root = this.options.env.root
    const wiki = store.wikiDir(root)
    const job = this.claim(context, id)
    if (job.status === 'completed' || job.status === 'rejected' || job.status === 'needs_user') return job
    const committed = readJsonOr<{ id: string } | null>(join(wiki, 'operations', `${job.id}.json`), null)
    if (committed) {
      job.status = 'completed'
      job.receipt = { operationId: committed.id, notes: ['This request was already committed.'], parked: 0, flagged: 0 }
      return saveCuration(root, job)
    }
    const input = job.input
    if (input.kind === 'plugin') return this.decide(context, id, 'needs_user', reason || 'Plugin files require user review before activation; executable code also needs explicit trust.')
    if (input.kind === 'registry') {
      const proposal = registryProposalSchema.parse(input.proposal)
      const itemId = `${proposal.kind}s/${store.slug(proposal.name)}`
      if (!['skill', 'prompt', 'rule'].includes(proposal.kind) || !proposal.name.trim() || !proposal.body.trim() || looksSecret(proposal.body)) throw invalid('Invalid text resource proposal.')
      const existing = registry.list(root).find((item) => item.id === itemId)
      const current = captureHashes(wiki).get(itemId)
      if (existing?.builtin || current !== new Map(job.hashes).get(itemId)) return this.decide(context, id, 'needs_user', 'The resource is built-in or changed since it was proposed. Review the current version.')
      const target = scope ?? { agentId: input.caller.agentId ?? context.agentId }
      if (target.agentId && target.projectId) throw invalid('Choose one attachment scope.')
      if (target.agentId && target.agentId !== context.agentId && target.agentId !== input.caller.agentId && !this.options.env.directory.agentName(target.agentId)) throw invalid('Unknown attachment target.')
      if (target.projectId) findProject(root, target.projectId)
      const before = existing ? store.snapshot(wiki, itemId, readFileSync(existing.path, 'utf8'), 'Curator', `Before ${id}`).id : null
      const beforeChoices = attachments.load(root)
      registry.writeItem(root, proposal.kind, proposal.name, proposal.description, proposal.body, `Curated request ${id}: ${reason || proposal.reason}`, context.agentName ?? 'Curator')
      const saved = registry.list(root).find((item) => item.id === itemId)!
      const after = store.currentRevision(wiki, itemId)!
      const choices = attachments.load(root)
      attachments.set(choices, [itemId], target, true, false)
      attachments.save(root, choices)
      writeJson(join(wiki, 'operations', `${id}.json`), { id, createdAt: now(), trigger: `Curated request ${id}`, pages: [{ pageId: itemId, path: saved.path, beforeRevisionId: before, afterRevisionId: after }], undone: false, protected: true, attachmentsBefore: beforeChoices, attachmentsAfter: choices })
      job.receipt = { operationId: id, notes: [`Saved ${itemId}; enabled for ${target.agentId ?? target.projectId ?? 'everyone'}. ${reason || proposal.reason}`], parked: 0, flagged: 0 }
      this.options.bus.emit({ type: 'plugins.changed' })
    } else {
      const prepared = job.prepared
      const proposalInput = input.kind === 'proposal' ? input : null
      const proposals = parseProposalSet(replacement ?? proposalInput?.proposals)
      const origin = proposalInput?.caller.runId ?? null
      const trigger: Trigger = prepared?.trigger ?? { kind: 'agent', runId: origin, actor: context.agentName ?? 'Curator' }
      const evidence: Evidence = input.kind === 'proposal' ? (prepared?.evidence ?? {}) : this.prepare(input).evidence
      const originEvidence: Evidence = prepared?.evidence ?? { runText: origin ? evidenceText(root, origin) : null, blocks: proposals.blocks.map((block) => block.block) }
      {
        if (input.kind === 'proposal') Object.assign(evidence, originEvidence)
        evidence.runs = {}
        evidence.sources = {}
        const refs = [...proposals.pages, ...proposals.memories, ...proposals.blocks].flatMap(proposal => proposal.sourceRefs).slice(0, 20)
        for (const ref of refs) {
          if (ref.kind === 'run' && findRun(root, ref.ref) && readJsonOr<CallerContext | null>(join(root, 'runs', ref.ref, 'caller.json'), null)?.vaultAccess !== 'curator') {
            const excluded = readJsonOr<{ excludedSourceIds?: string[] }>(join(root, 'config/settings.json'), {}).excludedSourceIds ?? []
            const text = evidenceText(root, ref.ref)
            if (!excluded.includes(ref.ref) && !looksSecret(text)) evidence.runs[ref.ref] = takeChars(text, 60_000)
          }
          if (ref.kind === 'source') {
            const source = store.listSources(wiki).find(source => source.id === ref.ref)
            if (source) {
              const text = readFileSync(join(wiki, 'raw', source.id, source.name), 'utf8')
              if (!looksSecret(text)) evidence.sources[ref.ref] = takeChars(text, 60_000)
            }
          }
        }
      }
      const outcome = apply(wiki, prepared?.namespace ?? proposalInput?.namespace ?? store.LIBRARY_NAMESPACE, trigger, proposals, new Map(job.hashes), evidence, id, context.agentName ?? 'Curator')
      if (outcome.operation) writeJson(join(wiki, 'operations', `${outcome.operation.id}.json`), { ...outcome.operation, protected: true })
      job.receipt = { operationId: outcome.operation?.id ?? null, notes: outcome.notes, parked: outcome.parked, flagged: outcome.flagged }
    }
    job.status = job.receipt.parked ? 'needs_user' : 'completed'
    job.reason = reason
    reindexQuietly(root)
    this.options.bus.emit({ type: 'wiki.changed' })
    return saveCuration(root, job)
  }

  finishRun(runId: string, failed: boolean): void {
    for (const job of this.jobs().filter((job) => job.runId === runId && job.status === 'running')) {
      job.status = failed ? 'failed' : 'completed'
      job.reason = failed ? 'The run stopped before completing this request. Retry it explicitly.' : 'The review completed without applying a change.'
      job.receipt ??= { operationId: null, notes: [job.reason], parked: 0, flagged: 0 }
      saveCuration(this.options.env.root, job)
    }
  }

  retry(id: string): CurationJob {
    const job = curationJob(this.options.env.root, id)
    if (job.status !== 'failed') throw invalid('Only a failed request can be retried.')
    return saveCuration(this.options.env.root, { ...job, status: 'queued', runId: null, reason: '', receipt: null })
  }

  prepare(job: Job): { request: MaintenanceRequest; evidence: Evidence; captured: Map<string, string>; namespace: string; trigger: Trigger } {
    const { env } = this.options
    const root = env.root
    const wiki = store.wikiDir(root)
    const evidence: Evidence = {}
    let attached: blocks.Block[] = []
    let namespace: string
    let trigger: Trigger
    let request: MaintenanceRequest['trigger']
    let shown = ''
    if (job.kind === 'ingest') {
      const directory = join(wiki, 'raw', job.sourceId)
      const name = readJsonOr<{ name?: unknown } | null>(join(directory, 'meta.json'), null)?.name
      const sourceName = typeof name === 'string' ? name : 'source'
      let text: string | null = null
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(directory, sourceName)))
      } catch {
        text = null
      }
      if (text === null) {
        throw invalid('Only text sources can be synthesized automatically right now.')
      }
      shown = takeChars(text, 60_000)
      evidence.sourceText = text
      namespace = job.namespace
      trigger = { kind: 'ingest', sourceId: job.sourceId, sourceName }
      request = { kind: 'ingest', sourceId: job.sourceId, sourceName, text: shown }
    } else if (job.kind === 'run') {
      let found: ReturnType<typeof runEvidence>
      try {
        found = runEvidence(root, job.runId)
      } catch (error) {
        throw error
      }
      evidence.runText = evidenceText(root, job.runId)
      attached = runBlocks(env, job.runId)
      shown = found.transcript
      namespace = found.namespace
      trigger = { kind: 'run', runId: job.runId }
      request = { kind: 'run', runId: job.runId, transcript: shown }
    } else {
      attached = (job.kind === 'review' ? blocks.loadAll(wiki).filter((block) => !block.front.readOnly).sort((a, b) => charCount(b.body) / b.front.limit - charCount(a.body) / a.front.limit).slice(0, 30).map((block) => block.id) : job.blockIds).flatMap((id) => {
        try {
          const block = blocks.find(wiki, id)
          return block.front.readOnly ? [] : [block]
        } catch {
          return []
        }
      })
      if (!attached.length && job.kind !== 'review') throw invalid('No writable blocks remain in this job.')
      namespace = store.LIBRARY_NAMESPACE
      trigger = { kind: 'consolidate' }
      request = { kind: 'consolidate' }
    }
    evidence.blocks = attached.map((block) => block.id)
    const captured = captureHashes(wiki)
    const context = trigger.kind === 'consolidate' ? { pages: [], memories: [] } : maintainerContext(root, namespace, shown)
    let index = ''
    try {
      index = takeChars(readFileSync(join(wiki, 'index.md'), 'utf8'), 8000)
    } catch {
      index = ''
    }
    return { request: { jobId: '', namespace, trigger: request, pages: context.pages, memories: context.memories, blocks: blockValues(attached), namespaces: namespaces(root), index }, evidence, captured, namespace, trigger }
  }

  private async process(job: Job): Promise<void> {
    const { env, bus } = this.options
    const root = env.root
    const wiki = store.wikiDir(root)
    let prepared: ReturnType<Maintenance['prepare']>
    try { prepared = this.prepare(job) } catch (error) {
      // A run that is not eligible is an expected outcome, not a problem to report.
      if (error instanceof NotEligible) return
      const message = error instanceof Error ? error.message : String(error)
      if (job.kind === 'run') log(`maintenance skipped run ${job.runId}: ${message}`)
      else if (job.kind === 'ingest') { inbox(wiki, 'unresolved', 'Source was imported but not summarized', message, []); bus.emit({ type: 'wiki.changed' }) }
      return
    }
    const { namespace, trigger, evidence, captured } = prepared
    const described = describeTrigger(trigger)
    try {
      // The job runs on the default account.
      const account = this.options.accounts.context(this.options.accounts.resolve())
      const proposed = await runMaintenance(
        { ...prepared.request, jobId: newId() },
        { cwd: wiki, product: env.productName, account, runtime: () => this.options.accounts.runtime(account) },
        this.options.factory ?? piMaintainerFactory
      )
      const outcome = apply(wiki, namespace, trigger, parseProposalSet(proposed), captured, evidence)
      reindexQuietly(root)
      if (outcome.operation) {
        const count = outcome.operation.pages.length
        bus.emit({ type: 'wiki.maintenance', namespace, title: `Wiki updated ${count} entr${count === 1 ? 'y' : 'ies'}`, detail: `From ${described}. ${outcome.parked} parked, ${outcome.flagged} flagged for review.` })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        inbox(wiki, 'blocked', `Consolidation for ${described} did not finish`, message, [])
        store.log(wiki, `- ${now()} · Sleep-time · ${described} · failed: ${message}`)
      } catch {
        // The failure is still logged by the queue.
      }
    }
    bus.emit({ type: 'wiki.changed' })
  }

  // ---- What a person does from the Inbox -------------------------------------------------------

  /** Reverts an applied operation through new revisions. */
  undoOperation(operationId: string): void {
    const { root } = this.options.env
    const wiki = store.wikiDir(root)
    const operation = undo(wiki, operationId)
    writeIndex(wiki)
    const count = operation.pages.length
    inbox(wiki, 'applied', `Undid an update to ${count} entr${count === 1 ? 'y' : 'ies'}`, "Earlier content was restored as new revisions; created entries moved to the Wiki's trash folder.", operation.pages.map((page) => page.pageId))
    reindexQuietly(root)
    this.options.bus.emit({ type: 'wiki.changed' })
  }

  /** Accepts a parked proposal with the user as the authority. */
  acceptInboxItem(itemId: string): string {
    const { root } = this.options.env
    const message = accept(root, itemId)
    reindexQuietly(root)
    this.options.bus.emit({ type: 'wiki.changed' })
    return message
  }

  /** Imports a file as an immutable source and queues the job that reads it. */
  ingest(name: string, bytes: Uint8Array, namespace: string = store.LIBRARY_NAMESPACE): store.WikiSource {
    const { root } = this.options.env
    const wiki = store.wikiDir(root)
    store.namespaceDir(wiki, namespace)
    const source = store.importSource(wiki, name.replace(/[/\\]/g, '_'), bytes)
    reindexQuietly(root)
    this.enqueue({ kind: 'ingest', namespace, sourceId: source.id })
    return source
  }
}

