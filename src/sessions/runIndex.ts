// Run metadata in the index: which runs a session, an agent, or an account has, without
// reading every run folder.
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { readJson } from '../core/fs'
import { all, run as execute, runFolders, transaction, withIndex } from '../core/index'
import { runRecordSchema, type RunRecord } from './contracts'

export function upsertRun(database: DatabaseSync, record: RunRecord): void {
  execute(
    database,
    `INSERT OR REPLACE INTO runs (id, project_id, mode, harness, session_type, session_id, status, started_at, ended_at, account_id, agent_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    record.id,
    record.projectId,
    record.mode,
    record.harness,
    record.sessionType,
    record.sessionId,
    record.status,
    record.startedAt,
    record.endedAt,
    record.accountId,
    record.agentId
  )
}

/** Index failures never block a run. */
export function recordRun(root: string, record: RunRecord): void {
  try {
    withIndex(root, (database) => upsertRun(database, record))
  } catch {
    // The index is rebuilt from run files when it is next repaired.
  }
}

/** Every readable run record under `<data root>/runs`. */
export function readAllRuns(root: string): RunRecord[] {
  const records: RunRecord[] = []
  for (const name of runFolders(root)) {
    try {
      const parsed = runRecordSchema.safeParse(readJson(join(root, 'runs', name, 'run.json')))
      if (parsed.success) records.push(parsed.data)
    } catch {
      // Not a run folder.
    }
  }
  return records
}

/**
 * Adds the runs the table is missing, and those whose status changed, from the run files. A run
 * recorded while the index was unavailable would otherwise be absent from session history.
 */
export function syncRuns(root: string): number {
  const known = new Map<string, { status: string | null; agentId: string | null }>()
  withIndex(root, (database) => {
    for (const row of all<{ id: string; status: string | null; agent_id: string | null }>(database, 'SELECT id, status, agent_id FROM runs')) known.set(row.id, { status: row.status, agentId: row.agent_id })
  })
  // A row is rewritten when its status changed, or when it predates the agent column.
  const pending = readAllRuns(root).filter((record) => {
    const row = known.get(record.id)
    return !row || row.status !== record.status || (row.agentId === null && record.agentId !== null)
  })
  if (!pending.length) return 0
  withIndex(root, (database) => transaction(database, () => pending.forEach((record) => upsertRun(database, record))))
  return pending.length
}

export function runsForSession(root: string, sessionId: string, limit: number): string[] {
  return withIndex(root, (database) => all<{ id: string }>(database, 'SELECT id FROM runs WHERE session_id = ?1 ORDER BY started_at DESC LIMIT ?2', sessionId, limit).map((row) => row.id))
}

/** Which runs to read: one session's, one agent's wherever it replied, one account's, or all. */
export interface RunFilter {
  session?: string | null
  agent?: string | null
  account?: string | null
}

/** Runs matching `filter` started at or after `since` (an RFC 3339 instant), oldest first. */
export function runsSince(root: string, filter: RunFilter, since: string | null): string[] {
  return withIndex(root, (database) =>
    // A chat run recorded before the agent column belongs to the agent whose own session it ran in.
    all<{ id: string }>(
      database,
      `SELECT id FROM runs WHERE started_at >= ?1
          AND (?2 IS NULL OR session_id = ?2)
          AND (?3 IS NULL OR agent_id = ?3 OR (agent_id IS NULL AND mode = 'chat' AND session_id = ?3))
          AND (?4 IS NULL OR account_id = ?4)
       ORDER BY started_at`,
      since ?? '',
      filter.session ?? null,
      filter.agent ?? null,
      filter.account ?? null
    ).map((row) => row.id)
  )
}
