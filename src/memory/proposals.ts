// Validated Wiki updates.
//
// Agents and the sleep-time maintainer only *propose* pages, facts, and block rewrites. This
// module validates every proposal (type, links, evidence, confidence, secrets, concurrent
// edits), applies the valid ones as one atomic operation with revisions, and sends the rest to
// the Inbox, where the user can accept them. Proposals to change skills, prompts, or rules
// always wait in the Inbox.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod'

import { noteChange } from '../core/changes'
import { HarnessError, invalid, notFound } from '../core/errors'
import { atomicWrite, newId, now, readJson, safeId, writeJson } from '../core/fs'
import { charCount, compareText, takeChars } from '../core/text'
import { acceptPluginProposal, pluginProposalSchema } from '../plugins/proposal'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import * as facts from './facts'
import { inbox, operationsDir, type InboxItem, type Operation, type OperationPage } from './operations'
import { looksSecret } from './secrets'
import * as store from './store'
import { LINK_TYPES, PAGE_TYPES, type WikiLink } from './store'

// ---- Proposals ------------------------------------------------------------------------------

const optionalText = z.string().nullish().transform((value) => value ?? null)

const sourceRefSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  /** A passage quoted from the evidence. A run or source reference counts only when this passage is found in it. */
  excerpt: z.string().nullish().transform((value) => value ?? undefined)
})
export type SourceRef = z.infer<typeof sourceRefSchema>

const linkProposalSchema = z.object({ toId: z.string(), type: z.string() })
export type LinkProposal = z.infer<typeof linkProposalSchema>

export const pageProposalSchema = z.object({
  id: optionalText,
  title: z.string(),
  type: z.string(),
  body: z.string(),
  /** Where a new page is filed (`/library`, `/projects/<slug>`); the job's namespace by default. */
  namespace: optionalText,
  confidence: optionalText,
  sourceRefs: z.array(sourceRefSchema).default([]),
  links: z.array(linkProposalSchema).default([])
})
export type PageProposal = z.infer<typeof pageProposalSchema>

export const memoryProposalSchema = z.object({
  id: optionalText,
  title: z.string(),
  kind: z.string(),
  body: z.string(),
  /** `/` for everything, or a project namespace. The job's project namespace by default. */
  namespace: optionalText,
  confidence: optionalText,
  supersedes: optionalText,
  volatile: z.boolean().nullish().transform((value) => value ?? null),
  sourceRefs: z.array(sourceRefSchema).default([]),
  links: z.array(linkProposalSchema).default([])
})
export type MemoryProposal = z.infer<typeof memoryProposalSchema>

/** A rewritten memory block from sleep-time consolidation. */
const blockProposalSchema = z.object({ block: z.string(), body: z.string(), sourceRefs: z.array(sourceRefSchema).default([]) })
export type BlockProposal = z.infer<typeof blockProposalSchema>

const claimFlagSchema = z.object({ claim: z.string(), kind: z.string(), reason: z.string() })
export type ClaimFlag = z.infer<typeof claimFlagSchema>

export const proposalSetSchema = z.object({
  pages: z.array(pageProposalSchema).default([]),
  memories: z.array(memoryProposalSchema).default([]),
  blocks: z.array(blockProposalSchema).default([]),
  flags: z.array(claimFlagSchema).default([])
})
export type ProposalSet = z.infer<typeof proposalSetSchema>

export function parseProposalSet(value: unknown): ProposalSet {
  const parsed = proposalSetSchema.safeParse(value ?? {})
  if (!parsed.success) throw new HarnessError('invalid_data', `Stored data could not be read: ${parsed.error.issues[0]?.message ?? 'invalid proposals'}`)
  return parsed.data
}

/** The text proposals are checked against, and the blocks a job may rewrite. */
export interface Evidence {
  /** The triggering run's request, assistant messages, and tool summaries. */
  runText?: string | null
  /** The imported source's text. */
  sourceText?: string | null
  /** Ids of the blocks attached to the run. */
  blocks?: string[]
}

const MIN_EXCERPT = 12

function squash(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ').toLowerCase()
}

/**
 * Whether `excerpt` occurs in `text`, ignoring case and runs of whitespace. Short excerpts
 * prove nothing, so they never count.
 */
export function quotedIn(text: string | null | undefined, excerpt: string | null | undefined): boolean {
  if (typeof text !== 'string' || typeof excerpt !== 'string') return false
  const wanted = squash(excerpt)
  return charCount(wanted) >= MIN_EXCERPT && squash(text).includes(wanted)
}

/** What caused the change; decides which evidence references are valid and who the actor is. */
export type Trigger =
  | { kind: 'ingest'; sourceId: string; sourceName: string }
  | { kind: 'run'; runId: string }
  /** An agent's `wiki_propose` during a run. */
  | { kind: 'agent'; runId: string | null; actor: string }
  /** The user accepted an Inbox item. */
  | { kind: 'user'; itemId: string }
  /** Idle consolidation of memory blocks that are close to their limit. */
  | { kind: 'consolidate' }

export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'ingest':
      return `ingest of ${trigger.sourceName} (${trigger.sourceId})`
    case 'run':
      return `run ${trigger.runId}`
    case 'agent':
      return trigger.runId ? `${trigger.actor} agent in run ${trigger.runId}` : `${trigger.actor} agent`
    case 'user':
      return `Inbox item ${trigger.itemId.slice(0, 8)}`
    case 'consolidate':
      return 'consolidation of full memory blocks'
  }
}

function triggerActor(trigger: Trigger): string {
  return trigger.kind === 'agent' ? trigger.actor : trigger.kind === 'user' ? 'user' : 'Sleep-time'
}

function triggerRunId(trigger: Trigger): string | null {
  return trigger.kind === 'run' ? trigger.runId : trigger.kind === 'agent' ? trigger.runId : null
}

// ---- Applying ---------------------------------------------------------------------------------

function fileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Captures page, fact, and block file hashes when a job starts, to detect edits made while it ran. */
export function captureHashes(wiki: string): Map<string, string> {
  const hashes = new Map<string, string>()
  const add = (id: string, path: string) => {
    const hash = fileHash(path)
    if (hash) hashes.set(id, hash)
  }
  for (const page of store.loadPages(wiki)) add(page.frontmatter.id, page.path)
  for (const memory of facts.loadMemories(wiki)) add(memory.front.id, memory.path)
  for (const block of blocks.loadAll(wiki)) add(block.id, block.path)
  return hashes
}

/**
 * Rewrites the generated indexes: the root `index.md` lists the namespaces, and each namespace
 * has its own `index.md` listing its pages with one line each. Any page is two steps away.
 */
export function writeIndex(wiki: string): void {
  const pages = store.loadPages(wiki)
  const memories = facts.loadMemories(wiki)
  const namespaces = [...new Set(pages.map((page) => page.location.namespace).filter((namespace) => namespace !== store.ROOT_NAMESPACE))].sort(compareText)
  let root = '# Wiki index\n\nEach namespace has its own index of pages.\n\n'
  if (!namespaces.length) root += 'No pages yet.\n'
  for (const namespace of namespaces) {
    const own = pages.filter((page) => page.location.namespace === namespace).sort((left, right) => compareText(left.location.path, right.location.path))
    const folder = namespace.replace(/^\/+/, '')
    root += `- [${namespace}](${folder}/index.md) — ${own.length} page${own.length === 1 ? '' : 's'}\n`
    let text = `# Index of ${namespace}\n\n`
    for (const page of own) {
      const inside = relative(join(wiki, folder), page.path)
      text += `- [${page.frontmatter.title}](${inside.startsWith('..') ? page.path : inside}) (${page.frontmatter.type}, \`${page.frontmatter.id}\`) — ${store.firstParagraph(page.body)}\n`
    }
    atomicWrite(join(wiki, folder, 'index.md'), text)
  }
  const active = memories.filter((memory) => memory.front.status === 'active')
  if (active.length) {
    root += '\n## Facts\n\n'
    for (const memory of active) root += `- [${memory.front.title}](facts/${memory.front.id}.md) (${memory.front.kind}, ${memory.front.namespace}${memory.front.volatile ? ', volatile' : ''})\n`
  }
  atomicWrite(join(wiki, 'index.md'), root)
}

export interface ApplyOutcome {
  operation: Operation | null
  parked: number
  flagged: number
  /** One line per proposal: what happened to it. */
  notes: string[]
}

interface Write {
  entryId: string
  path: string
  oldText: string | null
  newText: string
}

/** Validates proposals and applies the valid ones as one operation. Pure file logic. */
export function apply(wiki: string, defaultNamespace: string, trigger: Trigger, proposals: ProposalSet, captured: ReadonlyMap<string, string>, evidence: Evidence): ApplyOutcome {
  const existing = store.loadPages(wiki)
  const existingMemories = facts.loadMemories(wiki)
  const root = dirname(wiki)
  const sourceIds = new Set(store.listSources(wiki).map((source) => source.id))
  const knownIds = new Set<string>([
    ...existing.map((page) => page.frontmatter.id),
    ...existingMemories.map((memory) => memory.front.id),
    ...registry.list(root).map((item) => item.id),
    ...sourceIds
  ])
  const proposedIds = new Set<string>([
    ...proposals.pages.map((page) => store.slug(page.id ?? page.title)),
    ...proposals.memories.map((memory) => store.slug(memory.id ?? memory.title))
  ])
  const outcome: ApplyOutcome = { operation: null, parked: 0, flagged: 0, notes: [] }
  const writes: Write[] = []
  const actor = triggerActor(trigger)
  const described = describeTrigger(trigger)
  const fromUser = trigger.kind === 'user'

  // Sends one proposal to the Inbox with its payload, so the user can accept it later.
  const park = (kind: string, title: string, label: string, reason: string, body: string, entryId: string, payload: unknown): void => {
    outcome.parked += 1
    outcome.notes.push(`${label} went to the Inbox: ${reason}`)
    inbox(wiki, kind, title, `${reason}\n\n${takeChars(body, 600)}`, [entryId], null, payload)
  }

  // Evidence: a source in the Wiki, the triggering run, a URL, or the user's acceptance. A run
  // or an imported source counts only with an excerpt found in its text; a bare reference to
  // the caller's own run proves nothing.
  const evidenceFor = (refs: readonly SourceRef[]): string[] => {
    const found: string[] = []
    for (const reference of refs) {
      let id: string | null = null
      if (reference.kind === 'source') {
        if (sourceIds.has(reference.ref) && (evidence.sourceText == null || quotedIn(evidence.sourceText, reference.excerpt))) id = reference.ref
      } else if (reference.kind === 'run') {
        if (triggerRunId(trigger) === reference.ref && quotedIn(evidence.runText, reference.excerpt)) id = `run:${reference.ref}`
      } else if (reference.kind === 'url') {
        if (reference.ref.startsWith('https://') || reference.ref.startsWith('http://')) id = `url:${reference.ref}`
      } else if (reference.kind === 'user') {
        if (fromUser) id = 'user:accepted'
      }
      if (id && !found.includes(id)) found.push(id)
    }
    return found
  }
  const filterLinks = (links: readonly LinkProposal[], ownId: string): WikiLink[] =>
    links
      .filter((link) => (LINK_TYPES as readonly string[]).includes(link.type))
      .filter((link) => knownIds.has(link.toId) || proposedIds.has(link.toId))
      .filter((link) => link.toId !== ownId)
      .map((link) => ({ fromId: ownId, toId: link.toId, type: link.type }))
  const changedSince = (id: string, path: string): boolean => captured.has(id) && captured.get(id) !== fileHash(path)

  for (const proposal of proposals.pages) {
    const pageId = store.slug(proposal.id ?? proposal.title)
    const current = existing.find((page) => page.frontmatter.id === pageId)
    const namespace = current?.location.namespace ?? proposal.namespace ?? defaultNamespace
    const payload = { kind: 'page', namespace, proposal, trigger: described }
    const label = `Page "${proposal.title}"`
    const blocked = `Proposed page "${proposal.title}" was not applied`

    if (!(PAGE_TYPES as readonly string[]).includes(proposal.type) || !proposal.title.trim() || !proposal.body.trim()) {
      park('blocked', blocked, label, 'The proposal was incomplete (type, title, or body).', proposal.body, pageId, payload)
      continue
    }
    if (looksSecret(proposal.body) || looksSecret(proposal.title)) {
      // Never stored, not even in the Inbox payload.
      outcome.parked += 1
      outcome.notes.push(`Page "${proposal.title}" was rejected: it contains text that looks like a credential.`)
      inbox(wiki, 'blocked', blocked, 'The proposal contained text that looks like a credential, so it was not written.', [pageId])
      continue
    }
    let targetDir: string | null = null
    if (!current) {
      try {
        targetDir = store.namespaceDir(wiki, namespace)
      } catch (error) {
        park('blocked', blocked, label, error instanceof Error ? error.message : String(error), proposal.body, pageId, payload)
        continue
      }
    }
    // Consolidating a run never creates a page: one run is an episode, not an entity.
    if (!current && (trigger.kind === 'run' || trigger.kind === 'consolidate')) {
      park('unresolved', `"${proposal.title}" would be a new page`, label, 'Sleep-time consolidation updates existing pages only. Accept this to create the page.', proposal.body, pageId, payload)
      continue
    }
    const found = evidenceFor(proposal.sourceRefs)
    if (!found.length) {
      park('unresolved', `"${proposal.title}" has no verifiable evidence`, label, 'The proposal quotes nothing the host could find in its source or run, so it was not written.', proposal.body, pageId, payload)
      continue
    }
    if (proposal.confidence === 'low' && !fromUser) {
      park('unresolved', `"${proposal.title}" is low confidence`, label, 'Low-confidence proposals wait for review.', proposal.body, pageId, payload)
      continue
    }
    // An entry edited while the job ran is never overwritten.
    if (current && changedSince(pageId, current.path)) {
      park('blocked', blocked, label, 'The page changed while the update was running, so the proposal was parked instead of overwriting the edit.', proposal.body, pageId, payload)
      continue
    }

    const links = filterLinks(proposal.links, pageId)
    const contradicted = links.filter((link) => link.type === 'contradicts')
    if (contradicted.length) {
      inbox(wiki, 'unresolved', `"${proposal.title}" contradicts another entry`, 'The page was written with an explicit contradicts link. Review both claims and their sources.', [pageId, ...contradicted.map((link) => link.toId)])
      outcome.flagged += 1
    }
    const sourceList = current ? [...current.frontmatter.sourceIds] : []
    for (const id of found) if (!sourceList.includes(id)) sourceList.push(id)
    const front = { id: pageId, title: proposal.title.trim(), type: proposal.type, updatedAt: now(), sourceIds: sourceList, links }
    const path = current?.path ?? join(targetDir!, `${pageId}.md`)
    outcome.notes.push(`Page "${proposal.title}" (${pageId}) ${current ? 'updated' : 'created'} in ${namespace}.`)
    writes.push({ entryId: pageId, oldText: current ? readOrNull(current.path) : null, newText: store.serializePage(front, proposal.body), path })
  }

  const projectDefault = store.projectNamespaceOf(defaultNamespace) ?? store.ROOT_NAMESPACE
  for (const proposal of proposals.memories) {
    const memoryId = store.slug(proposal.id ?? proposal.title)
    const current = existingMemories.find((memory) => memory.front.id === memoryId)
    const payload = { kind: 'memory', proposal, trigger: described }
    const label = `Fact "${proposal.title}"`
    const title = `Fact "${proposal.title}" needs review`
    if (looksSecret(proposal.body) || looksSecret(proposal.title)) {
      outcome.parked += 1
      outcome.notes.push(`Fact "${proposal.title}" was rejected: it contains text that looks like a credential.`)
      inbox(wiki, 'blocked', `Fact "${proposal.title}" was not saved`, 'The proposal contained text that looks like a credential, so it was not written.', [])
      continue
    }
    const front: facts.MemoryFront = {
      id: memoryId,
      title: proposal.title.trim(),
      kind: proposal.kind,
      namespace: current?.front.namespace ?? proposal.namespace ?? projectDefault,
      sourceIds: current ? [...current.front.sourceIds] : [],
      confidence: proposal.confidence ?? 'medium',
      status: 'active',
      supersedes: proposal.supersedes && existingMemories.some((memory) => memory.front.id === proposal.supersedes) ? proposal.supersedes : null,
      links: filterLinks(proposal.links, memoryId),
      createdAt: current?.front.createdAt || now(),
      updatedAt: now(),
      observedAt: now(),
      volatile: proposal.volatile ?? current?.front.volatile ?? false
    }
    const problem = facts.validate(front, proposal.body)
    if (problem) {
      park('blocked', title, label, problem, proposal.body, memoryId, payload)
      continue
    }
    const found = evidenceFor(proposal.sourceRefs)
    if (!found.length) {
      park('unresolved', title, label, 'The fact quotes nothing the host could find in its source or run, so it was not saved.', proposal.body, memoryId, payload)
      continue
    }
    if (front.confidence === 'low' && !fromUser) {
      park('unresolved', title, label, 'Low-confidence facts wait for review.', proposal.body, memoryId, payload)
      continue
    }
    if (current && changedSince(memoryId, current.path)) {
      park('blocked', title, label, 'The fact changed while the update was running, so the proposal was parked.', proposal.body, memoryId, payload)
      continue
    }
    for (const id of found) if (!front.sourceIds.includes(id)) front.sourceIds.push(id)
    // A superseding fact retires the one it replaces in the same operation.
    const old = front.supersedes ? existingMemories.find((memory) => memory.front.id === front.supersedes) : undefined
    if (old) {
      writes.push({ entryId: old.front.id, path: old.path, oldText: readOrNull(old.path), newText: facts.serialize({ ...old.front, status: 'superseded', updatedAt: now() }, old.body) })
    }
    const path = current?.path ?? facts.pathFor(wiki, memoryId)
    outcome.notes.push(`Fact "${proposal.title}" (${memoryId}) ${current ? 'updated' : 'saved'}.`)
    writes.push({ entryId: memoryId, oldText: current ? readOrNull(current.path) : null, newText: facts.serialize(front, proposal.body), path })
  }

  const attachedBlocks = evidence.blocks ?? []
  for (const proposal of proposals.blocks) {
    const refuse = (reason: string): void => {
      outcome.parked += 1
      outcome.notes.push(`Block ${proposal.block} was not rewritten: ${reason}`)
      inbox(wiki, 'unresolved', `A rewrite of ${proposal.block} was not applied`, `${reason}\n\n${takeChars(proposal.body, 600)}`, [proposal.block])
    }
    let block: blocks.Block
    try {
      block = blocks.find(wiki, proposal.block)
    } catch {
      refuse('there is no such memory block.')
      continue
    }
    const body = proposal.body.trim()
    if (!attachedBlocks.includes(block.id) || block.front.readOnly) {
      refuse('the block is not attached to this run, or it is read-only.')
      continue
    }
    const problem = blocks.check(block.front, body)
    if (problem) {
      refuse(problem)
      continue
    }
    // A full block is only condensed: the rewrite must be shorter and add no evidence.
    const grounded = trigger.kind === 'consolidate' ? body !== '' && charCount(body) < charCount(block.body) : evidenceFor(proposal.sourceRefs).length > 0
    if (!grounded) {
      refuse(trigger.kind === 'consolidate' ? 'a consolidated block must be shorter than it was.' : 'it quotes nothing the host could find in the run.')
      continue
    }
    if (changedSince(block.id, block.path)) {
      refuse('the block changed while the update was running.')
      continue
    }
    if (body === block.body.trim()) continue
    outcome.notes.push(`Block ${block.front.label} rewritten.`)
    writes.push({ entryId: block.id, oldText: readOrNull(block.path), newText: blocks.serializeBlock({ ...block.front, updatedAt: now() }, body), path: block.path })
  }

  for (const flag of proposals.flags) {
    inbox(wiki, flag.kind === 'contradiction' ? 'blocked' : 'unresolved', `Flagged claim: ${takeChars(flag.claim, 120)}`, `${flag.reason} (${flag.kind})`, [])
    outcome.flagged += 1
  }

  if (!writes.length) {
    store.log(wiki, `- ${now()} · ${actor} · ${described} · nothing changed · ${outcome.parked} parked · ${outcome.flagged} flagged`)
    return outcome
  }

  // Apply everything or nothing: on any failure, restore what was already written.
  writes.forEach((write, index) => {
    try {
      atomicWrite(write.path, write.newText)
    } catch (error) {
      for (const done of writes.slice(0, index)) {
        try {
          if (done.oldText === null) rmSync(done.path, { force: true })
          else atomicWrite(done.path, done.oldText)
        } catch {
          // Best effort: the original failure is what the caller needs to see.
        }
      }
      throw error
    }
  })

  const operationId = newId()
  const short = operationId.slice(0, 8)
  const pages: OperationPage[] = writes.map((write) => ({
    pageId: write.entryId,
    path: write.path,
    beforeRevisionId: write.oldText === null ? null : store.snapshot(wiki, write.entryId, write.oldText, actor, `Before update ${short}`).id,
    afterRevisionId: store.snapshot(wiki, write.entryId, write.newText, actor, `Update ${short} (${described})`).id
  }))
  const operation: Operation = { id: operationId, createdAt: now(), trigger: described, pages, undone: false }
  writeJson(join(operationsDir(wiki), `${operationId}.json`), operation)
  for (const write of writes) noteChange({ wiki, id: write.entryId, path: write.path, text: write.newText, actor, reason: described })
  writeIndex(wiki)
  store.log(
    wiki,
    `- ${now()} · ${actor} · ${described} · entries ${pages.map((page) => `\`${page.pageId}\``).join(', ')} · revisions ${pages.map((page) => `\`${page.afterRevisionId.slice(0, 8)}\``).join(', ')} · op \`${operationId}\` · ${outcome.parked} parked · ${outcome.flagged} flagged`
  )
  inbox(
    wiki,
    'applied',
    `Updated ${pages.length} entr${pages.length === 1 ? 'y' : 'ies'}`,
    `From ${described}. Undo restores the previous content as new revisions.`,
    pages.map((page) => page.pageId),
    operationId
  )
  outcome.operation = operation
  return outcome
}

// ---- Registry proposals (skills, prompts, rules) -------------------------------------------

export const registryProposalSchema = z.object({
  /** `skill`, `prompt`, or `rule`. */
  kind: z.string(),
  name: z.string(),
  description: z.string().default(''),
  body: z.string(),
  reason: z.string().default('')
})
export type RegistryProposal = z.infer<typeof registryProposalSchema>

/**
 * Skills, prompts, and rules change how every agent behaves, so proposals never apply on
 * their own: they wait in the Inbox until the user accepts them.
 */
export function parkRegistryProposal(wiki: string, trigger: Trigger, proposal: RegistryProposal): string {
  if (!['skill', 'prompt', 'rule'].includes(proposal.kind) || !proposal.name.trim() || !proposal.body.trim()) {
    throw invalid('A skill, prompt, or rule proposal needs a kind, name, and body.')
  }
  if (looksSecret(proposal.body)) throw invalid('The proposal contains text that looks like a credential.')
  const id = `${proposal.kind}s/${store.slug(proposal.name)}`
  inbox(
    wiki,
    'proposed',
    `Proposed ${proposal.kind} "${proposal.name.trim()}"`,
    `${proposal.reason.trim() || 'Review the change before it applies to every agent.'}\n\nFrom ${describeTrigger(trigger)}.`,
    [id],
    null,
    { kind: proposal.kind, proposal, trigger: describeTrigger(trigger) }
  )
  store.log(wiki, `- ${now()} · ${triggerActor(trigger)} · proposed \`${id}\` · waiting in Inbox`)
  return id
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HarnessError('invalid_data', `Stored data could not be read: ${result.error.issues[0]?.message ?? 'invalid proposal'}`)
  return result.data
}

/**
 * Accepts a parked proposal: pages and facts go through `apply` with the user as the
 * authority; registry items are written with a revision before and after.
 */
export function accept(root: string, itemId: string): string {
  const wiki = store.wikiDir(root)
  const path = join(wiki, 'inbox', `${safeId(itemId)}.json`)
  const item = readJson<InboxItem>(path)
  if (!item) throw notFound('Inbox item')
  const payload = item.payload as { kind?: unknown; proposal?: unknown; namespace?: unknown } | undefined | null
  if (!payload) throw invalid('This Inbox item has nothing to accept.')
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  const trigger: Trigger = { kind: 'user', itemId: item.id }
  const userRef: SourceRef = { kind: 'user', ref: 'accepted', excerpt: undefined }
  let message: string
  if (kind === 'page' || kind === 'memory') {
    const set: ProposalSet = { pages: [], memories: [], blocks: [], flags: [] }
    if (kind === 'page') {
      const proposal = parsed(pageProposalSchema, payload.proposal)
      set.pages.push({ ...proposal, sourceRefs: [...proposal.sourceRefs, userRef] })
    } else {
      const proposal = parsed(memoryProposalSchema, payload.proposal)
      set.memories.push({ ...proposal, sourceRefs: [...proposal.sourceRefs, userRef] })
    }
    const namespace = typeof payload.namespace === 'string' ? payload.namespace : store.LIBRARY_NAMESPACE
    const outcome = apply(wiki, namespace, trigger, set, new Map(), {})
    if (!outcome.operation) throw invalid(outcome.notes.join(' '))
    message = outcome.notes.join(' ')
  } else if (kind === 'skill' || kind === 'prompt' || kind === 'rule') {
    const proposal = parsed(registryProposalSchema, payload.proposal)
    message = `Saved ${registry.writeItem(root, proposal.kind, proposal.name, proposal.description, proposal.body, `Accepted ${describeTrigger(trigger)}`)}.`
  } else if (kind === 'plugin') {
    message = acceptPluginProposal(root, parsed(pluginProposalSchema, payload.proposal))
  } else {
    throw invalid('Unknown proposal kind.')
  }
  const target = join(wiki, 'inbox', 'dismissed')
  mkdirSync(target, { recursive: true })
  renameSync(path, join(target, `${item.id}.json`))
  return message
}
