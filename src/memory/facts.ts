// Facts: short, typed things to carry between runs (a preference, a decision). Each is a file,
// `wiki/facts/<id>.md`, with frontmatter and a few lines of body, has sources and revisions like
// a page, and changes only through the user or a validated proposal.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, now, safeId } from '../core/fs'
import { comparePaths } from '../core/text'
import { looksSecret } from './secrets'
import * as store from './store'
import { LIBRARY_NAMESPACE, ROOT_NAMESPACE, type WikiLink } from './store'

/** A procedure is a skill, not a fact. */
export const MEMORY_KINDS = ['preference', 'fact', 'decision', 'feedback'] as const
/** A volatile fact older than this loses rank in search and is reported by Health. */
export const STALE_DAYS = 30
export const CONFIDENCE = ['high', 'medium', 'low'] as const
export const STATUSES = ['active', 'superseded', 'archived'] as const
/** A fact is short, not a document. Measured in bytes. */
export const MAX_BODY = 2000

export interface MemoryFront {
  id: string
  title: string
  kind: string
  /** `/` for everything, or a project namespace such as `/projects/agent-x`. */
  namespace: string
  sourceIds: string[]
  confidence: string
  status: string
  supersedes: string | null
  links: WikiLink[]
  createdAt: string
  updatedAt: string
  /** When the fact was observed to be true. */
  observedAt: string
  /** Current state that will change. Never put in a compiled prompt; loses rank as it ages. */
  volatile: boolean
}

export interface ParsedMemory {
  front: MemoryFront
  body: string
  path: string
}

/** Days since the fact was observed (or last updated), when that can be read. */
export function ageDays(front: MemoryFront): number | null {
  const at = Date.parse(front.observedAt || front.updatedAt)
  return Number.isNaN(at) ? null : Math.trunc((Date.now() - at) / 86_400_000)
}

export function isStale(front: MemoryFront): boolean {
  const days = ageDays(front)
  return front.volatile && front.status === 'active' && days !== null && days >= STALE_DAYS
}

export function memoryDir(wiki: string): string {
  return join(wiki, 'facts')
}

/** The reason a fact is not valid, or `null`. */
export function validate(front: MemoryFront, body: string): string | null {
  try {
    safeId(front.id)
  } catch {
    return 'The memory id must be letters, numbers, - or _.'
  }
  if (!front.title.trim() || !body.trim()) return 'A memory needs a title and a body.'
  if (Buffer.byteLength(body) > MAX_BODY) return `A memory is a short fact; keep the body under ${MAX_BODY} characters and put longer material in a Wiki page.`
  if (!(MEMORY_KINDS as readonly string[]).includes(front.kind)) return `Memory kind must be one of ${MEMORY_KINDS.join(', ')}.`
  if (!(CONFIDENCE as readonly string[]).includes(front.confidence) || !(STATUSES as readonly string[]).includes(front.status)) return 'Unknown confidence or status.'
  if (front.namespace !== ROOT_NAMESPACE && store.projectNamespaceOf(front.namespace) !== front.namespace && front.namespace !== LIBRARY_NAMESPACE) {
    return "A memory's namespace is / or a project namespace (/projects/<slug>)."
  }
  return null
}

const optionalText = (value: unknown, fallback: string): string | null => (value === undefined ? fallback : typeof value === 'string' ? value : null)

export function parse(text: string, path: string): ParsedMemory | null {
  const parsed = frontmatter.parse(text)
  if (!parsed) return null
  const { id, title, kind, supersedes, volatile } = parsed.front
  if (typeof id !== 'string' || typeof title !== 'string' || typeof kind !== 'string') return null
  const namespace = optionalText(parsed.front.namespace, ROOT_NAMESPACE)
  const confidence = optionalText(parsed.front.confidence, 'medium')
  const status = optionalText(parsed.front.status, 'active')
  const createdAt = optionalText(parsed.front.createdAt, '')
  const updatedAt = optionalText(parsed.front.updatedAt, '')
  const observedAt = optionalText(parsed.front.observedAt, '')
  const sourceIds = store.stringList(parsed.front.sourceIds)
  const links = store.linkList(parsed.front.links, id)
  if (namespace === null || confidence === null || status === null || createdAt === null || updatedAt === null || observedAt === null || !sourceIds || !links) return null
  if (supersedes !== undefined && supersedes !== null && typeof supersedes !== 'string') return null
  if (volatile !== undefined && typeof volatile !== 'boolean') return null
  return {
    front: {
      id,
      title,
      // Historical procedures read as facts without rewriting files or creating registry skills.
      kind: kind === 'procedure' ? 'fact' : kind,
      namespace,
      sourceIds,
      confidence,
      status,
      supersedes: supersedes ?? null,
      links,
      createdAt,
      updatedAt,
      observedAt,
      volatile: volatile ?? false
    },
    body: parsed.body,
    path
  }
}

export function loadMemories(wiki: string): ParsedMemory[] {
  const files: string[] = []
  store.markdownFiles(memoryDir(wiki), files)
  const memories: ParsedMemory[] = []
  for (const path of files.sort(comparePaths)) {
    try {
      const memory = parse(readFileSync(path, 'utf8'), path)
      if (memory) memories.push(memory)
    } catch {
      // An unreadable file is not a fact.
    }
  }
  return memories
}

export function findMemory(wiki: string, id: string): ParsedMemory {
  const memory = loadMemories(wiki).find((entry) => entry.front.id === id)
  if (!memory) throw notFound('Memory')
  return memory
}

export function serialize(front: MemoryFront, body: string): string {
  return frontmatter.serialize(
    {
      id: front.id,
      title: front.title,
      kind: front.kind,
      namespace: front.namespace,
      sourceIds: front.sourceIds,
      confidence: front.confidence,
      status: front.status,
      ...(front.supersedes === null ? {} : { supersedes: front.supersedes }),
      links: front.links,
      createdAt: front.createdAt,
      updatedAt: front.updatedAt,
      observedAt: front.observedAt,
      ...(front.volatile ? { volatile: true } : {})
    },
    body
  )
}

export function pathFor(wiki: string, id: string): string {
  return join(memoryDir(wiki), `${safeId(id)}.md`)
}

/**
 * Facts that apply in a project namespace (or everywhere): active ones in `/`, `/library`,
 * or that namespace. Others stay retrievable by search.
 */
export function appliesTo(front: MemoryFront, projectNamespace: string | null): boolean {
  return front.status === 'active' && (front.namespace === ROOT_NAMESPACE || front.namespace === LIBRARY_NAMESPACE || front.namespace === projectNamespace)
}

export type WikiMemory = Omit<MemoryFront, 'supersedes' | 'volatile'> & { supersedes?: string; volatile?: true; body: string; path: string; revisionId: string | null }

export function response(wiki: string, memory: ParsedMemory): WikiMemory {
  const { supersedes, volatile, ...front } = memory.front
  return {
    ...front,
    ...(supersedes === null ? {} : { supersedes }),
    ...(volatile ? { volatile: true as const } : {}),
    body: memory.body,
    path: memory.path,
    revisionId: store.currentRevision(wiki, memory.front.id)
  }
}

export interface MemoryInput {
  id?: string | null
  title: string
  kind: string
  namespace?: string
  body: string
  confidence?: string
  status?: string
  supersedes?: string | null
  volatile?: boolean
}

/** A user's create or edit. Writes a revision before and after, like every other change. */
export function saveAsUser(wiki: string, input: MemoryInput): WikiMemory {
  const id = input.id ?? store.slug(input.title)
  let existing: ParsedMemory | null = null
  try {
    existing = findMemory(wiki, id)
  } catch {
    existing = null
  }
  const sourceIds = existing ? [...existing.front.sourceIds] : []
  if (!sourceIds.length) sourceIds.push('user')
  const front: MemoryFront = {
    id,
    title: input.title.trim(),
    kind: input.kind,
    namespace: (input.namespace ?? ROOT_NAMESPACE).trim(),
    sourceIds,
    confidence: input.confidence ?? 'medium',
    status: input.status ?? 'active',
    supersedes: input.supersedes || null,
    links: existing ? existing.front.links : [],
    createdAt: existing?.front.createdAt || now(),
    updatedAt: now(),
    // Saving a fact again says it is still true now.
    observedAt: now(),
    volatile: input.volatile ?? false
  }
  const problem = validate(front, input.body)
  if (problem) throw invalid(problem)
  if (looksSecret(input.body)) throw invalid('The memory contains text that looks like a credential.')
  const path = existing?.path ?? pathFor(wiki, id)
  if (existing) {
    let before: string
    try {
      before = readFileSync(existing.path, 'utf8')
    } catch (error) {
      throw new HarnessError('io_error', error instanceof Error ? error.message : String(error))
    }
    store.snapshot(wiki, id, before, 'user', 'Before edit')
  }
  const text = serialize(front, input.body)
  atomicWrite(path, text)
  store.snapshot(wiki, id, text, 'user', existing ? 'Edited' : 'Created')
  store.log(wiki, `- ${now()} · user · memory · \`${id}\` ${existing ? 'edited' : 'created'}`)
  return response(wiki, findMemory(wiki, id))
}
