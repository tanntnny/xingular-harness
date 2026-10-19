// Versioned harness trees. Each scope (an opaque id the application chooses, such as one per
// agent) has content-addressed versions, a head, and a lineage that says where each version came
// from. A run uses the head it started with; a change makes a new version and never edits one.
//
//   <data>/harnesses/<scope>/versions/<fingerprint>/tree/<rel>
//   <data>/harnesses/<scope>/versions/<fingerprint>/version.json
//   <data>/harnesses/<scope>/head.json
//   <data>/harnesses/<scope>/lineage.jsonl
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import { appendLine, now, readJson, readText, safeId, writeJson } from '../core/fs'
import { PI_SURFACE, type SurfaceSpec, type Tree } from './surface'
import { diffSummary, readTree, validate, writeTree, type TreeCensus, type TreeDiff, type ValidateOptions } from './tree'

/** A stable digest of a tree: the same files with the same text give the same value. */
export function fingerprint(tree: Tree): string {
  const hash = createHash('sha1')
  for (const rel of Object.keys(tree).sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(tree[rel]!)
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
  census: TreeCensus
}

export interface Head {
  fingerprint: string
  updatedAt: string
}

export function harnessesDir(root: string): string {
  return join(root, 'harnesses')
}

function scopeDir(root: string, scope: string): string {
  return join(harnessesDir(root), safeId(scope))
}

function versionDir(root: string, scope: string, fp: string): string {
  if (!/^[0-9a-f]{16}$/.test(fp)) throw invalid('Invalid harness version.')
  return join(scopeDir(root, scope), 'versions', fp)
}

export function scopes(root: string): string[] {
  try {
    return readdirSync(harnessesDir(root), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
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

export function readVersion(root: string, scope: string, fp: string, surface: SurfaceSpec = PI_SURFACE): Tree {
  const dir = join(versionDir(root, scope, fp), 'tree')
  if (!existsSync(dir)) throw notFound('That harness version')
  return readTree(surface, dir)
}

export function versionRecord(root: string, scope: string, fp: string): VersionRecord | null {
  return readJson<VersionRecord>(join(versionDir(root, scope, fp), 'version.json'))
}

/** Where a version's files are on disk, for a run that loads them. */
export function versionPath(root: string, scope: string, fp: string): string {
  return join(versionDir(root, scope, fp), 'tree')
}

/** The head tree, or null when the scope has none yet. */
export function headTree(root: string, scope: string, surface: SurfaceSpec = PI_SURFACE): { fingerprint: string; tree: Tree } | null {
  const current = head(root, scope)
  return current ? { fingerprint: current.fingerprint, tree: readVersion(root, scope, current.fingerprint, surface) } : null
}

/** Every version recorded for a scope, newest first. */
export function lineage(root: string, scope: string): VersionRecord[] {
  const text = readText(join(scopeDir(root, scope), 'lineage.jsonl')) ?? ''
  const out: VersionRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as VersionRecord)
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
}

/**
 * Saves `tree` as a version of `scope`. An invalid tree is refused with every problem listed.
 * Saving a tree that already exists records nothing new but can still move the head.
 */
export function commit(root: string, scope: string, tree: Tree, source: VersionSource, options: CommitOptions = {}): VersionRecord {
  const surface = options.surface ?? PI_SURFACE
  let census: TreeCensus
  try {
    census = validate(surface, tree, options.validate)
  } catch (error) {
    throw new HarnessError('harness_invalid', error instanceof Error ? error.message : String(error), 'Fix the listed problems and save again.')
  }
  const fp = fingerprint(tree)
  const parent = head(root, scope)?.fingerprint ?? null
  let record = versionRecord(root, scope, fp)
  if (!record) {
    writeTree(surface, tree, join(versionDir(root, scope, fp), 'tree'), { stubs: false })
    record = { fingerprint: fp, parent, source, createdAt: now(), census }
    writeJson(join(versionDir(root, scope, fp), 'version.json'), record)
    appendLine(join(scopeDir(root, scope), 'lineage.jsonl'), JSON.stringify(record))
  }
  if (options.moveHead !== false) writeJson(join(scopeDir(root, scope), 'head.json'), { fingerprint: fp, updatedAt: now() } satisfies Head)
  return record
}

/** Gives a scope its first version, unless it already has a head. */
export function seed(root: string, scope: string, tree: Tree, note?: string, surface: SurfaceSpec = PI_SURFACE): Head {
  const current = head(root, scope)
  if (current) return current
  commit(root, scope, tree, { kind: 'seed', note }, { surface })
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
export function compare(root: string, scope: string, from: string, to: string, surface: SurfaceSpec = PI_SURFACE): { summary: TreeDiff; files: FileDiff[] } {
  const a = readVersion(root, scope, from, surface)
  const b = readVersion(root, scope, to, surface)
  const summary = diffSummary(surface, a, b)
  const files = [...summary.added, ...summary.removed, ...summary.modified].sort().map((path) => ({ path, before: a[path] ?? null, after: b[path] ?? null }))
  return { summary, files }
}

/** Reads a tree folder made outside the harness, such as an export or a hand-written one. */
export function importFolder(dir: string, surface: SurfaceSpec = PI_SURFACE): { tree: Tree; rejected: string[] } {
  const rejected: string[] = []
  const tree = readTree(surface, dir, rejected)
  return { tree, rejected }
}

/** Reads one file of a tree on disk; used by callers that only need one component. */
export function readComponentFile(root: string, scope: string, fp: string, rel: string): string | null {
  try {
    return readFileSync(join(versionPath(root, scope, fp), rel), 'utf8')
  } catch {
    return null
  }
}
