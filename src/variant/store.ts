// Versioned variants. Each scope (an opaque id the application chooses, such as one per
// agent) has content-addressed versions, a head, and a lineage that says where each version came
// from. A run uses the head it started with; a change makes a new version and never edits one.
//
//   <data>/variants/<scope>/versions/<fingerprint>/variant/<rel>
//   <data>/variants/<scope>/versions/<fingerprint>/version.json
//   <data>/variants/<scope>/head.json
//   <data>/variants/<scope>/lineage.jsonl
//   <data>/variants/<scope>/tags.json        name → fingerprint; labels, never versions
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import { appendLine, now, readJson, readText, safeId, writeJson } from '../core/fs'
import { PI_SURFACE, componentOf, type ComponentId, type SurfaceSpec, type Variant } from './surface'
import { diffSummary, readVariant, validate, writeVariant, type VariantCensus, type VariantDiff, type ValidateOptions } from './variant'

/** A stable digest of a variant: the same files with the same text give the same value. */
export function fingerprint(variant: Variant): string {
  const hash = createHash('sha1')
  for (const rel of Object.keys(variant).sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(variant[rel]!)
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

export type VersionSource =
  | { kind: 'seed'; note?: string }
  | { kind: 'edit'; note?: string; components?: string[] }
  | { kind: 'refinement'; refineId: string; label: string; note?: string }
  | { kind: 'import'; note?: string }
  | { kind: 'restore'; from: string; note?: string }

export interface VersionRecord {
  fingerprint: string
  parent: string | null
  source: VersionSource
  createdAt: string
  census: VariantCensus
  /** The model the executions ran on when a refinement produced this version. */
  tunedFor?: { model: string } | null
}

/** A version as lineage reports it: its record and the tags that name it now. */
export type LineageEntry = VersionRecord & { tags: string[] }

export interface Head {
  fingerprint: string
  updatedAt: string
}

export function variantsDir(root: string): string {
  return join(root, 'variants')
}

function scopeDir(root: string, scope: string): string {
  return join(variantsDir(root), safeId(scope))
}

function versionDir(root: string, scope: string, fp: string): string {
  if (!/^[0-9a-f]{16}$/.test(fp)) throw invalid('Invalid harness version.')
  return join(scopeDir(root, scope), 'versions', fp)
}

export function scopes(root: string): string[] {
  try {
    return readdirSync(variantsDir(root), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

export function head(root: string, scope: string): Head | null {
  return readJson<Head>(join(scopeDir(root, scope), 'head.json'))
}

export function exists(root: string, scope: string, fp: string): boolean {
  return existsSync(join(versionDir(root, scope, fp), 'version.json'))
}

export function readVersion(root: string, scope: string, fp: string, surface: SurfaceSpec = PI_SURFACE): Variant {
  const dir = join(versionDir(root, scope, fp), 'variant')
  if (!existsSync(dir)) throw notFound('That harness version')
  return readVariant(surface, dir)
}

export function versionRecord(root: string, scope: string, fp: string): VersionRecord | null {
  return readJson<VersionRecord>(join(versionDir(root, scope, fp), 'version.json'))
}

/** Where a version's files are on disk, for a run that loads them. */
export function versionPath(root: string, scope: string, fp: string): string {
  return join(versionDir(root, scope, fp), 'variant')
}

/** The head variant, or null when the scope has none yet. */
export function headVariant(root: string, scope: string, surface: SurfaceSpec = PI_SURFACE): { fingerprint: string; variant: Variant } | null {
  const current = head(root, scope)
  return current ? { fingerprint: current.fingerprint, variant: readVersion(root, scope, current.fingerprint, surface) } : null
}

/** Every version recorded for a scope, newest first. */
export function lineage(root: string, scope: string): LineageEntry[] {
  const text = readText(join(scopeDir(root, scope), 'lineage.jsonl')) ?? ''
  const named = tagsByVersion(root, scope)
  const out: LineageEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as VersionRecord
      out.push({ ...record, tags: named.get(record.fingerprint) ?? [] })
    } catch {
      // A torn final line is skipped; the version files are the record.
    }
  }
  return out.reverse()
}

export interface CommitOptions {
  /** Move the head to the new version (the default). */
  moveHead?: boolean
  surface?: SurfaceSpec
  validate?: ValidateOptions
  /** Recorded on a new version only; an existing version is never edited. */
  tunedFor?: { model: string } | null
}

/**
 * Saves `variant` as a version of `scope`. An invalid variant is refused with every problem listed.
 * Saving a variant that already exists records nothing new but can still move the head.
 */
export function commit(root: string, scope: string, variant: Variant, source: VersionSource, options: CommitOptions = {}): VersionRecord {
  const surface = options.surface ?? PI_SURFACE
  let census: VariantCensus
  try {
    census = validate(surface, variant, options.validate)
  } catch (error) {
    throw new HarnessError('variant_invalid', error instanceof Error ? error.message : String(error), 'Fix the listed problems and save again.')
  }
  const fp = fingerprint(variant)
  const parent = head(root, scope)?.fingerprint ?? null
  let record = versionRecord(root, scope, fp)
  if (!record) {
    writeVariant(surface, variant, join(versionDir(root, scope, fp), 'variant'), { stubs: false })
    record = { fingerprint: fp, parent, source, createdAt: now(), census, ...(options.tunedFor?.model ? { tunedFor: { model: options.tunedFor.model } } : {}) }
    writeJson(join(versionDir(root, scope, fp), 'version.json'), record)
    appendLine(join(scopeDir(root, scope), 'lineage.jsonl'), JSON.stringify(record))
  }
  if (options.moveHead !== false) writeJson(join(scopeDir(root, scope), 'head.json'), { fingerprint: fp, updatedAt: now() } satisfies Head)
  return record
}

/** Gives a scope its first version, unless it already has a head. */
export function seed(root: string, scope: string, variant: Variant, note?: string, surface: SurfaceSpec = PI_SURFACE): Head {
  const current = head(root, scope)
  if (current) return current
  commit(root, scope, variant, { kind: 'seed', note }, { surface })
  return head(root, scope)!
}

/** Points the head at an earlier version. The version must exist. */
export function restore(root: string, scope: string, fp: string, note?: string): Head {
  if (!exists(root, scope, fp)) throw notFound('That harness version')
  const from = head(root, scope)?.fingerprint ?? fp
  writeJson(join(scopeDir(root, scope), 'head.json'), { fingerprint: fp, updatedAt: now() } satisfies Head)
  appendLine(join(scopeDir(root, scope), 'restores.jsonl'), JSON.stringify({ to: fp, from, note: note ?? null, at: now() }))
  return head(root, scope)!
}

export interface FileDiff {
  path: string
  before: string | null
  after: string | null
}

/** What changed between two versions, file by file. */
export function compare(root: string, scope: string, from: string, to: string, surface: SurfaceSpec = PI_SURFACE): { summary: VariantDiff; files: FileDiff[] } {
  const a = readVersion(root, scope, from, surface)
  const b = readVersion(root, scope, to, surface)
  const summary = diffSummary(surface, a, b)
  const files = [...summary.added, ...summary.removed, ...summary.modified].sort().map((path) => ({ path, before: a[path] ?? null, after: b[path] ?? null }))
  return { summary, files }
}

/** Reads a variant folder made outside the harness, such as an export or a hand-written one. */
export function importFolder(dir: string, surface: SurfaceSpec = PI_SURFACE): { variant: Variant; rejected: string[] } {
  const rejected: string[] = []
  const variant = readVariant(surface, dir, rejected)
  return { variant, rejected }
}

/** Reads one file of a variant on disk; used by callers that only need one component. */
export function readComponentFile(root: string, scope: string, fp: string, rel: string): string | null {
  try {
    return readFileSync(join(versionPath(root, scope, fp), rel), 'utf8')
  } catch {
    return null
  }
}

// ---- Tags: names a person gives versions. A tag is a label that can move; a version never changes.

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function tagsFile(root: string, scope: string): string {
  return join(scopeDir(root, scope), 'tags.json')
}

/** Every tag of a scope, name → fingerprint. */
export function tags(root: string, scope: string): Record<string, string> {
  return readJson<Record<string, string>>(tagsFile(root, scope)) ?? {}
}

function tagsByVersion(root: string, scope: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [name, fp] of Object.entries(tags(root, scope)).sort(([a], [b]) => a.localeCompare(b))) out.set(fp, [...(out.get(fp) ?? []), name])
  return out
}

/** Refuses a name that cannot be a tag. */
export function checkTagName(name: string): string {
  if (!TAG.test(name)) throw invalid('A tag is 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit.')
  if (/^[0-9a-f]{4,16}$/.test(name) || name === 'head') throw invalid('A tag cannot look like a version fingerprint or be `head`.')
  return name
}

/** Names a version. A tag already in use moves to this version. */
export function tag(root: string, scope: string, name: string, fp: string): Record<string, string> {
  checkTagName(name)
  if (!exists(root, scope, fp)) throw notFound('That harness version')
  const next = { ...tags(root, scope), [name]: fp }
  writeJson(tagsFile(root, scope), next)
  return next
}

export function untag(root: string, scope: string, name: string): Record<string, string> {
  const next = { ...tags(root, scope) }
  delete next[name]
  writeJson(tagsFile(root, scope), next)
  return next
}

/** A fingerprint, a tag, or `head`, as the fingerprint it names. */
export function resolveRef(root: string, scope: string, ref: string): string {
  if (ref === 'head') {
    const current = head(root, scope)
    if (!current) throw invalid(`The variant '${scope}' has no version yet.`)
    return current.fingerprint
  }
  if (/^[0-9a-f]{16}$/.test(ref)) {
    if (!exists(root, scope, ref)) throw notFound('That harness version')
    return ref
  }
  const named = tags(root, scope)[ref]
  if (named) return named
  const matches = /^[0-9a-f]{4,15}$/.test(ref) ? lineage(root, scope).filter((entry) => entry.fingerprint.startsWith(ref)) : []
  if (matches.length === 1) return matches[0]!.fingerprint
  if (matches.length > 1) throw invalid(`'${ref}' matches more than one version; give more characters.`)
  throw notFound(`The version or tag '${ref}'`)
}

// ---- Reverting part of a variant

const COMPONENT_ALIASES: Record<string, ComponentId> = {
  c1: 'systemPrompt', c2: 'guardrails', c3: 'memory', c4: 'toolGuidance', c5: 'subagents', c6: 'skills', c7: 'scripts', c8: 'plugins'
}

/**
 * Whether a selector names a path. A selector is a component (`c4` or `toolGuidance`) or one item
 * by its path prefix (`skills/review`, `sub_agents/reader`, `scripts/check.py`, `plugins/guard.ts`).
 */
export function selects(surface: SurfaceSpec, selector: string, rel: string): boolean {
  const component = COMPONENT_ALIASES[selector.toLowerCase()] ?? surface.components.find((entry) => entry.id === selector)?.id
  if (component) return componentOf(surface, rel) === component
  const prefix = selector.replace(/\/+$/, '')
  return rel === prefix || rel.startsWith(`${prefix}/`)
}

/**
 * Makes a new version from the head with the selected components taken from version `from`:
 * what the head has there is dropped, what `from` has there is copied. The result is validated
 * like any other edit, and the head moves to it.
 */
export function revertComponents(root: string, scope: string, from: string, selectors: string[], note?: string, surface: SurfaceSpec = PI_SURFACE): VersionRecord {
  if (!selectors.length) throw invalid('Name at least one component to revert, such as c4 or skills/review.')
  const current = headVariant(root, scope, surface)
  if (!current) throw invalid(`The variant '${scope}' has no version yet.`)
  const source = readVersion(root, scope, from, surface)
  const matched = (selector: string) => [...Object.keys(current.variant), ...Object.keys(source)].some((rel) => selects(surface, selector, rel))
  const unknown = selectors.filter((selector) => !matched(selector))
  if (unknown.length) throw invalid(`Nothing in either version matches: ${unknown.join(', ')}.`)
  const picked = (rel: string) => selectors.some((selector) => selects(surface, selector, rel))
  const next: Variant = {}
  for (const [rel, body] of Object.entries(current.variant)) if (!picked(rel)) next[rel] = body
  for (const [rel, body] of Object.entries(source)) if (picked(rel)) next[rel] = body
  return commit(root, scope, next, { kind: 'edit', components: selectors, note: note ?? `revert ${selectors.join(', ')} from ${from}` }, { surface })
}
