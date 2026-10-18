// The global Wiki. One corpus under `<data root>/wiki/`; skills, prompts, and rules are the
// registry's items (`registry/`), shown and searched as Wiki objects without being copied.
// Projects are path namespaces (`/projects/<slug>/…`), never access boundaries: everything may
// be read, and the current project only makes its namespace more relevant.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { noteChange } from '../core/changes'
import { logLine } from '../core/bus'
import { HarnessError, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, now } from '../core/fs'
import { findProject, projectsOrNone } from '../core/projects'
import { compareText, lines, takeChars } from '../core/text'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import * as facts from './facts'
import * as store from './store'
import { firstParagraph, type ParsedPage, type WikiLink } from './store'
import * as wikiIndex from './wikiIndex'

export interface WikiPageSummary {
  id: string
  title: string
  type: string
  path: string
  namespace: string
  updatedAt: string
  sourceIds: string[]
  links: WikiLink[]
}

export interface WikiPage extends WikiPageSummary {
  body: string
  revisionId: string | null
  file: string
}

export function summary(page: ParsedPage): WikiPageSummary {
  return {
    id: page.frontmatter.id,
    title: page.frontmatter.title,
    type: page.frontmatter.type,
    path: page.location.path,
    namespace: page.location.namespace,
    updatedAt: page.frontmatter.updatedAt,
    sourceIds: page.frontmatter.sourceIds,
    links: page.frontmatter.links
  }
}

// ---- Index feed ----------------------------------------------------------------------

export type EntryKind = 'page' | 'memory' | 'block' | 'skill' | 'rule' | 'prompt'

/** One searchable entry as the index stores it. */
export interface IndexedEntry {
  id: string
  kind: EntryKind
  title: string
  entryType: string
  path: string
  namespace: string
  file: string
  updatedAt: string
  body: string
  sourceIds: string[]
  /** `[to id, link type]`. */
  links: [string, string][]
  /** `[revision id, created at, actor]`. */
  revisions: [string, string, string][]
}

export interface IndexedSource {
  id: string
  name: string
  importedAt: string
  version: number
}

function revisionsOf(wiki: string, id: string): [string, string, string][] {
  try {
    return store.readManifest(wiki, id).map((revision) => [revision.id, revision.createdAt, revision.actor])
  } catch {
    return []
  }
}

/** Registry kind (`skills`) → entry kind (`skill`). */
export function registryEntryKind(kind: string): 'skill' | 'rule' | 'prompt' | null {
  return kind === 'skills' ? 'skill' : kind === 'rules' ? 'rule' : kind === 'prompts' ? 'prompt' : null
}

const linkPairs = (links: readonly WikiLink[]): [string, string][] => links.map((link) => [link.toId, link.type])

/** Everything the index holds: pages, facts, blocks, and registry skills/prompts/rules. */
export function scan(root: string): { entries: IndexedEntry[]; sources: IndexedSource[] } {
  const wiki = store.wikiDir(root)
  const entries: IndexedEntry[] = store.loadPages(wiki).map((page) => ({
    id: page.frontmatter.id,
    kind: 'page',
    title: page.frontmatter.title,
    entryType: page.frontmatter.type,
    path: page.location.path,
    namespace: page.location.namespace,
    file: page.path,
    updatedAt: page.frontmatter.updatedAt,
    body: page.body,
    sourceIds: page.frontmatter.sourceIds,
    links: linkPairs(page.frontmatter.links),
    revisions: revisionsOf(wiki, page.frontmatter.id)
  }))
  for (const memory of facts.loadMemories(wiki)) {
    entries.push({
      id: memory.front.id,
      kind: 'memory',
      title: memory.front.title,
      entryType: memory.front.kind,
      path: `/facts/${memory.front.id}`,
      namespace: memory.front.namespace,
      file: memory.path,
      updatedAt: memory.front.updatedAt,
      body: memory.body,
      sourceIds: memory.front.sourceIds,
      links: linkPairs(memory.front.links),
      revisions: revisionsOf(wiki, memory.front.id)
    })
  }
  for (const block of blocks.loadAll(wiki)) {
    entries.push({
      id: block.id,
      kind: 'block',
      title: block.front.label,
      // The scope (`shared`, `agent`, `project`) decides who may see the block in a search.
      entryType: block.scope,
      path: `/${block.id}`,
      namespace: block.scope === 'project' && block.owner ? `/projects/${block.owner}` : store.ROOT_NAMESPACE,
      file: block.path,
      updatedAt: block.front.updatedAt,
      body: `${block.front.description}\n\n${block.body}`,
      sourceIds: [],
      links: [],
      revisions: revisionsOf(wiki, block.id)
    })
  }
  for (const item of registry.list(root)) {
    const kind = registryEntryKind(item.kind)
    if (!kind) continue
    entries.push({
      id: item.id,
      kind,
      title: item.name,
      entryType: kind,
      path: `/${item.id}`,
      namespace: store.ROOT_NAMESPACE,
      file: item.path,
      updatedAt: '',
      body: `${item.description}\n\n${registry.itemBody(item)}`,
      sourceIds: [],
      links: [],
      revisions: revisionsOf(wiki, item.id)
    })
  }
  const sources = store.listSources(wiki).map((source) => ({ id: source.id, name: source.name, importedAt: source.importedAt, version: source.version }))
  return { entries, sources }
}

export function countPages(root: string): number {
  return store.pageFiles(store.wikiDir(root)).length
}

// ---- Search ---------------------------------------------------------------------------

export interface WikiSearchHit {
  id: string
  kind: string
  title: string
  type: string
  path: string
  namespace: string
  snippet: string
}

export interface SearchOptions {
  kinds?: string[]
  /** Only entries in this namespace (or below it). */
  namespace?: string | null
  /** Ranks this project's namespace higher; never filters. */
  projectId?: string | null
  limit?: number | null
}

export function inNamespace(namespace: string, filter: string | null | undefined): boolean {
  const prefix = filter?.replace(/\/+$/, '')
  return !prefix || namespace === prefix || namespace.startsWith(`${prefix}/`)
}

function snippet(body: string, needle: string): string {
  const line = lines(body).map((entry) => entry.trim()).find((entry) => needle && entry.toLowerCase().includes(needle)) ?? firstParagraph(body)
  return takeChars(line, 240)
}

/** Ranked hits across the whole Wiki. Falls back to scanning files when the index is unavailable. */
export function searchEntries(root: string, query: string, options: SearchOptions = {}): WikiSearchHit[] {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  let boost: string | null = null
  if (options.projectId) {
    try {
      boost = findProject(root, options.projectId).wikiNamespace
    } catch {
      boost = null
    }
  }
  const { entries } = scan(root)
  const kinds = options.kinds ?? []
  let ranked: string[]
  try {
    ranked = wikiIndex.search(root, query, limit * 4, boost)
  } catch (error) {
    logLine(`[index] search fell back to files: ${error instanceof Error ? error.message : String(error)}`)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const rank = (entry: IndexedEntry): number => (entry.namespace === boost ? 0 : 2) + (entry.title.toLowerCase().includes(needle) ? 0 : 1)
    ranked = entries
      .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle))
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => rank(left.entry) - rank(right.entry) || left.index - right.index)
      .map(({ entry }) => entry.id)
  }
  // A volatile fact that has gone stale may no longer be true, so it ranks after everything else.
  const stale = new Set(facts.loadMemories(store.wikiDir(root)).filter((fact) => facts.isStale(fact.front)).map((fact) => fact.front.id))
  ranked = [...ranked.filter((id) => !stale.has(id)), ...ranked.filter((id) => stale.has(id))]
  const needle = (query.split(/\s+/).find(Boolean) ?? '').toLowerCase()
  const hits: WikiSearchHit[] = []
  for (const id of ranked) {
    if (hits.length >= limit) break
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry || (kinds.length && !kinds.includes(entry.kind)) || !inNamespace(entry.namespace, options.namespace)) continue
    hits.push({ id: entry.id, kind: entry.kind, title: entry.title, type: entry.entryType, path: entry.path, namespace: entry.namespace, snippet: snippet(entry.body, needle) })
  }
  return hits
}

// ---- Entries (pages, facts, blocks, registry items) ------------------------------------------

export type EntryFile =
  | { kind: 'page'; page: ParsedPage }
  | { kind: 'memory'; memory: facts.ParsedMemory }
  | { kind: 'block'; block: blocks.Block }
  | { kind: 'registry'; item: registry.RegistryItem }

/** Resolves a page id, fact id, registry id (`skills/<name>`), block id, or Wiki path (`/library/x`). */
export function resolveEntry(root: string, rawKey: string): EntryFile {
  const wiki = store.wikiDir(root)
  const key = rawKey.trim()
  const registryKey = key.replace(/^\/+/, '')
  if (registryKey.startsWith('blocks/')) return { kind: 'block', block: blocks.find(wiki, registryKey) }
  const item = registry.list(root).find((entry) => entry.id === registryKey)
  if (item) return { kind: 'registry', item }
  const factId = key.startsWith('/facts/') ? key.slice('/facts/'.length) : key.startsWith('/memory/') ? key.slice('/memory/'.length) : null
  if (factId !== null) return { kind: 'memory', memory: facts.findMemory(wiki, factId) }
  const page = store.loadPages(wiki).find((entry) => entry.frontmatter.id === key || entry.location.path === key)
  if (page) return { kind: 'page', page }
  try {
    return { kind: 'memory', memory: facts.findMemory(wiki, key) }
  } catch {
    throw notFound('Wiki entry')
  }
}

export function entryId(entry: EntryFile): string {
  return entry.kind === 'page' ? entry.page.frontmatter.id : entry.kind === 'memory' ? entry.memory.front.id : entry.kind === 'block' ? entry.block.id : entry.item.id
}

export function entryFile(entry: EntryFile): string {
  return entry.kind === 'page' ? entry.page.path : entry.kind === 'memory' ? entry.memory.path : entry.kind === 'block' ? entry.block.path : entry.item.path
}

// ---- Reads for a person ------------------------------------------------------------------------

export function listPages(root: string, namespace?: string | null): WikiPageSummary[] {
  return store.loadPages(store.wikiDir(root)).filter((page) => inNamespace(page.location.namespace, namespace)).map(summary)
}

export function loadPage(root: string, pageId: string): WikiPage {
  const wiki = store.wikiDir(root)
  const page = store.loadPages(wiki).find((entry) => entry.frontmatter.id === pageId || entry.location.path === pageId)
  if (!page) throw notFound('Page')
  return { ...summary(page), body: page.body, revisionId: store.currentRevision(wiki, page.frontmatter.id), file: page.path }
}

/** Revisions of an entry, newest first. */
export function listRevisions(root: string, id: string): store.WikiRevision[] {
  return store.readManifest(store.wikiDir(root), id).reverse()
}

/** A revision's body without its frontmatter. */
export function loadRevision(root: string, id: string, revisionId: string): string {
  const text = store.revisionText(store.wikiDir(root), id, revisionId)
  return frontmatter.split(text)?.body ?? text
}

/**
 * Restore never erases history: the current content is snapshotted, then the chosen revision
 * becomes the content and is itself recorded as a new revision. Works for every kind of entry.
 */
export function restore(root: string, id: string, revisionId: string): void {
  const wiki = store.wikiDir(root)
  const entry = resolveEntry(root, id)
  const resolved = entryId(entry)
  const file = entryFile(entry)
  const revisionText = store.revisionText(wiki, resolved, revisionId)
  let nextText = revisionText
  if (entry.kind === 'page') {
    const restored = store.parsePage(revisionText, wiki, entry.page.path)
    if (!restored) throw new HarnessError('invalid_data', 'The revision could not be read as a Wiki page.')
    nextText = store.serializePage({ ...restored.frontmatter, id: entry.page.frontmatter.id, updatedAt: now() }, restored.body)
  } else if (entry.kind === 'memory') {
    if (!facts.parse(revisionText, file)) throw new HarnessError('invalid_data', 'The revision could not be read as a memory.')
  } else if (entry.kind === 'block') {
    const parsed = frontmatter.parse(revisionText)
    if (!parsed || !blocks.parseFront(parsed.front)) throw new HarnessError('invalid_data', 'The revision could not be read as a memory block.')
  }
  let currentText = ''
  try {
    currentText = readFileSync(file, 'utf8')
  } catch {
    currentText = ''
  }
  store.snapshot(wiki, resolved, currentText, 'user', 'Before restore')
  atomicWrite(file, nextText)
  const revision = store.snapshot(wiki, resolved, nextText, 'user', `Restored revision ${revisionId.slice(0, 8)}`)
  noteChange({ wiki, id: resolved, path: file, text: nextText, actor: 'user', reason: 'Restored an earlier revision' })
  store.log(wiki, `- ${now()} · user · restore · \`${resolved}\` · revision \`${revision.id}\``)
}

/** Any entry's content in one shape. */
export interface WikiEntry {
  id: string
  kind: EntryKind
  title: string
  description: string
  body: string
  file: string
  revisionId: string | null
}

export function loadEntry(root: string, id: string): WikiEntry {
  const entry = resolveEntry(root, id)
  const shared = { file: entryFile(entry), revisionId: store.currentRevision(store.wikiDir(root), entryId(entry)) }
  if (entry.kind === 'page') return { id: entry.page.frontmatter.id, kind: 'page', title: entry.page.frontmatter.title, description: firstParagraph(entry.page.body), body: entry.page.body, ...shared }
  if (entry.kind === 'memory') return { id: entry.memory.front.id, kind: 'memory', title: entry.memory.front.title, description: entry.memory.front.kind, body: entry.memory.body, ...shared }
  if (entry.kind === 'block') return { id: entry.block.id, kind: 'block', title: entry.block.front.label, description: entry.block.front.description, body: entry.block.body, ...shared }
  return { id: entry.item.id, kind: registryEntryKind(entry.item.kind) ?? 'skill', title: entry.item.name, description: entry.item.description, body: registry.itemBody(entry.item), ...shared }
}

export interface Backlink {
  fromId: string
  kind: string
  title: string
  type: string
}

/** Entries that link to `id`, from the index's link table (files when it is unavailable). */
export function backlinks(root: string, id: string): Backlink[] {
  const { entries } = scan(root)
  let pairs: [string, string][]
  try {
    pairs = wikiIndex.backlinks(root, id)
  } catch {
    pairs = entries.flatMap((entry) => entry.links.filter(([to]) => to === id).map(([, type]): [string, string] => [entry.id, type]))
  }
  return pairs.flatMap(([from, type]) => {
    const entry = entries.find((candidate) => candidate.id === from)
    return entry ? [{ fromId: from, kind: entry.kind, title: entry.title, type }] : []
  })
}

export interface WikiNamespace {
  namespace: string
  label: string
  projectId: string | null
  pageCount: number
  memoryCount: number
}

/** Project namespaces (registered projects first, then folders left by removed projects). */
export function namespaces(root: string): WikiNamespace[] {
  const wiki = store.wikiDir(root)
  const pages = store.loadPages(wiki)
  const memories = facts.loadMemories(wiki)
  const counts = (namespace: string) => ({
    pageCount: pages.filter((page) => page.location.namespace === namespace).length,
    memoryCount: memories.filter((memory) => memory.front.namespace === namespace).length
  })
  const seen = new Set<string>()
  const result: WikiNamespace[] = []
  for (const project of projectsOrNone(root)) {
    seen.add(project.wikiNamespace)
    result.push({ namespace: project.wikiNamespace, label: project.name, projectId: project.id, ...counts(project.wikiNamespace) })
  }
  let folders: string[] = []
  try {
    folders = readdirSync(join(wiki, 'projects')).filter((name) => store.isDir(join(wiki, 'projects', name)))
  } catch {
    folders = []
  }
  for (const namespace of folders.map((name) => `/projects/${name}`).sort(compareText)) {
    if (!seen.has(namespace)) result.push({ namespace, label: namespace.slice('/projects/'.length), projectId: null, ...counts(namespace) })
  }
  return result
}

/** The newest 500 entries of `log.md`, newest first. */
export function recentLog(root: string): string[] {
  let text = ''
  try {
    text = readFileSync(join(store.wikiDir(root), 'log.md'), 'utf8')
  } catch {
    text = ''
  }
  return lines(text).filter((line) => line.startsWith('- ')).map((line) => line.slice(2)).reverse().slice(0, 500)
}
