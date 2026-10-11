// Canonical skills, prompts, and rules under `<data root>/registry/`. Each item is a Markdown
// file (a skill may also be a folder with `SKILL.md`) with optional `name`/`description`
// frontmatter. These files are the single source of truth. Items are enabled globally and per
// project; enabled items are loaded automatically, and any item can be retrieved on demand.
//
// Built-in items ship with the harness or the application that embeds it, in folders laid out
// like `registry/`. They are read-only and on everywhere until a person switches one off; an
// item of the same id in the data root replaces the built-in one.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { invalid } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, now, readJsonOr, writeJson } from '../core/fs'
import { findProject } from '../core/projects'
import { compareText, lines, takeChars } from '../core/text'
import * as store from '../memory/store'

export const KINDS = ['skills', 'prompts', 'rules'] as const
export type RegistryKind = (typeof KINDS)[number]

export interface RegistryItem {
  /** `<kind>/<name>`, stable across edits. */
  id: string
  kind: string
  name: string
  description: string
  path: string
  /** Set on an item that ships with the harness or the application, not on a person's own. */
  builtin?: true
}

let builtinDirs: string[] = []

/** The folders built-in items are read from, each laid out like `registry/`. Later folders win. */
export function configureBuiltins(directories: readonly string[]): void {
  builtinDirs = [...directories]
}

function itemFrom(kind: string, stem: string, file: string): RegistryItem | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const parsed = frontmatter.parse(text)
  const name = parsed?.front.name
  const description = parsed?.front.description
  // A frontmatter block whose name or description is not text is treated as no frontmatter.
  const usable = parsed !== null && (name === undefined || name === null || typeof name === 'string') && (description === undefined || description === null || typeof description === 'string')
  const body = usable ? parsed.body : text
  return {
    id: `${kind}/${stem}`,
    kind,
    name: usable && typeof name === 'string' ? name : stem.replace(/[-_]/g, ' '),
    description: usable && typeof description === 'string' ? description : takeChars(lines(body).find((line) => line.trim() && !line.startsWith('#')) ?? '', 160),
    path: file
  }
}

const stemOf = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name)

function itemsIn(directory: string): RegistryItem[] {
  const items: RegistryItem[] = []
  for (const kind of KINDS) {
    let names: string[]
    try {
      names = readdirSync(join(directory, kind))
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(directory, kind, name)
      const stem = stemOf(name)
      if (stem.startsWith('.')) continue
      const file = store.isDir(path) ? join(path, 'SKILL.md') : name.endsWith('.md') ? path : null
      const item = file && itemFrom(kind, stem, file)
      if (item) items.push(item)
    }
  }
  return items
}

export function list(root: string): RegistryItem[] {
  const items = new Map<string, RegistryItem>()
  for (const directory of builtinDirs) for (const item of itemsIn(directory)) items.set(item.id, { ...item, builtin: true })
  for (const item of itemsIn(join(root, 'registry'))) items.set(item.id, item)
  return [...items.values()].sort((left, right) => compareText(left.id, right.id))
}

function enablementPath(root: string): string {
  return join(root, 'config/registry-enabled.json')
}

/** Key for items enabled everywhere. Older data roots used `personal`, which is read the same way. */
export const GLOBAL_KEY = 'global'

/** Enabled item ids keyed by project id, or `global` for everyone. */
export function enablement(root: string): Record<string, unknown> {
  const map = readJsonOr<unknown>(enablementPath(root), {})
  return map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, unknown>) : {}
}

export function enablementIds(map: Record<string, unknown>, key: string): string[] {
  const ids = map[key]
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/** Built-in items a person switched off. Everything else built in is on everywhere. */
export const BUILTIN_OFF_KEY = 'builtinOff'

/** Items active for a caller: built-ins left on, everything enabled globally, and the current project's own. */
export function enabledFor(root: string, projectId: string | null): RegistryItem[] {
  const map = enablement(root)
  const ids = [...enablementIds(map, GLOBAL_KEY), ...enablementIds(map, 'personal'), ...(projectId ? enablementIds(map, projectId) : [])]
  const off = enablementIds(map, BUILTIN_OFF_KEY)
  return list(root).filter((item) => (item.builtin ? !off.includes(item.id) : ids.includes(item.id)))
}

/** An item's Markdown body without frontmatter. */
export function itemBody(item: RegistryItem): string {
  try {
    const text = readFileSync(item.path, 'utf8')
    return frontmatter.split(text)?.body ?? text
  } catch {
    return ''
  }
}

export interface RegistryResources {
  ids: string[]
  skillPaths: string[]
  promptPaths: string[]
}

/** What a Pi session needs to load enabled items natively. Rule text reaches the model through the compiled prompt. */
export function resources(root: string, projectId: string | null): RegistryResources {
  const items = enabledFor(root, projectId)
  return {
    ids: items.map((item) => item.id),
    skillPaths: items.filter((item) => item.kind === 'skills').map((item) => item.path),
    promptPaths: items.filter((item) => item.kind === 'prompts').map((item) => item.path)
  }
}

// Prefix of the entries the harness manages in a Pi agent folder's `skills/`.
const LINKED_SKILL_PREFIX = 'agentx-'

function isLinkedSkill(path: string): boolean {
  let meta
  try {
    meta = lstatSync(path)
  } catch {
    return false
  }
  if (meta.isSymbolicLink()) return true
  if (!meta.isDirectory()) return false
  // A single-file skill is linked as `agentx-<name>/SKILL.md` inside a folder the harness made.
  try {
    const entries = readdirSync(path)
    return entries.length === 1 && entries[0] === 'SKILL.md' && lstatSync(join(path, 'SKILL.md')).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Links the project's enabled skills into a terminal session's `skills/` folder as
 * `agentx-<name>`, replacing earlier links and leaving the user's own skills alone. The folder
 * is shared by every account, so the links follow the project that launched most recently.
 */
export function linkSkills(skillsDir: string, root: string, projectId: string | null): void {
  mkdirSync(skillsDir, { recursive: true })
  for (const name of readdirSync(skillsDir)) {
    const path = join(skillsDir, name)
    if (!name.startsWith(LINKED_SKILL_PREFIX) || !isLinkedSkill(path)) continue
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else rmSync(path, { recursive: true, force: true })
  }
  for (const item of enabledFor(root, projectId).filter((entry) => entry.kind === 'skills')) {
    const link = join(skillsDir, `${LINKED_SKILL_PREFIX}${item.id.replace(/^skills\//, '')}`)
    if (basename(item.path) === 'SKILL.md') {
      symlinkSync(dirname(item.path), link)
    } else {
      mkdirSync(link, { recursive: true })
      symlinkSync(item.path, join(link, 'SKILL.md'))
    }
  }
}

export interface RegistryState {
  items: RegistryItem[]
  enabled: Record<string, unknown>
}

/** Enablement as a person sees it: built-ins that are on count as enabled everywhere. */
function shown(items: readonly RegistryItem[], map: Record<string, unknown>): Record<string, unknown> {
  const off = enablementIds(map, BUILTIN_OFF_KEY)
  const on = items.filter((item) => item.builtin && !off.includes(item.id)).map((item) => item.id)
  if (!on.length) return map
  const global = [...enablementIds(map, GLOBAL_KEY), ...enablementIds(map, 'personal')]
  return { ...map, [GLOBAL_KEY]: [...global, ...on.filter((id) => !global.includes(id))] }
}

export function state(root: string): RegistryState {
  const items = list(root)
  return { items, enabled: shown(items, enablement(root)) }
}

/** Sets enabled items for a project, or globally when `projectId` is `null`. */
export function setEnabled(root: string, projectId: string | null, ids: string[]): RegistryState {
  if (projectId) findProject(root, projectId)
  const items = list(root)
  const unknown = ids.find((id) => !items.some((item) => item.id === id))
  if (unknown !== undefined) throw invalid(`Unknown registry item ${unknown}.`)
  const builtin = items.filter((item) => item.builtin).map((item) => item.id)
  const map = enablement(root)
  if (!projectId) {
    delete map.personal
    // A built-in left out of the global list was switched off.
    const off = builtin.filter((id) => !ids.includes(id))
    if (off.length) map[BUILTIN_OFF_KEY] = off
    else delete map[BUILTIN_OFF_KEY]
  }
  map[projectId ?? GLOBAL_KEY] = ids.filter((id) => !builtin.includes(id))
  writeJson(enablementPath(root), map)
  return { items, enabled: shown(items, map) }
}

function kindDir(root: string, kind: string): string {
  if (!(KINDS as readonly string[]).includes(kind)) throw invalid('Unknown registry kind.')
  return join(root, 'registry', kind)
}

/** Creates a starter item from a name: a Markdown file, or a skill folder with `SKILL.md`. */
export function create(root: string, kind: string, rawName: string): RegistryState {
  const directory = kindDir(root, kind)
  const name = rawName.trim()
  const slug = Array.from(name.toLowerCase(), (character) => (/^[a-z0-9]$/.test(character) ? character : '-')).join('').split('-').filter(Boolean).join('-')
  if (!slug || slug.length > 64) throw invalid('Use a short name with letters or numbers.')
  const description = 'Describe when to use this.'
  const target = kind === 'skills' ? join(directory, slug) : join(directory, `${slug}.md`)
  let exists = true
  try {
    lstatSync(target)
  } catch {
    exists = false
  }
  if (exists) throw invalid('An item with that name already exists.')
  if (kind === 'skills') atomicWrite(join(target, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps the agent should follow.\n`)
  else atomicWrite(target, `---\nname: ${name}\ndescription: ${description}\n---\n\n`)
  return state(root)
}

/**
 * Writes a skill, prompt, or rule (an accepted proposal), keeping an existing item's location.
 * The previous content and the new content are recorded as Wiki revisions of the item.
 */
export function writeItem(root: string, kind: string, name: string, description: string, body: string, reason: string): string {
  const plural = kind === 'skill' ? 'skills' : kind === 'prompt' ? 'prompts' : kind === 'rule' ? 'rules' : null
  if (!plural) throw invalid('Only skills, prompts, and rules can be written.')
  const stem = store.slug(name)
  const id = `${plural}/${stem}`
  const existing = list(root).find((item) => item.id === id)
  // A built-in is never edited in place: the accepted text becomes the person's own item.
  const path = existing && !existing.builtin ? existing.path : plural === 'skills' ? join(kindDir(root, plural), stem, 'SKILL.md') : join(kindDir(root, plural), `${stem}.md`)
  const text = frontmatter.serialize({ name: plural === 'skills' ? stem : name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, body)
  const wiki = store.wikiDir(root)
  if (existing) {
    try {
      store.snapshot(wiki, id, readFileSync(existing.path, 'utf8'), 'user', 'Before accepted proposal')
    } catch {
      // Nothing readable to keep.
    }
  }
  atomicWrite(path, text)
  store.snapshot(wiki, id, text, 'user', reason)
  store.log(wiki, `- ${now()} · user · ${existing ? 'updated' : 'created'} \`${id}\` · ${reason}`)
  return id
}
