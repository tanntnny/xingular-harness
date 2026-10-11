// Canonical Wiki files under `<data root>/wiki/`. One global corpus: `home.md`, `library/**`,
// and `projects/<slug>/**` hold pages; `blocks/` holds memory blocks and `facts/` holds short
// typed facts; `raw/`, `revisions/`, `inbox/`, `operations/`, and `trash/` are shared. A page's Wiki path and
// namespace come from where its file lives, so they are never stored twice.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { stringify } from 'yaml'

import { DEFAULT_PRODUCT_NAME } from '../core/env'
import { invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { appendLine, atomicWrite, newId, now, readJson, safeId, writeJson } from '../core/fs'
import { comparePaths, compareText, lines, takeChars } from '../core/text'

export const ROOT_NAMESPACE = '/'
/** Pages that belong to no project. `/docs` (its name before storage version 3) is accepted as input. */
export const LIBRARY_NAMESPACE = '/library'
export const LAYOUT = ['blocks', 'facts', 'library', 'projects', 'raw', 'revisions', 'inbox', 'operations'] as const

export function wikiDir(root: string): string {
  return join(root, 'wiki')
}

function createIfMissing(path: string, contents: string): void {
  if (!existsSync(path)) atomicWrite(path, contents)
}

export const SCHEMA = `# Wiki schema

- One global Wiki. \`home.md\` is the Home page, \`library/\` holds pages that belong to no project, and \`projects/<slug>/\` is a project's namespace.
- Pages carry frontmatter \`id\`, \`title\`, \`type\`, \`updatedAt\`, \`sourceIds\`, \`links\`. The path and namespace come from the file's location.
- \`blocks/\` holds memory blocks that are always in an agent's or session's context: \`shared/\`, \`agents/<agent-id>/\`, and \`projects/<slug>/brief.md\`.
- \`facts/\` holds short typed facts with \`kind\`, \`namespace\`, \`confidence\`, \`status\`, and sources.
- Skills, prompts, and rules live in the registry (\`registry/\`); pages and facts link to them by id (\`skills/<name>\`).
- \`raw/\` holds immutable source snapshots; replacing a source creates a new version.
- Every change writes a snapshot and manifest entry in \`revisions/\`. Claims without verifiable evidence go to \`inbox/\`.
`

/** Creates the Wiki skeleton. Existing files are never replaced. */
export function ensureLayout(root: string, productName = DEFAULT_PRODUCT_NAME): void {
  ensureLayoutAt(wikiDir(root), productName)
}

/** The skeleton in any folder, so a migration can stage it before it replaces the Wiki. */
export function ensureLayoutAt(directory: string, productName = DEFAULT_PRODUCT_NAME): void {
  for (const part of LAYOUT) mkdirSync(join(directory, part), { recursive: true })
  createIfMissing(
    join(directory, 'home.md'),
    `---\nid: home\ntitle: Home\ntype: summary\nsourceIds: []\nlinks: []\n---\n\n# Welcome\n\nThis is the shared ${productName} Wiki: memory blocks, knowledge, and the playbook every agent and session works from.\n`
  )
  createIfMissing(join(directory, 'index.md'), '# Wiki index\n\nNo pages yet.\n')
  createIfMissing(join(directory, 'log.md'), '# Maintenance log\n\n')
  createIfMissing(join(directory, 'schema.md'), SCHEMA)
}

// What a project's Links page says until something is recorded: a map of where the project's
// documents and notes are, not a copy of them.
const LINKS_PLACEHOLDER = 'Nothing recorded yet. List the documents, notes, and sources that matter for this project, one line each: a link or path, then what it is for and why it matters. Link to them; do not copy them here.'

/** The fixed pages every project namespace starts with, beside `overview`: file name, title, type. */
export const PROJECT_SKELETON = [
  ['decisions', 'Decisions', 'decision'],
  ['state', 'Current state', 'summary'],
  ['open-questions', 'Open questions', 'question'],
  ['links', 'Links', 'reference']
] as const

function yamlText(text: string): string {
  try {
    return stringify(text, { lineWidth: 0 }).trimEnd()
  } catch {
    return 'Project'
  }
}

/** Where a project's namespace lives, creating its overview page the first time. */
export function ensureProjectNamespace(root: string, slug: string, name: string): void {
  const directory = join(wikiDir(root), 'projects', safeId(slug))
  mkdirSync(directory, { recursive: true })
  createIfMissing(
    join(directory, 'overview.md'),
    `---\nid: project-${slug}\ntitle: ${yamlText(name)}\ntype: project\nsourceIds: []\nlinks: []\n---\n\nOverview of the ${name.replaceAll('\n', ' ')} project.\n`
  )
  // One page per aspect, updated in place, so knowledge has a place to go before it exists.
  for (const [file, title, pageType] of PROJECT_SKELETON) {
    createIfMissing(
      join(directory, `${file}.md`),
      `---\nid: ${slug}-${file}\ntitle: ${yamlText(`${name}: ${title}`)}\ntype: ${pageType}\nsourceIds: [user]\nlinks:\n- toId: project-${slug}\n  type: references\n---\n\n${file === 'links' ? LINKS_PLACEHOLDER : 'Nothing recorded yet.'}\n`
    )
  }
}

// ---- Locations ----------------------------------------------------------------

/** A page's Wiki path (`/projects/agent-x/architecture`) and namespace (`/projects/agent-x`). */
export interface Location {
  path: string
  namespace: string
}

/** Whether a page is part of a project's fixed skeleton (it may stand alone and start empty). */
export function isSkeleton(location: Location): boolean {
  return location.namespace.startsWith('/projects/') && PROJECT_SKELETON.some(([file]) => location.path === `${location.namespace}/${file}`)
}

export function locate(wiki: string, file: string): Location {
  const inside = relative(wiki, file)
  const parts = (inside.startsWith('..') ? file : inside).split('/').filter(Boolean)
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/(?<=.)\.[^.]*$/, '')
  const namespace = parts[0] === 'projects' && parts.length > 2 ? `/projects/${parts[1]}` : parts[0] === 'library' ? LIBRARY_NAMESPACE : ROOT_NAMESPACE
  return { path: `/${parts.join('/')}`, namespace }
}

/**
 * Folder that new pages in `namespace` are written to. Accepts `/`, `/library[/…]`, and
 * `/projects/<slug>[/…]`; every segment must be a safe identifier.
 */
export function namespaceDir(wiki: string, namespace: string): string {
  const trimmed = namespace.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed === LIBRARY_NAMESPACE) return join(wiki, 'library')
  const segments = trimmed.replace(/^\/+/, '').split('/')
  if (segments[0] === 'docs') segments[0] = 'library'
  for (const segment of segments) {
    try {
      safeId(segment)
    } catch {
      throw invalid(`${namespace} is not a valid Wiki namespace.`)
    }
  }
  if (segments[0] === 'library' || (segments[0] === 'projects' && segments.length > 1)) return join(wiki, ...segments)
  throw invalid(`${namespace} is not a Wiki namespace. Use /library or /projects/<project>.`)
}

/** `/projects/<slug>` for any path inside a project namespace. */
export function projectNamespaceOf(namespace: string): string | null {
  const [first, slug] = namespace.replace(/^\/+/, '').split('/')
  return first === 'projects' && slug ? `/projects/${slug}` : null
}

// ---- Pages ----------------------------------------------------------------------

export interface WikiLink {
  fromId: string
  toId: string
  type: string
}

/** Page frontmatter. Older pages also carry `scope`; it is ignored and not written back. */
export interface Frontmatter {
  id: string
  title: string
  type: string
  updatedAt: string
  sourceIds: string[]
  links: WikiLink[]
}

export const PAGE_TYPES = ['project', 'person', 'concept', 'decision', 'summary', 'question', 'reference'] as const
export const LINK_TYPES = ['references', 'depends_on', 'supersedes', 'contradicts', 'produced_by', 'uses'] as const

export interface ParsedPage {
  frontmatter: Frontmatter
  body: string
  path: string
  location: Location
}

/** A string array field: absent is empty, anything else that is not a list of strings fails the parse. */
export function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

/** A `links` field with the same rules: every entry needs `toId` and `type`. */
export function linkList(value: unknown, fromId: string): WikiLink[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const links: WikiLink[] = []
  for (const item of value) {
    const link = item as { toId?: unknown; type?: unknown } | null
    if (!link || typeof link !== 'object' || typeof link.toId !== 'string' || typeof link.type !== 'string') return null
    if ((LINK_TYPES as readonly string[]).includes(link.type)) links.push({ fromId, toId: link.toId, type: link.type })
  }
  return links
}

export function parsePage(text: string, wiki: string, path: string): ParsedPage | null {
  const parsed = frontmatter.parse(text)
  if (!parsed) return null
  const { id, title, type, updatedAt } = parsed.front
  if (typeof id !== 'string' || typeof title !== 'string' || typeof type !== 'string') return null
  if (updatedAt !== undefined && typeof updatedAt !== 'string') return null
  if (!(PAGE_TYPES as readonly string[]).includes(type)) return null
  const sourceIds = stringList(parsed.front.sourceIds)
  const links = linkList(parsed.front.links, id)
  if (!sourceIds || !links) return null
  return { frontmatter: { id, title, type, updatedAt: updatedAt ?? '', sourceIds, links }, body: parsed.body, path, location: locate(wiki, path) }
}

export function serializePage(front: Frontmatter, body: string): string {
  return frontmatter.serialize({ id: front.id, title: front.title, type: front.type, updatedAt: front.updatedAt, sourceIds: front.sourceIds, links: front.links }, body)
}

export function markdownFiles(directory: string, into: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const path = join(directory, name)
    let directoryEntry = false
    try {
      directoryEntry = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (directoryEntry) markdownFiles(path, into)
    else if (name.endsWith('.md') && name.length > 3) into.push(path)
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every page file: Home, the Library, and project namespaces. */
export function pageFiles(wiki: string): string[] {
  const files: string[] = []
  if (isFile(join(wiki, 'home.md'))) files.push(join(wiki, 'home.md'))
  markdownFiles(join(wiki, 'library'), files)
  markdownFiles(join(wiki, 'projects'), files)
  return files.sort(comparePaths)
}

export function loadPages(wiki: string): ParsedPage[] {
  const pages: ParsedPage[] = []
  for (const path of pageFiles(wiki)) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const page = parsePage(text, wiki, path)
    if (page) pages.push(page)
  }
  return pages
}

export function firstParagraph(body: string): string {
  const line = lines(body).map((entry) => entry.trim()).find((entry) => entry && !entry.startsWith('#')) ?? ''
  return takeChars(line, 240)
}

export { slugify as slug } from '../core/projects'

// ---- Revisions --------------------------------------------------------------------

export interface WikiRevision {
  id: string
  pageId: string
  createdAt: string
  actor: string
  reason: string
}

/** Revision folder for any entry: a page, a fact, a block (`blocks/shared/user`), or a registry item (`skills/<name>`). */
export function revisionsDir(wiki: string, entryId: string): string {
  return join(wiki, 'revisions', safeId(entryId.replaceAll('/', '--')))
}

export function readManifest(wiki: string, entryId: string): WikiRevision[] {
  return readJson<WikiRevision[]>(join(revisionsDir(wiki, entryId), 'manifest.json')) ?? []
}

export function currentRevision(wiki: string, entryId: string): string | null {
  try {
    return readManifest(wiki, entryId).at(-1)?.id ?? null
  } catch {
    return null
  }
}

export function snapshot(wiki: string, entryId: string, contents: string, actor: string, reason: string): WikiRevision {
  const directory = revisionsDir(wiki, entryId)
  const revision: WikiRevision = { id: newId(), pageId: entryId, createdAt: now(), actor, reason }
  atomicWrite(join(directory, `${revision.id}.md`), contents)
  const manifest = readManifest(wiki, entryId)
  manifest.push(revision)
  writeJson(join(directory, 'manifest.json'), manifest)
  return revision
}

export function revisionText(wiki: string, entryId: string, revisionId: string): string {
  try {
    return readFileSync(join(revisionsDir(wiki, entryId), `${safeId(revisionId)}.md`), 'utf8')
  } catch {
    throw notFound('Revision')
  }
}

export function log(wiki: string, line: string): void {
  appendLine(join(wiki, 'log.md'), line)
}

// ---- Sources ------------------------------------------------------------------------

export interface WikiSource {
  id: string
  name: string
  importedAt: string
  version: number
  previousId: string | null
}

interface StoredSource extends WikiSource {
  sha256: string
}

function storedSources(wiki: string): StoredSource[] {
  let entries: string[]
  try {
    entries = readdirSync(join(wiki, 'raw'))
  } catch {
    return []
  }
  const sources: StoredSource[] = []
  for (const name of entries) {
    try {
      const stored = readJson<StoredSource>(join(wiki, 'raw', name, 'meta.json'))
      if (stored && typeof stored.id === 'string') sources.push(stored)
    } catch {
      // A source without readable metadata is not listed.
    }
  }
  return sources.sort((left, right) => compareText(left.importedAt, right.importedAt))
}

const withoutHash = ({ sha256: _hash, ...source }: StoredSource): WikiSource => source

export function listSources(wiki: string): WikiSource[] {
  return storedSources(wiki).map(withoutHash)
}

export function importSource(wiki: string, name: string, bytes: Uint8Array): WikiSource {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const existing = storedSources(wiki)
  const same = existing.find((source) => source.sha256 === hash)
  if (same) return withoutHash(same)
  const previous = existing.filter((source) => source.name === name).reduce<StoredSource | null>((best, source) => (!best || source.version >= best.version ? source : best), null)
  const stored: StoredSource = {
    id: `src-${hash.slice(0, 12)}`,
    name,
    importedAt: now(),
    version: previous ? previous.version + 1 : 1,
    previousId: previous?.id ?? null,
    sha256: hash
  }
  const directory = join(wiki, 'raw', stored.id)
  atomicWrite(join(directory, name), bytes)
  writeJson(join(directory, 'meta.json'), stored)
  log(wiki, `- ${stored.importedAt} · user · ingest · source \`${stored.id}\` (${stored.name}, v${stored.version})`)
  return withoutHash(stored)
}

/** Evidence ids that need no local file: runs, URLs, and things the user accepted or wrote. */
export function isExternalEvidence(id: string): boolean {
  return id.startsWith('run:') || id.startsWith('url:') || id.startsWith('user')
}
