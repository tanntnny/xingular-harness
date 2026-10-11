// One graph of the Wiki: pages, facts, memory blocks, registry skills/prompts/rules, and sources
// as nodes; frontmatter links, citations, and namespace membership as edges.
import type { HarnessEnv } from '../core/env'
import { charCount } from '../core/text'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import * as facts from './facts'
import * as store from './store'
import { registryEntryKind } from './wiki'

export interface GraphNode {
  id: string
  label: string
  type: 'project' | 'page' | 'memory' | 'skill' | 'prompt' | 'rule' | 'block' | 'source'
  pageType: string | null
  namespace: string
  summary: string
  status: 'unresolved' | 'established' | 'stale'
  provenance: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
  evidence: string | null
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const statusOf = (sourceIds: readonly string[]): 'unresolved' | 'established' => (sourceIds.length ? 'established' : 'unresolved')

export function build(env: HarnessEnv): GraphResponse {
  const wiki = store.wikiDir(env.root)
  const pages = store.loadPages(wiki)
  const memories = facts.loadMemories(wiki)
  const nodes: GraphNode[] = pages.map((page) => ({
    id: page.frontmatter.id,
    label: page.frontmatter.title,
    type: page.frontmatter.type === 'project' ? 'project' : 'page',
    pageType: page.frontmatter.type,
    namespace: page.location.namespace,
    summary: store.firstParagraph(page.body),
    status: statusOf(page.frontmatter.sourceIds),
    provenance: `Wiki page ${page.location.path} · ${page.frontmatter.sourceIds.length} source(s)`
  }))
  for (const memory of memories) {
    nodes.push({
      id: memory.front.id,
      label: memory.front.title,
      type: 'memory',
      pageType: memory.front.kind,
      namespace: memory.front.namespace,
      summary: store.firstParagraph(memory.body),
      status: memory.front.status !== 'active' ? 'stale' : statusOf(memory.front.sourceIds),
      provenance: `Memory · ${memory.front.confidence} confidence · ${memory.front.sourceIds.length} source(s)`
    })
  }
  for (const item of registry.list(env.root)) {
    const type = registryEntryKind(item.kind)
    if (type) nodes.push({ id: item.id, label: item.name, type, pageType: null, namespace: store.ROOT_NAMESPACE, summary: item.description, status: 'established', provenance: `Registry item ${item.id}` })
  }
  for (const block of blocks.loadAll(wiki)) {
    nodes.push({
      id: block.id,
      label: block.scope === 'agent' && block.owner ? `${env.directory.agentName(block.owner) ?? 'Removed agent'} · ${block.front.label}` : block.front.label,
      type: 'block',
      pageType: block.scope,
      namespace: block.scope === 'project' && block.owner ? `/projects/${block.owner}` : store.ROOT_NAMESPACE,
      summary: block.body.trim() ? store.firstParagraph(block.body) : block.front.description,
      status: 'established',
      provenance: `Memory block · ${charCount(block.body)} of ${block.front.limit} characters`
    })
  }
  for (const source of store.listSources(wiki)) {
    nodes.push({ id: source.id, label: source.name, type: 'source', pageType: null, namespace: store.ROOT_NAMESPACE, summary: `Imported source, version ${source.version}`, status: 'established', provenance: `Imported ${source.importedAt}` })
  }

  const ids = new Set(nodes.map((node) => node.id))
  const edges: GraphEdge[] = []
  const pushLinks = (from: string, links: readonly store.WikiLink[], sourceIds: readonly string[]): void => {
    for (const link of links) if (ids.has(link.toId)) edges.push({ id: `${from}->${link.toId}:${link.type}`, source: from, target: link.toId, type: link.type, evidence: null })
    for (const sourceId of sourceIds) if (ids.has(sourceId)) edges.push({ id: `${from}->${sourceId}:cites`, source: from, target: sourceId, type: 'references', evidence: sourceId })
  }
  for (const page of pages) pushLinks(page.frontmatter.id, page.frontmatter.links, page.frontmatter.sourceIds)
  for (const memory of memories) pushLinks(memory.front.id, memory.front.links, memory.front.sourceIds)
  // Namespace membership: entries in a project namespace attach to that project's overview page.
  const projectPages = pages.filter((page) => page.frontmatter.type === 'project' && page.location.namespace.startsWith('/projects/')).map((page) => ({ namespace: page.location.namespace, id: page.frontmatter.id }))
  const members = [
    ...pages.map((page) => ({ id: page.frontmatter.id, namespace: page.location.namespace })),
    ...memories.map((memory) => ({ id: memory.front.id, namespace: memory.front.namespace })),
    ...nodes.filter((node) => node.type === 'block').map((node) => ({ id: node.id, namespace: node.namespace }))
  ]
  for (const member of members) {
    const project = projectPages.find((entry) => entry.namespace === member.namespace && entry.id !== member.id)
    if (project) edges.push({ id: `${member.id}->${project.id}:part_of`, source: member.id, target: project.id, type: 'part_of', evidence: null })
  }
  return { nodes, edges }
}
