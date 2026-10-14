// Canonical skills, prompts, and rules under `<data root>/registry/`. Each item is a Markdown
// file (a skill may also be a folder with `SKILL.md`) with optional `name`/`description`
// frontmatter. These files are the single source of truth. Items are enabled globally and per
// project; enabled items are loaded automatically, and any item can be retrieved on demand.
//
// Built-in items ship with the harness or the application that embeds it, in folders laid out
// like `registry/`. They are read-only and on everywhere until a person switches one off; an
// item of the same id in the data root replaces the built-in one.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { invalid } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, now, readJsonOr, safeRelative } from '../core/fs'
import { findProject } from '../core/projects'
import { compareText, lines, takeChars } from '../core/text'
import * as store from '../memory/store'
import * as attachments from '../plugins/attachments'

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

/** The capability id used when this registry item is shown in the plugin catalogue. */
export function contributionId(item: Pick<RegistryItem, 'id' | 'builtin'>): string {
  return `${item.builtin ? 'included' : 'yours'}/${item.id}`
}

/** Limits registry items to the contributions frozen for a run. `undefined` means no limit. */
export function limitToContributions(items: readonly RegistryItem[], contributions?: readonly string[]): RegistryItem[] {
  if (contributions === undefined) return [...items]
  const allowed = new Set(contributions)
  return items.filter((item) => allowed.has(contributionId(item)))
}

export interface SkillBundleInput {
  name: string
  files: { path: string; content: string; encoding: 'utf8' | 'base64' }[]
}

const MAX_SKILL_BUNDLES = 20
const MAX_SKILL_FILES = 100
const MAX_SKILL_IMPORT_BYTES = 10 * 1024 * 1024

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

/** The name and description of a skill or prompt file anywhere on disk, read the way a registry item is. */
export function describeFile(file: string): { name: string; description: string } | null {
  const stem = basename(file) === 'SKILL.md' ? basename(dirname(file)) : stemOf(basename(file))
  const item = itemFrom('', stem, file)
  return item && { name: item.name, description: item.description }
}

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

/**
 * The registry's earlier enablement file as it is on disk: ids keyed by project id, or `global`
 * for everyone. The choices now live with every other plugin's (`plugins/attachments.ts`), which
 * reads this file until the first change is saved.
 */
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

/** Whether an id names a registry item, as `<kind>/<name>`. */
export const isItemId = (id: string): boolean => KINDS.some((kind) => id.startsWith(`${kind}/`))

/**
 * Items active for a caller. A built-in is on until it is switched off; a person's own is off
 * until it is switched on, everywhere, for the caller's project, or for the calling agent.
 */
export function enabledFor(root: string, projectId: string | null, agentId: string | null = null, contributions?: readonly string[]): RegistryItem[] {
  if (contributions !== undefined) return limitToContributions(list(root), contributions)
  const choices = attachments.load(root)
  return list(root).filter((item) => attachments.attached(choices, [item.id], { agentId, projectId }, !!item.builtin))
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
export function resources(root: string, projectId: string | null, agentId: string | null = null, contributions?: readonly string[]): RegistryResources {
  const items = enabledFor(root, projectId, agentId, contributions)
  return {
    ids: items.map((item) => item.id),
    skillPaths: items.filter((item) => item.kind === 'skills').map((item) => item.path),
    promptPaths: items.filter((item) => item.kind === 'prompts').map((item) => item.path)
  }
}

// Prefix of the entries an earlier version of the harness linked into a Pi agent folder's `skills/`.
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
  // A single-file skill was linked as `agentx-<name>/SKILL.md` inside a folder the harness made.
  try {
    const entries = readdirSync(path)
    return entries.length === 1 && entries[0] === 'SKILL.md' && lstatSync(join(path, 'SKILL.md')).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Removes the `agentx-<name>` links an earlier version kept in a terminal session's `skills/`
 * folder, leaving the user's own skills alone. Enabled skills now reach a session as paths.
 */
export function removeLinkedSkills(skillsDir: string): void {
  let names: string[]
  try {
    names = readdirSync(skillsDir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(skillsDir, name)
    if (!name.startsWith(LINKED_SKILL_PREFIX) || !isLinkedSkill(path)) continue
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else rmSync(path, { recursive: true, force: true })
  }
}

export interface RegistryState {
  items: RegistryItem[]
  enabled: Record<string, unknown>
}

/**
 * Enablement as a person sees it, in the earlier file's shape: ids keyed by project id, `global`
 * for everyone (built-ins that are on count as enabled everywhere), and the built-ins switched off.
 */
function shown(items: readonly RegistryItem[], choices: attachments.Attachments): Record<string, unknown> {
  const builtin = items.filter((item) => item.builtin).map((item) => item.id)
  const off = choices.global.off.filter((id) => builtin.includes(id))
  const global = choices.global.on.filter((id) => isItemId(id) && !builtin.includes(id))
  const map: Record<string, unknown> = { [GLOBAL_KEY]: [...global, ...builtin.filter((id) => !off.includes(id))] }
  for (const [projectId, entries] of Object.entries(choices.projects)) map[projectId] = entries.on.filter(isItemId)
  if (off.length) map[BUILTIN_OFF_KEY] = off
  return map
}

export function state(root: string): RegistryState {
  const items = list(root)
  return { items, enabled: shown(items, attachments.load(root)) }
}

/** Sets enabled items for a project, or globally when `projectId` is `null`. */
export function setEnabled(root: string, projectId: string | null, ids: string[]): RegistryState {
  if (projectId) findProject(root, projectId)
  const items = list(root)
  const unknown = ids.find((id) => !items.some((item) => item.id === id))
  if (unknown !== undefined) throw invalid(`Unknown registry item ${unknown}.`)
  const builtin = items.filter((item) => item.builtin).map((item) => item.id)
  const choices = attachments.load(root)
  const entries = projectId ? (choices.projects[projectId] ??= { on: [], off: [] }) : choices.global
  // Only the registry's own ids are replaced; other plugins' choices in the same scope stay.
  entries.on = [...entries.on.filter((id) => !isItemId(id)), ...ids.filter((id) => !builtin.includes(id))]
  entries.off = entries.off.filter((id) => !isItemId(id) || (!ids.includes(id) && !(!projectId && builtin.includes(id))))
  // A built-in left out of the global list was switched off.
  if (!projectId) entries.off.push(...builtin.filter((id) => !ids.includes(id)))
  attachments.save(root, choices)
  return { items, enabled: shown(items, choices) }
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

/** Imports complete user-owned skill folders without replacing existing or built-in items. */
export function importSkills(root: string, bundles: SkillBundleInput[]): RegistryState {
  return importItems(root, 'skills', bundles)
}

/** Imports inert registry resources. Prompts and rules are single UTF-8 Markdown documents. */
export function importItems(root: string, kind: RegistryKind, bundles: SkillBundleInput[]): RegistryState {
  if (!Array.isArray(bundles) || bundles.length === 0 || bundles.length > MAX_SKILL_BUNDLES) {
    throw invalid(`Import between 1 and ${MAX_SKILL_BUNDLES} skills at a time.`)
  }

  const directory = kindDir(root, kind)
  mkdirSync(directory, { recursive: true })
  const existing = new Set(list(root).map((item) => item.id))
  const seen = new Set<string>()
  let totalBytes = 0
  const prepared = bundles.map((bundle) => {
    if (!bundle || typeof bundle.name !== 'string' || !Array.isArray(bundle.files) || bundle.files.length === 0 || bundle.files.length > MAX_SKILL_FILES) {
      throw invalid('Each skill needs a name and a bounded list of files.')
    }
    const name = bundle.name.trim()
    if (name.length > 64) throw invalid('Use a skill name with at most 64 letters or numbers.')
    const slug = Array.from(name.toLowerCase(), (character) => (/^[a-z0-9]$/.test(character) ? character : '-')).join('').split('-').filter(Boolean).join('-')
    if (!slug || slug.length > 64) throw invalid('Use a skill name with at most 64 letters or numbers.')
    const id = `${kind}/${slug}`
    if (existing.has(id) || seen.has(id)) throw invalid(`The skill “${name}” already exists.`)
    try {
      lstatSync(join(directory, kind === 'skills' ? slug : `${slug}.md`))
      throw invalid(`The skill “${name}” already exists.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    seen.add(id)

    const files = new Map<string, Uint8Array>()
    for (const file of bundle.files) {
      if (!file || typeof file.path !== 'string' || file.path.length > 240 || typeof file.content !== 'string' || !['utf8', 'base64'].includes(file.encoding)) {
        throw invalid(`The skill “${name}” contains an invalid file.`)
      }
      let relative: string
      try {
        relative = safeRelative(file.path)
      } catch {
        throw invalid(`The skill “${name}” contains a path outside its folder.`)
      }
      if (relative.includes('\0') || relative.split('/').some((part) => part.startsWith('.') || part.includes(':'))) {
        throw invalid(`The skill “${name}” contains an unsupported file path.`)
      }
      const portablePath = relative.normalize('NFC').toLowerCase()
      if ([...files.keys()].some((path) => path.normalize('NFC').toLowerCase() === portablePath)) throw invalid(`The skill “${name}” contains a duplicate file path.`)
      let byteLength: number
      if (file.encoding === 'base64') {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
          throw invalid(`The file “${relative}” is not valid base64.`)
        }
        if (file.content.length > Math.ceil(MAX_SKILL_IMPORT_BYTES / 3) * 4) throw invalid('The skill import is larger than 10 MiB.')
        byteLength = Math.floor(file.content.length * 3 / 4) - (file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0)
      } else {
        byteLength = Buffer.byteLength(file.content, 'utf8')
      }
      totalBytes += byteLength
      if (totalBytes > MAX_SKILL_IMPORT_BYTES) throw invalid('The skill import is larger than 10 MiB.')
      const bytes = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8')
      if (file.encoding === 'base64' && bytes.toString('base64') !== file.content) throw invalid(`The file “${relative}” is not valid base64.`)
      files.set(relative, bytes)
    }
    if (kind === 'skills' && !files.has('SKILL.md')) throw invalid(`The skill “${name}” must include SKILL.md at its root.`)
    if (kind !== 'skills' && (bundle.files.length !== 1 || bundle.files[0].encoding !== 'utf8' || bundle.files[0].path !== 'CONTENT.md')) throw invalid('A prompt or rule must contain one UTF-8 CONTENT.md file.')
    return { name, slug, files }
  })

  const staging = mkdtempSync(join(directory, '.agent-template-import-'))
  const installed: string[] = []
  try {
    for (const bundle of prepared) {
      const target = join(staging, bundle.slug)
      for (const [relative, bytes] of bundle.files) {
        const path = join(target, ...relative.split('/'))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes, { flag: 'wx' })
      }
    }
    for (const bundle of prepared) {
      const target = join(directory, kind === 'skills' ? bundle.slug : `${bundle.slug}.md`)
      renameSync(kind === 'skills' ? join(staging, bundle.slug) : join(staging, bundle.slug, 'CONTENT.md'), target)
      installed.push(target)
    }
  } catch (error) {
    for (const target of installed) rmSync(target, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return state(root)
}

/**
 * Writes a skill, prompt, or rule (an accepted proposal), keeping an existing item's location.
 * The previous content and the new content are recorded as Wiki revisions of the item.
 */
export function writeItem(root: string, kind: string, name: string, description: string, body: string, reason: string, actor = 'user'): string {
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
      store.snapshot(wiki, id, readFileSync(existing.path, 'utf8'), actor, 'Before accepted proposal')
    } catch {
      // Nothing readable to keep.
    }
  }
  atomicWrite(path, text)
  store.snapshot(wiki, id, text, actor, reason)
  store.log(wiki, `- ${now()} · ${actor} · ${existing ? 'updated' : 'created'} \`${id}\` · ${reason}`)
  return id
}
