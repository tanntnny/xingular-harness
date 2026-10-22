// The component library: skills, rules and prompts kept as files under `<data>/registry/`, and
// any built-in ones an application ships in folders laid out the same way. Nothing here reaches
// a session by itself: a person adds an item to a variant, where it becomes a skill (c6) or
// guardrail text (c2). The Hub installs into this library.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { isDir, safeRelative } from '../core/fs'
import { compareText, lines, takeChars } from '../core/text'
import { GUARDRAILS, PI_SURFACE, type Variant } from './surface'
import { autotrigger } from './variant'

export const KINDS = ['skills', 'prompts', 'rules'] as const
export type ComponentKind = (typeof KINDS)[number]

export interface ComponentItem {
  /** `<kind>/<name>`, stable across edits. */
  id: string
  kind: string
  name: string
  description: string
  path: string
  /** Set on an item that ships with the application. */
  builtin?: true
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

const kindDir = (root: string, kind: string): string => join(root, 'registry', kind)

function itemFrom(kind: string, stem: string, file: string): ComponentItem | null {
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

function itemsIn(directory: string): ComponentItem[] {
  const items: ComponentItem[] = []
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
      const file = isDir(path) ? join(path, 'SKILL.md') : name.endsWith('.md') ? path : null
      const item = file && itemFrom(kind, stem, file)
      if (item) items.push(item)
    }
  }
  return items
}

export function list(root: string): ComponentItem[] {
  const items = new Map<string, ComponentItem>()
  for (const directory of builtinDirs) for (const item of itemsIn(directory)) items.set(item.id, { ...item, builtin: true })
  for (const item of itemsIn(join(root, 'registry'))) items.set(item.id, item)
  return [...items.values()].sort((left, right) => compareText(left.id, right.id))
}

/** A variant with one library item added: a skill as `skills/<name>/` with its files, a rule as guardrail text. */
function skillName(item: ComponentItem): string {
  const slug = basename(item.path) === 'SKILL.md' ? basename(dirname(item.path)) : basename(item.path).replace(/\.md$/, '')
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '') || 'skill'
}

/** Whether a library skill or rule already has a corresponding entry in a variant. */
export function isInVariant(root: string, variant: Variant, id: string): boolean {
  const item = list(root).find((candidate) => candidate.id === id)
  if (!item) return false
  if (item.kind === 'skills') return variant['skills/' + skillName(item) + '/SKILL.md'] !== undefined
  if (item.kind === 'rules') {
    const text = readFileSync(item.path, 'utf8')
    const body = (frontmatter.parse(text)?.body ?? text).trim()
    return Boolean(body) && (variant[GUARDRAILS] ?? '').includes(body)
  }
  return false
}

export function addToVariant(root: string, variant: Variant, id: string): Variant {
  const item = list(root).find((candidate) => candidate.id === id)
  if (!item) throw notFound('That library item')
  const next: Variant = { ...variant }
  const text = readFileSync(item.path, 'utf8')
  const body = (frontmatter.parse(text)?.body ?? text).trim()
  if (item.kind === 'rules') {
    const current = (next[GUARDRAILS] ?? '').trimEnd()
    next[GUARDRAILS] = `${current ? `${current}\n\n` : ''}${body}\n`
    return next
  }
  if (item.kind !== 'skills') throw invalid('Only skills and rules can be added to a harness; prompts stay in the library.')
  const name = skillName(item)
  next[`skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: ${(item.description || `the ${name} workflow applies`).replace(/\n/g, ' ')}\n---\n${body}\n`
  // A folder skill's helpers travel with it.
  const folder = dirname(item.path)
  if (basename(item.path) === 'SKILL.md' && isDir(join(folder, 'scripts'))) {
    for (const file of readdirSync(join(folder, 'scripts'))) next[`skills/${name}/scripts/${file}`] = readFileSync(join(folder, 'scripts', file), 'utf8')
  }
  autotrigger(PI_SURFACE, next)
  return next
}

/** Imports inert registry resources. Prompts and rules are single UTF-8 Markdown documents. */
export function importItems(root: string, kind: ComponentKind, bundles: SkillBundleInput[]): ComponentItem[] {
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
  return list(root)
}

