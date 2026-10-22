// The Wiki: plain Markdown notes about projects, linked to each other. It is reference material
// a person and agents read and write; it is not what shapes an agent (that is the variant).
//
//   <data>/wiki/home.md
//   <data>/wiki/library/**.md          notes that belong to no project
//   <data>/wiki/projects/<slug>/**.md  a project's notes
//   <data>/wiki-history/<path>/<time>.md  earlier versions, one file per save
//
// A note's path is its file path without `.md`. Links are `[[path]]`, `[[path|label]]`, or a
// Markdown link to a relative `.md` file.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

import { noteChange } from '../core/changes'
import { HarnessError, invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, now } from '../core/fs'
import { projectsOrNone } from '../core/projects'
import { looksSecret } from '../core/secrets'

/** Folders an earlier Wiki kept beside its pages. They are moved aside, never read as notes. */
export const LEGACY_FOLDERS = ['blocks', 'facts', 'raw', 'revisions', 'inbox', 'operations', 'trash'] as const
const MAX_NOTE = 400_000

export function wikiDir(root: string): string {
  return join(root, 'wiki')
}

function historyDir(root: string): string {
  return join(root, 'wiki-history')
}

export interface NoteSummary {
  path: string
  title: string
  /** The project slug, or null for the Library and Home. */
  project: string | null
  updatedAt: string
  size: number
}

export interface Note extends NoteSummary {
  body: string
  links: string[]
  backlinks: string[]
}

/** Accepts a note path such as `projects/app/decisions` or `library/glossary`. */
export function cleanPath(path: string): string {
  const clean = String(path ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '')
  const parts = clean.split('/')
  if (!clean || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw invalid('A note path is a relative path such as projects/<slug>/<name>.')
  if (parts.length === 1 && clean !== 'home') throw invalid('A note lives under library/ or projects/<slug>/.')
  if (parts.length > 1 && parts[0] !== 'library' && parts[0] !== 'projects') throw invalid('A note lives under library/ or projects/<slug>/.')
  if (parts[0] === 'projects' && parts.length < 3) throw invalid('A project note is projects/<slug>/<name>.')
  if ((LEGACY_FOLDERS as readonly string[]).includes(parts[0]!)) throw invalid('That folder is not part of the Wiki.')
  return clean
}

function fileOf(root: string, path: string): string {
  return join(wikiDir(root), `${cleanPath(path)}.md`)
}

function projectOfPath(path: string): string | null {
  const parts = path.split('/')
  return parts[0] === 'projects' ? parts[1] ?? null : null
}

function titleOf(path: string, text: string): string {
  const parsed = safeParse(text)
  const declared = parsed.front?.title
  if (typeof declared === 'string' && declared.trim()) return declared.trim()
  const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim()
  return heading || path.split('/').pop()!.replace(/[-_]/g, ' ')
}

function safeParse(text: string): { front: Record<string, unknown> | null; body: string } {
  try {
    const parsed = frontmatter.parse(text)
    return parsed ? { front: parsed.front, body: parsed.body } : { front: null, body: text }
  } catch {
    return { front: null, body: text }
  }
}

function walk(dir: string, into: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(path, into)
    else if (name.endsWith('.md')) into.push(path)
  }
}

/** Every note path, Home first, then the Library, then projects. */
export function paths(root: string): string[] {
  const wiki = wikiDir(root)
  const files: string[] = []
  if (existsSync(join(wiki, 'home.md'))) files.push(join(wiki, 'home.md'))
  walk(join(wiki, 'library'), files)
  walk(join(wiki, 'projects'), files)
  return files.map((file) => relative(wiki, file).split(sep).join('/').replace(/\.md$/, ''))
}

function summary(root: string, path: string): NoteSummary {
  const file = fileOf(root, path)
  const text = readFileSync(file, 'utf8')
  return { path, title: titleOf(path, text), project: projectOfPath(path), updatedAt: statSync(file).mtime.toISOString(), size: text.length }
}

export function list(root: string, options: { project?: string | null } = {}): NoteSummary[] {
  return paths(root)
    .filter((path) => options.project === undefined || projectOfPath(path) === options.project)
    .map((path) => summary(root, path))
}

const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const MD_LINK = /\[[^\]]*\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g

/** Resolves a link written in `from` to a note path, or null when it points nowhere known. */
export function resolveLink(target: string, from: string, known: ReadonlySet<string>, titles: ReadonlyMap<string, string>): string | null {
  const raw = target.trim().replace(/\.md$/i, '')
  if (!raw || /^[a-z]+:/i.test(raw)) return null
  const candidates: string[] = [raw.replace(/^\/+/, '')]
  if (!raw.startsWith('/')) {
    const base = from.split('/').slice(0, -1)
    const parts = [...base]
    for (const part of raw.split('/')) {
      if (part === '..') parts.pop()
      else if (part && part !== '.') parts.push(part)
    }
    candidates.unshift(parts.join('/'))
    const project = projectOfPath(from)
    if (project) candidates.push(`projects/${project}/${raw}`)
    candidates.push(`library/${raw}`)
  }
  for (const candidate of candidates) if (known.has(candidate)) return candidate
  return titles.get(raw.toLowerCase()) ?? null
}

function linksIn(body: string, from: string, known: ReadonlySet<string>, titles: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>()
  for (const match of body.matchAll(WIKI_LINK)) {
    const found = resolveLink(match[1]!, from, known, titles)
    if (found && found !== from) out.add(found)
  }
  for (const match of body.matchAll(MD_LINK)) {
    const found = resolveLink(match[1]!, from, known, titles)
    if (found && found !== from) out.add(found)
  }
  return [...out].sort()
}

export interface Graph {
  nodes: NoteSummary[]
  edges: { from: string; to: string }[]
}

/** Every note and every resolved link between notes. */
export function graph(root: string): Graph {
  const nodes = list(root)
  const known = new Set(nodes.map((node) => node.path))
  const titles = new Map(nodes.map((node) => [node.title.toLowerCase(), node.path]))
  const edges: Graph['edges'] = []
  for (const node of nodes) {
    const body = readFileSync(fileOf(root, node.path), 'utf8')
    for (const to of linksIn(body, node.path, known, titles)) edges.push({ from: node.path, to })
  }
  return { nodes, edges }
}

export function read(root: string, path: string): Note {
  const clean = cleanPath(path)
  const file = fileOf(root, clean)
  if (!existsSync(file)) throw notFound(`The note ${clean}`)
  const text = readFileSync(file, 'utf8')
  const { nodes, edges } = graph(root)
  const known = new Set(nodes.map((node) => node.path))
  const titles = new Map(nodes.map((node) => [node.title.toLowerCase(), node.path]))
  return {
    ...summary(root, clean),
    body: text,
    links: linksIn(text, clean, known, titles),
    backlinks: edges.filter((edge) => edge.to === clean).map((edge) => edge.from).sort()
  }
}

/** Writes a note, keeping the earlier text as a version. Returns the note as saved. */
export function write(root: string, path: string, body: string, options: { expectedUpdatedAt?: string | null; actor?: string; reason?: string } = {}): Note {
  const clean = cleanPath(path)
  if (typeof body !== 'string') throw invalid('A note needs text.')
  if (body.length > MAX_NOTE) throw invalid(`A note may hold at most ${MAX_NOTE.toLocaleString('en-US')} characters.`)
  if (looksSecret(body)) throw new HarnessError('secret_refused', 'That text looks like it contains a credential, so it was not saved.')
  const project = projectOfPath(clean)
  if (project && !projectsOrNone(root).some((known) => known.slug === project)) throw invalid(`There is no project with the slug ${project}.`)
  const file = fileOf(root, clean)
  if (existsSync(file)) {
    const current = statSync(file).mtime.toISOString()
    if (options.expectedUpdatedAt && options.expectedUpdatedAt !== current) throw new HarnessError('conflict', 'The note changed since it was opened. Reload it and try again.')
    const previous = readFileSync(file, 'utf8')
    if (previous === body) return read(root, clean)
    atomicWrite(join(historyDir(root), clean, `${now().replace(/[:.]/g, '-')}.md`), previous)
  }
  mkdirSync(dirname(file), { recursive: true })
  atomicWrite(file, body)
  noteChange({ wiki: wikiDir(root), id: clean, path: file, text: body, actor: options.actor ?? 'user', reason: options.reason ?? 'Saved' })
  return read(root, clean)
}

/** Removes a note; its last text is kept as a version. */
export function remove(root: string, path: string): void {
  const clean = cleanPath(path)
  const file = fileOf(root, clean)
  if (!existsSync(file)) throw notFound(`The note ${clean}`)
  atomicWrite(join(historyDir(root), clean, `${now().replace(/[:.]/g, '-')}.md`), readFileSync(file, 'utf8'))
  rmSync(file)
}

export interface Version {
  id: string
  savedAt: string
}

export function versions(root: string, path: string): Version[] {
  const dir = join(historyDir(root), cleanPath(path))
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md')).sort().reverse().map((name) => ({ id: name.replace(/\.md$/, ''), savedAt: statSync(join(dir, name)).mtime.toISOString() }))
  } catch {
    return []
  }
}

export function version(root: string, path: string, id: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw invalid('Invalid version.')
  const file = join(historyDir(root), cleanPath(path), `${id}.md`)
  if (!existsSync(file)) throw notFound('That version')
  return readFileSync(file, 'utf8')
}

export interface Hit {
  path: string
  title: string
  project: string | null
  excerpt: string
  score: number
}

/** Notes that contain the query's words, best first. The current project's notes rank higher. */
export function search(root: string, query: string, options: { project?: string | null; limit?: number } = {}): Hit[] {
  const words = [...new Set(String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1))].slice(0, 16)
  if (!words.length) return []
  const hits: Hit[] = []
  for (const path of paths(root)) {
    const text = readFileSync(fileOf(root, path), 'utf8')
    const lower = text.toLowerCase()
    const title = titleOf(path, text)
    let score = 0
    for (const word of words) {
      if (title.toLowerCase().includes(word)) score += 5
      if (path.toLowerCase().includes(word)) score += 2
      let at = lower.indexOf(word)
      let count = 0
      while (at >= 0 && count < 20) {
        count++
        at = lower.indexOf(word, at + word.length)
      }
      score += count
    }
    if (!score) continue
    const project = projectOfPath(path)
    if (options.project && project === options.project) score *= 1.5
    const first = Math.max(0, Math.min(...words.map((word) => lower.indexOf(word)).filter((at) => at >= 0)))
    const excerpt = text.slice(Math.max(0, first - 80), first + 160).replace(/\s+/g, ' ').trim()
    hits.push({ path, title, project, excerpt, score })
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(Math.max(options.limit ?? 10, 1), 50))
}

/** Creates the Wiki's folders and Home note. Existing files are never replaced. */
export function ensureLayout(root: string, productName: string): void {
  const wiki = wikiDir(root)
  mkdirSync(join(wiki, 'library'), { recursive: true })
  mkdirSync(join(wiki, 'projects'), { recursive: true })
  if (!existsSync(join(wiki, 'home.md'))) atomicWrite(join(wiki, 'home.md'), `# Home\n\nNotes about your projects for ${productName}. Link notes with [[library/name]] or [[projects/<slug>/name]].\n`)
  for (const project of projectsOrNone(root)) mkdirSync(join(wiki, 'projects', project.slug), { recursive: true })
}

/**
 * Moves what an earlier Wiki kept beside its notes (memory blocks, facts, sources, revisions,
 * the Inbox) to `<data>/legacy/wiki-<time>/`, once. Nothing is deleted. Returns where it went.
 */
export function moveLegacy(root: string): string | null {
  const wiki = wikiDir(root)
  const found = LEGACY_FOLDERS.filter((name) => existsSync(join(wiki, name)))
  const loose = ['index.md', 'log.md', 'schema.md'].filter((name) => existsSync(join(wiki, name)))
  if (!found.length && !loose.length) return null
  const dest = join(root, 'legacy', `wiki-${now().replace(/[:.]/g, '-')}`)
  mkdirSync(dest, { recursive: true })
  for (const name of [...found, ...loose]) renameSync(join(wiki, name), join(dest, name))
  return dest
}
