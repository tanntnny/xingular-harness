// Health checks over the whole Wiki. They report problems with a route to the affected
// entries and never delete anything.
import { charCount } from '../core/text'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import * as facts from './facts'
import { lastOperationAt } from './operations'
import * as store from './store'

export interface HealthReport {
  brokenLinks: { pageId: string; targetId: string }[]
  orphanPages: string[]
  missingEvidence: string[]
  contradictions: { fromId: string; toId: string }[]
  duplicateIds: string[]
  /** Volatile facts that have not been observed for a while and may no longer be true. */
  staleFacts: string[]
  /** Groups of pages whose titles differ only by a run id, a number, or punctuation. */
  similarTitles: string[][]
  /** Memory blocks at 90% of their limit or more. */
  fullBlocks: string[]
  lastMaintenanceAt: string | null
}

const IGNORED_WORDS = new Set(['the', 'a', 'an', 'in', 'of', 'run'])

/** A title without the parts that make near-duplicates look different: case, punctuation, numbers, and id-like words. */
function titleKey(title: string): string {
  return title.toLowerCase().split(/[^\p{Alphabetic}\p{N}]+/u).filter((word) => word && !/[0-9]/.test(word) && !IGNORED_WORDS.has(word)).join(' ')
}

export function check(root: string): HealthReport {
  const wiki = store.wikiDir(root)
  const pages = store.loadPages(wiki)
  const memories = facts.loadMemories(wiki)
  const sourceIds = new Set(store.listSources(wiki).map((source) => source.id))
  const registryIds = registry.list(root).map((item) => item.id)

  // Every page and fact; `standalone` ones need neither links nor sources.
  const entries = [
    ...pages.map((page) => ({ id: page.frontmatter.id, links: page.frontmatter.links, sources: page.frontmatter.sourceIds, standalone: page.frontmatter.id === 'home' || page.frontmatter.type === 'project' || store.isSkeleton(page.location) })),
    ...memories.map((memory) => ({ id: memory.front.id, links: memory.front.links, sources: memory.front.sourceIds, standalone: true }))
  ]
  const seen = new Set<string>()
  const duplicateIds = entries.filter((entry) => seen.size === seen.add(entry.id).size).map((entry) => entry.id)
  const known = new Set([...entries.map((entry) => entry.id), ...sourceIds, ...registryIds])
  const linked = new Set(entries.flatMap((entry) => entry.links.map((link) => link.toId)))
  const validEvidence = (id: string): boolean => sourceIds.has(id) || store.isExternalEvidence(id)

  // Pages in one namespace whose titles reduce to the same key, in namespace then key order.
  const groups = new Map<string, { namespace: string; key: string; ids: string[] }>()
  for (const page of pages) {
    if (store.isSkeleton(page.location) || page.frontmatter.type === 'project') continue
    const key = titleKey(page.frontmatter.title)
    if (!key) continue
    const name = `${page.location.namespace}\u0000${key}`
    if (!groups.has(name)) groups.set(name, { namespace: page.location.namespace, key, ids: [] })
    groups.get(name)!.ids.push(page.frontmatter.id)
  }
  const ordered = [...groups.values()].sort((left, right) => (left.namespace === right.namespace ? (left.key < right.key ? -1 : left.key > right.key ? 1 : 0) : left.namespace < right.namespace ? -1 : 1))

  return {
    brokenLinks: entries.flatMap((entry) => entry.links.filter((link) => !known.has(link.toId)).map((link) => ({ pageId: entry.id, targetId: link.toId }))),
    // Home, project overviews, and facts stand on their own; other pages should be linked.
    orphanPages: entries.filter((entry) => !entry.standalone && !entry.links.length && !linked.has(entry.id)).map((entry) => entry.id),
    missingEvidence: entries.filter((entry) => (!entry.standalone && !entry.sources.length) || entry.sources.some((id) => !validEvidence(id))).map((entry) => entry.id),
    contradictions: entries.flatMap((entry) => entry.links.filter((link) => link.type === 'contradicts').map((link) => ({ fromId: entry.id, toId: link.toId }))),
    duplicateIds,
    staleFacts: memories.filter((memory) => facts.isStale(memory.front)).map((memory) => memory.front.id),
    similarTitles: ordered.filter((group) => group.ids.length > 1).map((group) => group.ids),
    fullBlocks: blocks.loadAll(wiki).filter((block) => block.front.limit > 0 && charCount(block.body) * 100 >= block.front.limit * 90).map((block) => block.id),
    lastMaintenanceAt: lastOperationAt(wiki)
  }
}
