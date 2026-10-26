// Derived SQLite index at `<data root>/index.sqlite`: full-text search over every Wiki entry
// (pages, facts, blocks, registry skills/prompts/rules), links, sources, revisions, run
// metadata, and recall passages. Markdown, raw sources, revision manifests, registry files, and
// run files stay canonical; the index can always be deleted and rebuilt from them.
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { HarnessError } from './errors'

/** Index migration 4: recall, the searchable record of conversations and runs. */
const RECALL_SCHEMA = `CREATE TABLE recall_runs (run_id TEXT PRIMARY KEY, passages INTEGER NOT NULL, status TEXT NOT NULL);
     CREATE VIRTUAL TABLE recall_fts USING fts5(run_id UNINDEXED, seq UNINDEXED, role UNINDEXED, at UNINDEXED,
        mode UNINDEXED, session_id UNINDEXED, project_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');`

/** Ordered, append-only migrations. Each runs in one transaction; the file is backed up first. */
export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `CREATE TABLE pages (scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL,
        updated_at TEXT, path TEXT NOT NULL, source_ids TEXT NOT NULL, PRIMARY KEY (scope, id));
     CREATE VIRTUAL TABLE pages_fts USING fts5(scope UNINDEXED, id UNINDEXED, title, body, links, sources,
        tokenize = 'unicode61 remove_diacritics 2');
     CREATE TABLE links (scope TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL);
     CREATE INDEX links_to ON links (scope, to_id);
     CREATE TABLE sources (scope TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, imported_at TEXT, version INTEGER,
        PRIMARY KEY (scope, id));
     CREATE TABLE revisions (scope TEXT NOT NULL, page_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT, actor TEXT,
        PRIMARY KEY (scope, id));
     CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT, mode TEXT, harness TEXT, session_type TEXT,
        session_id TEXT, status TEXT, started_at TEXT, ended_at TEXT);
     CREATE INDEX runs_session ON runs (session_id, started_at);`,
  // 2: accounts and token usage per run
  `ALTER TABLE runs ADD COLUMN account_id TEXT;
     CREATE INDEX runs_account ON runs (account_id, started_at);
     CREATE TABLE usage (run_id TEXT PRIMARY KEY, account_id TEXT, harness TEXT, model TEXT, day TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX usage_account ON usage (account_id, day);`,
  // 3: one global Wiki; entries replace per-scope pages and include facts and registry items
  `DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS links;
     DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS revisions;
     CREATE TABLE entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, type TEXT, path TEXT NOT NULL,
        namespace TEXT NOT NULL, file TEXT NOT NULL, updated_at TEXT, source_ids TEXT NOT NULL);
     CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, kind UNINDEXED, namespace UNINDEXED, title, body, links, sources,
        tokenize = 'unicode61 remove_diacritics 2');
     CREATE TABLE links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL);
     CREATE INDEX links_to ON links (to_id);
     CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, imported_at TEXT, version INTEGER);
     CREATE TABLE revisions (entry_id TEXT NOT NULL, id TEXT PRIMARY KEY, created_at TEXT, actor TEXT);
     CREATE INDEX revisions_entry ON revisions (entry_id, created_at);`,
  RECALL_SCHEMA,
  // 5: a per-run summary cache for the embedding application's analytics
  `CREATE TABLE run_stats (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, version INTEGER NOT NULL, stats TEXT NOT NULL);
     CREATE INDEX run_stats_session ON run_stats (session_id, version);`,
  // 6: the agent that replied, so one agent's runs can be read across its sessions
  `ALTER TABLE runs ADD COLUMN agent_id TEXT;
     CREATE INDEX runs_agent ON runs (agent_id, started_at);
     CREATE INDEX runs_started ON runs (started_at);`,
  // 7: the per-account usage table goes
  'DROP TABLE IF EXISTS usage;',
  // 8: the usage ledger behind `/usage:analysis`, rebuilt from each run's `usage.updated` events
  `CREATE TABLE usage_requests (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, request_index INTEGER NOT NULL,
        at TEXT NOT NULL, day TEXT NOT NULL, account_id TEXT, project_id TEXT, session_id TEXT NOT NULL,
        agent_id TEXT, mode TEXT NOT NULL, trigger TEXT, provider TEXT, model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, cost_source TEXT,
        context_tokens INTEGER, context_window INTEGER, duration_ms INTEGER, ttft_ms INTEGER,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, sequence, request_index));
     CREATE INDEX usage_at ON usage_requests (at);
     CREATE INDEX usage_day ON usage_requests (day);
     CREATE INDEX usage_account_day ON usage_requests (account_id, day);
     CREATE INDEX usage_session_day ON usage_requests (session_id, day);
     CREATE INDEX usage_model_day ON usage_requests (model, day);
     CREATE TABLE usage_indexed (run_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, rows INTEGER NOT NULL);`
]

const connections = new Map<string, DatabaseSync>()

export function dbPath(root: string): string {
  return join(root, 'index.sqlite')
}

function sqlError(error: unknown): HarnessError {
  return new HarnessError('index_error', error instanceof Error ? error.message : String(error), 'Settings → Projects and Storage → Repair index.')
}

function schemaVersion(database: DatabaseSync): number {
  database.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
  const row = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
  const version = Number.parseInt(row?.value ?? '', 10)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

/** Runs `work` inside one transaction, rolling back if it throws. */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The transaction is already gone.
    }
    throw error
  }
}

/**
 * Applies pending migrations. The database file is copied first; if any migration fails, the
 * copy is restored and the error is reported.
 */
export function migrate(path: string, migrations: readonly string[]): DatabaseSync {
  let database: DatabaseSync
  let current: number
  try {
    database = new DatabaseSync(path)
    current = schemaVersion(database)
  } catch (error) {
    throw sqlError(error)
  }
  if (current >= migrations.length) return database
  const backup = `${path.replace(/\.sqlite$/, '')}.sqlite.bak-v${current}`
  const hadFile = existsSync(path) && current > 0
  if (hadFile) {
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // A checkpoint that cannot run leaves the copy slightly behind, which a rebuild repairs.
    }
    copyFileSync(path, backup)
  }
  for (let index = current; index < migrations.length; index += 1) {
    try {
      transaction(database, () => {
        database.exec(migrations[index])
        database.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(index + 1))
      })
    } catch (error) {
      database.close()
      if (hadFile) copyFileSync(backup, path)
      else rmSync(path, { force: true })
      throw new HarnessError('migration_failed', `Index migration ${index + 1} failed and the previous index was restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return database
}

/** Runs `work` with the shared connection for this data root, opening and migrating it on first use. */
export function withIndex<T>(root: string, work: (database: DatabaseSync) => T): T {
  const path = dbPath(root)
  let database = connections.get(path)
  if (!database) {
    database = migrate(path, MIGRATIONS)
    try {
      database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    } catch (error) {
      database.close()
      throw sqlError(error)
    }
    connections.set(path, database)
  }
  try {
    return work(database)
  } catch (error) {
    throw error instanceof HarnessError ? error : sqlError(error)
  }
}

/** Closes this data root's connection, if one is open. */
export function closeIndex(root: string): void {
  const path = dbPath(root)
  connections.get(path)?.close()
  connections.delete(path)
}

/** Closes the connection and removes the index files; the next use rebuilds the schema. */
export function deleteIndex(root: string): void {
  closeIndex(root)
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath(root)}${suffix}`, { force: true })
}

export type Param = SQLInputValue

export function all<T>(database: DatabaseSync, sql: string, ...params: Param[]): T[] {
  return database.prepare(sql).all(...params) as T[]
}

export function run(database: DatabaseSync, sql: string, ...params: Param[]): void {
  database.prepare(sql).run(...params)
}

/** Folder names under `<data root>/runs`. */
export function runFolders(root: string): string[] {
  try {
    return readdirSync(join(root, 'runs'))
  } catch {
    return []
  }
}

/** Turns free text into an FTS5 query: each word becomes a quoted prefix term. */
export function ftsQuery(query: string): string | null {
  const terms = query.split(/[^\p{Alphabetic}\p{N}]+/u).filter(Boolean).map((term) => `"${term.replaceAll('"', '')}"*`)
  return terms.length ? terms.join(' ') : null
}
