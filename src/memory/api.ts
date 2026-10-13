// The Wiki as a model sees it: search, read, list, skills, facts, proposals, and memory-block
// edits. Results are plain text with `[id@revision]` citations, and every entry a run reads is
// recorded in `runs/<id>/wiki-context.json`.
import { dirname } from 'node:path'

import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid, notFound } from '../core/errors'
import { charCount } from '../core/text'
import { applicableMemories, clip } from '../prompt/compile'
import { findRun, readEvents } from '../sessions/runStore'
import type { RunEvent } from '../sessions/contracts'
import { takeChars } from '../core/text'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import { actorOf, blockCaller, projectOf, type CallerContext } from './caller'
import * as facts from './facts'
import { apply, captureHashes, parkRegistryProposal, parseProposalSet, type Trigger } from './proposals'
import * as references from './references'
import { cite, record, recordSources } from './runContext'
import * as store from './store'
import { backlinks, entryId, namespaces, registryEntryKind, resolveEntry, searchEntries } from './wiki'

const READ_LIMIT = 20_000

export type Params = Record<string, unknown> | null | undefined

function textParam(params: Params, key: string): string {
  const value = params?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

const rawParam = (params: Params, key: string): string => (typeof params?.[key] === 'string' ? (params[key] as string) : '')
const countParam = (params: Params, key: string): number | null => {
  const value = params?.[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

// ---- Run evidence -------------------------------------------------------------------------------

function transcriptText(goal: string, events: readonly RunEvent[]): string {
  let text = `User: ${goal}\n`
  for (const event of events) {
    const payload = event.payload as { role?: unknown; text?: unknown; name?: unknown; summary?: unknown }
    if (event.type === 'message.completed' && payload.role === 'assistant') text += `Assistant: ${typeof payload.text === 'string' ? payload.text : ''}\n`
    else if (event.type === 'tool.started') text += `Tool ${typeof payload.name === 'string' ? payload.name : 'tool'}: ${typeof payload.summary === 'string' ? payload.summary : ''}\n`
  }
  return text
}

/** What a consolidation job reads of a run, capped. */
export function transcript(goal: string, events: readonly RunEvent[]): string {
  return takeChars(transcriptText(goal, events), 24_000)
}

/** Everything recorded of a run, uncapped: what an excerpt is checked against. */
export function evidenceText(root: string, runId: string): string {
  let events: RunEvent[] = []
  try {
    events = readEvents(root, runId)
  } catch {
    events = []
  }
  return transcriptText(findRun(root, runId)?.goal ?? '', events)
}

// ---- Memory blocks -----------------------------------------------------------------------

/** `memory.append`, `memory.replace`, and `memory.rethink`. */
export function memoryEdit(env: HarnessEnv, context: CallerContext, call: string, params: Params): string {
  const caller = blockCaller(env, context)
  const label = textParam(params, 'block')
  if (!label) throw invalid('Name the block to edit, such as user, persona, or notes.')
  let edit: blocks.Edit
  if (call === 'memory.append') edit = { kind: 'append', text: rawParam(params, 'text') }
  else if (call === 'memory.replace') edit = { kind: 'replace', old: rawParam(params, 'old'), new: rawParam(params, 'new') }
  else if (call === 'memory.rethink') edit = { kind: 'rethink', text: rawParam(params, 'body') }
  else throw new HarnessError('unknown_method', `Unknown memory call ${call}.`)
  const block = blocks.edit(env.root, caller, label, edit)
  record(env.root, context, 'edit', [[block.id, 'block']])
  return `Updated the ${block.front.label} block (${charCount(block.body)} of ${block.front.limit} characters). It is in your context from the next turn.`
}

// ---- Retrieval ------------------------------------------------------------------------------

function ownBlocksPrefix(env: HarnessEnv, context: CallerContext): string | null {
  try {
    const caller = blockCaller(env, context)
    return caller.kind === 'agent' ? `blocks/agents/${caller.id}/` : null
  } catch {
    return null
  }
}

/** A fact is stored and indexed under the kind `memory`. A model says `fact`; `memory` is still understood. */
const storedKind = (kind: string): string => (kind === 'fact' ? 'memory' : kind)
const shownKind = (kind: string): string => (kind === 'memory' ? 'fact' : kind)

export function search(env: HarnessEnv, context: CallerContext, params: Params): string {
  const { root } = env
  const query = textParam(params, 'query')
  if (!query) return 'Give a query.'
  const kinds = (Array.isArray(params?.kinds) ? params.kinds.filter((kind): kind is string => typeof kind === 'string') : []).map(storedKind)
  const limit = countParam(params, 'limit') ?? 8
  // Another agent's blocks never appear; a block of the caller's own does.
  const own = ownBlocksPrefix(env, context)
  const hits = searchEntries(root, query, { kinds, namespace: textParam(params, 'namespace') || null, projectId: context.projectId, limit: limit + 6 })
    .filter((hit) => !(hit.kind === 'block' && hit.type === 'agent') || (own !== null && hit.id.startsWith(own)))
    .slice(0, limit)
  if (!hits.length) return 'No matching Wiki entries.'
  const wiki = store.wikiDir(root)
  record(root, context, 'search', hits.map((hit) => [hit.id, hit.kind]))
  return `${hits.map((hit, index) => `${index + 1}. [${shownKind(hit.kind)}] ${hit.title} — ${hit.path} ${cite(wiki, hit.id)}\n   ${hit.snippet}`).join('\n')}\n\nRead an entry with wiki_read and its id or path.`
}

export function read(env: HarnessEnv, context: CallerContext, params: Params): string {
  const { root } = env
  const key = textParam(params, 'id') || textParam(params, 'path') || textParam(params, 'idOrPath')
  if (!key) throw invalid('Give an id or Wiki path.')
  if (typeof params?.revision === 'string') {
    const text = references.readPinned(root, context.runId, key, params.revision, countParam(params, 'offset') ?? 0)
    recordSources(root, context, 'read', [{ id: key, kind: key.startsWith('skills/') ? 'skill' : 'page', revision: params.revision }])
    return text
  }
  const wiki = store.wikiDir(root)
  const entry = resolveEntry(root, key)
  // An agent's own blocks are not readable by other agents or by sessions.
  if (entry.kind === 'block' && entry.block.scope === 'agent') {
    const own = ownBlocksPrefix(env, context)
    if (own === null || `blocks/agents/${entry.block.owner}/` !== own) throw notFound('Wiki entry')
  }
  const linking = backlinks(root, entryId(entry))
  const linked = linking.length ? linking.map((link) => `${link.fromId} (${link.type})`).join(', ') : 'none'
  let kind: string
  let text: string
  if (entry.kind === 'page') {
    const { frontmatter: front, location, body } = entry.page
    kind = 'page'
    text = `# ${front.title} ${cite(wiki, front.id)}\nPath: ${location.path} · namespace ${location.namespace} · type ${front.type} · updated ${front.updatedAt}\nSources: ${front.sourceIds.length ? front.sourceIds.join(', ') : 'none (unresolved)'}\nLinks: ${front.links.length ? front.links.map((link) => `${link.type} ${link.toId}`).join(', ') : 'none'}\nBacklinks: ${linked}\n\n${clip(body, READ_LIMIT)}`
  } else if (entry.kind === 'memory') {
    const { front, body } = entry.memory
    kind = 'memory'
    text = `# ${front.title} ${cite(wiki, front.id)}\nFact · ${front.kind} · namespace ${front.namespace} · ${front.confidence} confidence · ${front.status}${front.supersedes ? ` · supersedes ${front.supersedes}` : ''}\nSources: ${front.sourceIds.length ? front.sourceIds.join(', ') : 'none'}\nBacklinks: ${linked}\n\n${body}`
  } else if (entry.kind === 'block') {
    const { block } = entry
    kind = 'block'
    text = `# ${block.front.label} ${cite(wiki, block.id)}\nMemory block · ${block.scope} · ${charCount(block.body)} of ${block.front.limit} characters\n${block.front.description}\n\n${block.body}`
  } else {
    const { item } = entry
    kind = registryEntryKind(item.kind) ?? 'skill'
    text = `# ${item.name} ${cite(wiki, item.id)}\nRegistry ${item.id} · file ${item.path}\nBacklinks: ${linked}\n\n${clip(registry.itemBody(item), READ_LIMIT)}`
  }
  record(root, context, 'read', [[entryId(entry), kind]])
  return text
}

export function list(env: HarnessEnv, params: Params): string {
  const { root } = env
  const namespace = textParam(params, 'namespace')
  const kind = storedKind(textParam(params, 'kind'))
  const wiki = store.wikiDir(root)
  if (kind === 'memory') {
    const memories = facts.loadMemories(wiki)
    if (!memories.length) return 'No facts yet.'
    return memories
      .filter((memory) => !namespace || memory.front.namespace === namespace)
      .map((memory) => `- ${memory.front.title} (${memory.front.id}) [${memory.front.kind}] ${memory.front.namespace} · ${memory.front.status}`)
      .join('\n')
  }
  if (kind === 'skill' || kind === 'rule' || kind === 'prompt') {
    const plural = `${kind}s`
    const items = registry.list(root).filter((item) => item.kind === plural).map((item) => `- ${item.name} (${item.id}) — ${item.description}`)
    return items.length ? items.join('\n') : `No ${plural} yet.`
  }
  let text = ''
  if (!namespace) text += `Namespaces: / (Home), /library${namespaces(root).map((entry) => `, ${entry.namespace}`).join('')}\n\n`
  const prefix = `${namespace.replace(/\/+$/, '')}/`
  const pages = store
    .loadPages(wiki)
    .filter((page) => !namespace || page.location.namespace === namespace || page.location.path.startsWith(prefix))
    .slice(0, 200)
    .map((page) => `- ${page.location.path} — ${page.frontmatter.title} (${page.frontmatter.type}) [${page.frontmatter.id}]`)
  return text + (pages.length ? pages.join('\n') : 'No pages here.')
}

/** One skill's instructions by name or id, or the skills index when no name is given. */
export function skill(env: HarnessEnv, context: CallerContext, params: Params, contributions?: readonly string[]): string {
  const { root } = env
  const name = textParam(params, 'name').toLowerCase()
  const items = registry.limitToContributions(registry.list(root).filter((item) => item.kind === 'skills'), contributions)
  if (!name) {
    if (!items.length) return 'No skills yet.'
    const active = (contributions === undefined
      ? registry.enabledFor(root, context.projectId ?? null, context.agentId ?? null)
      : items).map((item) => item.id)
    return items.map((item) => `- ${item.name} (${item.id})${active.includes(item.id) ? ' · active' : ''} — ${item.description}`).join('\n')
  }
  const found = items.find((item) => item.id.toLowerCase() === name || item.id.replace(/^skills\//, '').toLowerCase() === name || item.name.toLowerCase() === name)
  if (!found) return `There is no skill called "${name}". Call skill_load without a name to list them.`
  record(root, context, 'skill', [[found.id, 'skill']])
  const folder = found.path.endsWith('SKILL.md') ? `\nSupporting files are in ${dirname(found.path)}.` : ''
  return `# ${found.name} ${cite(store.wikiDir(root), found.id)}\n${found.description}${folder}\n\n${clip(registry.itemBody(found), READ_LIMIT)}`
}

/** ", volatile, observed 12 days ago" for a fact that describes current state. */
export function volatileNote(front: facts.MemoryFront): string {
  if (!front.volatile) return ''
  const days = facts.ageDays(front)
  return days === null ? ', volatile' : `, volatile, observed ${days} day${days === 1 ? '' : 's'} ago`
}

export function memories(env: HarnessEnv, context: CallerContext, params: Params): string {
  const { root } = env
  const wiki = store.wikiDir(root)
  const query = textParam(params, 'query')
  const namespace = textParam(params, 'namespace')
  let selected: facts.ParsedMemory[]
  if (!query) {
    selected = applicableMemories(wiki, namespace || (projectOf(root, context)?.wikiNamespace ?? null))
  } else {
    selected = searchEntries(root, query, { kinds: ['memory'], namespace: namespace || null, projectId: context.projectId, limit: 20 }).flatMap((hit) => {
      try {
        return [facts.findMemory(wiki, hit.id)]
      } catch {
        return []
      }
    })
  }
  if (!selected.length) return 'No facts match.'
  const shown = selected.slice(0, 30)
  record(root, context, 'memory', shown.map((memory) => [memory.front.id, 'memory']))
  return shown
    .map((memory) => `- [${memory.front.kind}] ${memory.front.title} ${cite(wiki, memory.front.id)} (${memory.front.namespace}, ${memory.front.confidence} confidence${memory.front.status === 'active' ? '' : `, ${memory.front.status}`}${volatileNote(memory.front)})\n  ${memory.body.trim().replaceAll('\n', '\n  ')}`)
    .join('\n')
}

// ---- Proposals -------------------------------------------------------------------------------

function sourceRefs(params: Params, context: CallerContext): { kind: string; ref: string; excerpt?: string }[] {
  if (!Array.isArray(params?.sourceRefs)) return []
  return params.sourceRefs.flatMap((reference: { kind?: unknown; ref?: unknown; excerpt?: unknown } | null) => {
    if (!reference || typeof reference.kind !== 'string') return []
    const given = typeof reference.ref === 'string' ? reference.ref : ''
    // "current" (or nothing) names the caller's own run.
    const own = reference.kind === 'run' && (!given || given === 'current')
    if (own && !context.runId) return []
    return [{ kind: reference.kind, ref: own ? context.runId! : given, ...(typeof reference.excerpt === 'string' ? { excerpt: reference.excerpt } : {}) }]
  })
}

/** A `links` argument: usable only when every entry names a target and a type. */
function links(params: Params): { toId: string; type: string }[] {
  const given = params?.links
  if (!Array.isArray(given) || !given.every((link) => link && typeof link.toId === 'string' && typeof link.type === 'string')) return []
  return given.map((link: { toId: string; type: string }) => ({ toId: link.toId, type: link.type }))
}

const optional = (params: Params, key: string): string | null => textParam(params, key) || null

/** Validates and applies (or parks) one proposal. */
export function propose(env: HarnessEnv, context: CallerContext, params: Params): string {
  const { root } = env
  const wiki = store.wikiDir(root)
  const kind = storedKind(textParam(params, 'kind'))
  const trigger: Trigger = { kind: 'agent', runId: context.runId ?? null, actor: actorOf(context) }
  const defaultNamespace = projectOf(root, context)?.wikiNamespace ?? store.LIBRARY_NAMESPACE
  const title = textParam(params, 'title')
  const body = rawParam(params, 'body')
  let proposals: unknown
  if (kind === 'page') {
    proposals = { pages: [{ id: optional(params, 'id'), title, type: optional(params, 'type') ?? 'concept', body, namespace: optional(params, 'namespace'), confidence: optional(params, 'confidence'), sourceRefs: sourceRefs(params, context), links: links(params) }] }
  } else if (kind === 'memory') {
    proposals = {
      memories: [{ id: optional(params, 'id'), title, kind: optional(params, 'type') ?? 'fact', body, namespace: optional(params, 'namespace'), confidence: optional(params, 'confidence'), supersedes: optional(params, 'supersedes'), volatile: typeof params?.volatile === 'boolean' ? params.volatile : null, sourceRefs: sourceRefs(params, context), links: links(params) }]
    }
  } else if (kind === 'skill' || kind === 'rule' || kind === 'prompt') {
    const id = parkRegistryProposal(wiki, trigger, { kind, name: optional(params, 'id') ?? title, description: textParam(params, 'description'), body, reason: textParam(params, 'reason') })
    return `The ${kind} change (${id}) is waiting in the Wiki Inbox. Skills, prompts, and rules change only after the user accepts them.`
  } else {
    throw invalid('kind must be page, fact, skill, rule, or prompt.')
  }
  // The caller's own run is evidence only for what it can quote from it.
  const outcome = apply(wiki, defaultNamespace, trigger, parseProposalSet(proposals), captureHashes(wiki), { runText: context.runId ? evidenceText(root, context.runId) : null })
  let text = outcome.notes.join('\n')
  if (outcome.operation) {
    text += `\nApplied as operation ${outcome.operation.id.slice(0, 8)}; the user can undo it from the Wiki Inbox.`
    record(root, context, 'edit', outcome.operation.pages.map((page) => [page.pageId, kind]))
  }
  return text
}
