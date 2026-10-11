// What a run was given and what it read: every Wiki entry a run uses is recorded in
// `runs/<id>/wiki-context.json`, so a person can see what informed a reply.
import { join } from 'node:path'

import { now, readJsonOr, safeId, writeJson } from '../core/fs'
import { runsForSession } from '../sessions/runIndex'
import type { CallerContext } from './caller'
import * as store from './store'

/** An entry and the revision that was current when it was used. */
export interface Source {
  id: string
  kind: string
  revision: string | null
}

export interface ContextEntry {
  id: string
  kind: string
  revisionId: string | null
  /** `entrypoint`, `search`, `read`, `skill`, `memory`, or `edit` (an entry the run changed). */
  via: string
  at: string
}

export function contextPath(root: string, runId: string): string {
  return join(root, 'runs', safeId(runId), 'wiki-context.json')
}

export function readRunContext(root: string, runId: string): ContextEntry[] {
  return readJsonOr<ContextEntry[]>(contextPath(root, runId), [])
}

/** The blocks, facts, and pages these runs changed, without repeats: `[id, kind]`. */
export function editedBy(root: string, runIds: readonly string[]): [string, string][] {
  const edited: [string, string][] = []
  for (const runId of runIds) {
    let entries: ContextEntry[]
    try {
      entries = readRunContext(root, runId)
    } catch {
      continue
    }
    for (const entry of entries) if (entry.via === 'edit' && !edited.some(([id]) => id === entry.id)) edited.push([entry.id, entry.kind])
  }
  return edited
}

/** The run a call belongs to: the caller's run, else the session's latest run. */
function runOf(root: string, context: CallerContext): string | null {
  if (context.runId) return context.runId
  if (!context.sessionId) return null
  try {
    return runsForSession(root, context.sessionId, 1)[0] ?? null
  } catch {
    return null
  }
}

export function recordSources(root: string, context: CallerContext, via: string, sources: readonly Source[]): void {
  const runId = runOf(root, context)
  if (!runId || !sources.length) return
  let path: string
  try {
    path = contextPath(root, runId)
  } catch {
    return
  }
  if (!store.isDir(join(root, 'runs', runId))) return
  const recorded = readRunContext(root, runId)
  for (const source of sources) {
    if (!recorded.some((entry) => entry.id === source.id && entry.revisionId === source.revision && entry.via === via)) {
      recorded.push({ id: source.id, kind: source.kind, revisionId: source.revision, via, at: now() })
    }
  }
  try {
    writeJson(path, recorded)
  } catch {
    // A record that cannot be written never fails the call it describes.
  }
}

/** `recordSources` for entries at their current revision: `[id, kind]`. */
export function record(root: string, context: CallerContext, via: string, entries: readonly [string, string][]): void {
  const wiki = store.wikiDir(root)
  recordSources(root, context, via, entries.map(([id, kind]) => ({ id, kind, revision: store.currentRevision(wiki, id) })))
}

/** `[id@revision]`, the citation form every reply uses. */
export function cite(wiki: string, id: string): string {
  const revision = store.currentRevision(wiki, id)
  return revision ? `[${id}@${revision.slice(0, 8)}]` : `[${id}]`
}
