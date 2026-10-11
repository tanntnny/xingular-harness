// The memory lifecycle. Imported sources and eligible settled runs become jobs; one job runs at
// a time, so the Wiki has a single writer. A job asks the maintainer session for proposals,
// checks every one against the evidence, applies the valid ones as one undoable operation, and
// sends the rest to the Inbox. When no job arrives for a while, memory blocks that are close to
// their limit are condensed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
import { accept, apply, captureHashes, describeTrigger, parseProposalSet, writeIndex, type Evidence, type Trigger } from './proposals'
import { looksSecret } from './secrets'
import * as store from './store'
import { namespaces, searchEntries } from './wiki'
import { reindexQuietly } from './wikiIndex'

export type Job = { kind: 'ingest'; namespace: string; sourceId: string } | { kind: 'run'; runId: string } | { kind: 'consolidate'; blockIds: string[] }

const FULL_PAGES = 5
const FULL_PAGE_LIMIT = 6000
/** A block this full is condensed when nothing else is happening. */
const NEAR_LIMIT_PERCENT = 90
const IDLE_CHECK_MS = 600_000

/** Conversations belong to no project, so only this setting can pause them. Absent means on. */
export function chatUpdatesPaused(settings: unknown): boolean {
  return (settings as { autoMaintenanceChat?: unknown } | null)?.autoMaintenanceChat === false
}

/** Where a settled run's knowledge is filed and what the job reads of it; throws the reason it is not eligible. */
function runEvidence(root: string, runId: string): { namespace: string; transcript: string } {
  const run = findRun(root, runId)
  if (!run) throw new Error('Run was not found.')
  const settings = readJsonOr<{ excludedSourceIds?: unknown } | null>(join(root, 'config/settings.json'), null)
  if (Array.isArray(settings?.excludedSourceIds) && settings.excludedSourceIds.includes(runId)) throw new Error('run excluded in settings')
  const projectId = run.mode === 'chat' || run.mode === 'code' ? run.projectId : null
  let namespace: string
  if (projectId) {
    const project = findProject(root, projectId)
    if (!project.autoMaintenance) throw new Error('automatic updates are paused for this project')
    namespace = project.wikiNamespace
  } else if (run.mode === 'chat') {
    if (chatUpdatesPaused(settings)) throw new Error('automatic updates are paused for Chat')
    namespace = store.LIBRARY_NAMESPACE
  } else {
    throw new Error('run has no project')
  }
  const text = transcript(run.goal ?? '', readEvents(root, runId))
  if (!text.includes('Assistant:')) throw new Error('no recorded assistant output to use as evidence')
  if (looksSecret(text)) throw new Error('the run contains text that looks like a credential')
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

export interface MaintenanceOptions {
  env: HarnessEnv
  bus: Bus
  accounts: Accounts
  factory?: MaintainerFactory
  /** How long the queue stays empty before full blocks are condensed. */
  idleMs?: number
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
    this.chain = this.chain
      .then(() => this.process(job))
      .catch((error) => log('maintenance', error instanceof Error ? error.message : String(error)))
      .then(() => this.rest())
  }

  /** A settled run is evidence; whether it is eligible is decided when its job runs. */
  onRunEvent(event: RunEvent): void {
    if (event.type === 'completed') this.enqueue({ kind: 'run', runId: event.runId })
  }

  private async process(job: Job): Promise<void> {
    const { env, bus } = this.options
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
        inbox(wiki, 'unresolved', `${sourceName} was imported but not summarized`, 'Only text sources can be synthesized automatically right now.', [])
        bus.emit({ type: 'wiki.changed' })
        return
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
        log(`maintenance skipped run ${job.runId}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      evidence.runText = evidenceText(root, job.runId)
      attached = runBlocks(env, job.runId)
      shown = found.transcript
      namespace = found.namespace
      trigger = { kind: 'run', runId: job.runId }
      request = { kind: 'run', runId: job.runId, transcript: shown }
    } else {
      attached = job.blockIds.flatMap((id) => {
        try {
          const block = blocks.find(wiki, id)
          return block.front.readOnly ? [] : [block]
        } catch {
          return []
        }
      })
      if (!attached.length) return
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
    const described = describeTrigger(trigger)
    try {
      // The job runs on the default account.
      const account = this.options.accounts.context(this.options.accounts.resolve())
      const proposed = await runMaintenance(
        { jobId: newId(), namespace, trigger: request, pages: context.pages, memories: context.memories, blocks: blockValues(attached), namespaces: namespaces(root), index },
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

