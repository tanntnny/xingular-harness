// Storage migration to version 3: memory blocks, facts, and the Library.
//
// Version 3 starts from an empty Wiki. Whatever came before is kept whole as a backup and is
// not carried over: a version 2 `wiki/` becomes `wiki.pre-v3/`, and a version 1 `knowledge/`
// becomes `knowledge.pre-v2/`. The new tree is staged in `wiki.migrating/` before anything is
// renamed; on failure the staged tree is removed and the earlier Wiki is left in place.
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { HarnessEnv } from '../core/env'
import { HarnessError } from '../core/errors'
import { now, readJsonOr, writeJson } from '../core/fs'
import { listProjects } from '../core/projects'
import * as registry from '../skills/registry'
import * as blocks from './blocks'
import { writeIndex } from './proposals'
import * as store from './store'

export const WIKI_VERSION = 3

const storagePath = (root: string): string => join(root, 'config/storage.json')

export function version(root: string): number {
  const stored = readJsonOr<{ wikiVersion?: unknown } | null>(storagePath(root), null)?.wikiVersion
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 0) return stored
  const wiki = store.wikiDir(root)
  if (store.isDir(join(root, 'knowledge'))) return 1
  // A version 2 Wiki whose marker is missing still has its old folders and no blocks.
  if (!existsSync(join(wiki, 'blocks')) && (store.isDir(join(wiki, 'docs')) || store.isDir(join(wiki, 'memory')))) return 2
  return WIKI_VERSION
}

const stamp = (): string => now().replace(/[:.]/g, '-')

/** Moves `from` to `<name>` beside it, or `<name>-<time>` when that backup already exists. */
function backUp(root: string, from: string, name: string): void {
  if (!existsSync(from)) return
  renameSync(from, existsSync(join(root, name)) ? join(root, `${name}-${stamp()}`) : join(root, name))
}

/**
 * Brings a data root to the current Wiki layout. Safe to call on every start. `agentIds` are
 * the agents that get their own blocks. Returns whether a migration happened.
 */
export function run(env: HarnessEnv, agentIds: readonly string[] = []): boolean {
  const { root } = env
  if (version(root) >= WIKI_VERSION) return false
  const failed = (detail: string): HarnessError => new HarnessError('migration_failed', `The Wiki was not migrated to version 3; your Wiki is unchanged. ${detail}`)
  const staging = join(root, 'wiki.migrating')
  rmSync(staging, { recursive: true, force: true })
  try {
    store.ensureLayoutAt(staging, env.productName)
    blocks.ensureUser(staging)
    for (const agentId of agentIds) blocks.ensureAgent(staging, agentId)
    for (const project of listProjects(root)) blocks.ensureProject(staging, project.slug, project.name)
    store.log(staging, `- ${now()} · ${env.productName} · started storage version 3; the earlier Wiki is kept as a backup beside it`)
    backUp(root, store.wikiDir(root), 'wiki.pre-v3')
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw failed(error instanceof Error ? error.message : String(error))
  }
  renameSync(staging, store.wikiDir(root))
  backUp(root, join(root, 'knowledge'), 'knowledge.pre-v2')

  store.ensureLayout(root, env.productName)
  for (const project of listProjects(root)) store.ensureProjectNamespace(root, project.slug, project.name)
  // Registry items that version 1 enabled for personal agents are enabled for everyone.
  const enablement = registry.enablement(root)
  if ('personal' in enablement) {
    const ids = registry.enablementIds(enablement, registry.GLOBAL_KEY)
    for (const id of registry.enablementIds(enablement, 'personal')) if (!ids.includes(id)) ids.push(id)
    delete enablement.personal
    enablement[registry.GLOBAL_KEY] = ids
    writeJson(join(root, 'config/registry-enabled.json'), enablement)
  }
  writeIndex(store.wikiDir(root))
  writeJson(storagePath(root), { wikiVersion: WIKI_VERSION, migratedAt: now() })
  return true
}
