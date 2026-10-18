// The Wiki's rows in the index: full-text entries, links, sources, and revisions, all derived
// from the canonical files.
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import { logLine } from '../core/bus'
import { all, dbPath, deleteIndex, ftsQuery, run, transaction, withIndex } from '../core/index'
import { readAllRuns, syncRuns, upsertRun } from '../sessions/runIndex'
import { scan } from './wiki'

/** Replaces every Wiki row from canonical files. Returns the number of pages indexed. */
export function indexWiki(database: DatabaseSync, root: string): number {
  const { entries, sources } = scan(root)
  transaction(database, () => {
    for (const table of ['entries', 'entries_fts', 'links', 'sources', 'revisions']) database.exec(`DELETE FROM ${table}`)
    for (const entry of entries) {
      run(
        database,
        'INSERT OR REPLACE INTO entries (id, kind, title, type, path, namespace, file, updated_at, source_ids) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
        entry.id,
        entry.kind,
        entry.title,
        entry.entryType,
        entry.path,
        entry.namespace,
        entry.file,
        entry.updatedAt,
        JSON.stringify(entry.sourceIds)
      )
      const sourceNames = entry.sourceIds.flatMap((id) => sources.find((source) => source.id === id)?.name ?? [])
      run(
        database,
        'INSERT INTO entries_fts (id, kind, namespace, title, body, links, sources) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
        entry.id,
        entry.kind,
        entry.namespace,
        entry.title,
        entry.body,
        entry.links.map(([to]) => to).join(' '),
        `${entry.path.replaceAll('/', ' ')} ${entry.sourceIds.join(' ')} ${sourceNames.join(' ')}`
      )
      for (const [to, type] of entry.links) run(database, 'INSERT INTO links (from_id, to_id, type) VALUES (?1, ?2, ?3)', entry.id, to, type)
      for (const [id, createdAt, actor] of entry.revisions) run(database, 'INSERT OR REPLACE INTO revisions (entry_id, id, created_at, actor) VALUES (?1, ?2, ?3, ?4)', entry.id, id, createdAt, actor)
    }
    for (const source of sources) run(database, 'INSERT OR REPLACE INTO sources (id, name, imported_at, version) VALUES (?1, ?2, ?3, ?4)', source.id, source.name, source.importedAt, source.version)
  })
  return entries.filter((entry) => entry.kind === 'page').length
}

export function reindexWiki(root: string): number {
  return withIndex(root, (database) => indexWiki(database, root))
}

/** `reindexWiki` for callers that must not fail because the index is unavailable. */
export function reindexQuietly(root: string): void {
  try {
    reindexWiki(root)
  } catch (error) {
    logLine(`[index] reindex failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Deletes the index and rebuilds it from canonical files. Returns pages indexed. */
export function rebuild(root: string): number {
  deleteIndex(root)
  return withIndex(root, (database) => {
    const pages = indexWiki(database, root)
    const records = readAllRuns(root)
    transaction(database, () => records.forEach((record) => upsertRun(database, record)))
    return pages
  })
}

/**
 * Builds the index when it is missing and otherwise refreshes the Wiki rows, which also
 * catches edits made while nothing was running. `after` runs last, whatever happened before it.
 */
export function ensure(root: string, after?: () => void): number {
  let pages: number
  if (existsSync(dbPath(root))) {
    pages = reindexWiki(root)
    try {
      syncRuns(root)
    } catch (error) {
      logLine(`[index] ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    pages = rebuild(root)
  }
  after?.()
  return pages
}

/**
 * Ranked entry ids across the whole Wiki (best match first). Entries in `boostNamespace`
 * rank higher; nothing is filtered out by namespace here.
 */
export function search(root: string, query: string, limit: number, boostNamespace: string | null): string[] {
  const fts = ftsQuery(query)
  if (!fts) return []
  return withIndex(root, (database) =>
    all<{ id: string }>(
      database,
      `SELECT id FROM entries_fts WHERE entries_fts MATCH ?1
       ORDER BY bm25(entries_fts, 0, 0, 0, 10.0, 1.0, 2.0, 2.0) * (CASE WHEN ?2 IS NOT NULL AND namespace = ?2 THEN 1.5 ELSE 1.0 END)
       LIMIT ?3`,
      fts,
      boostNamespace,
      limit
    ).map((row) => row.id)
  )
}

/** (from id, link type) for every entry linking to `entryId`. */
export function backlinks(root: string, entryId: string): [string, string][] {
  return withIndex(root, (database) => all<{ from_id: string; type: string }>(database, 'SELECT from_id, type FROM links WHERE to_id = ?1 ORDER BY from_id', entryId).map((row) => [row.from_id, row.type]))
}
