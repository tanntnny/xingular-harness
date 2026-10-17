// Recall: the searchable record of what happened in conversations and runs. Each run's request,
// assistant messages, and tool summaries are indexed as passages in `index.sqlite`. Run records
// and events stay canonical; the recall index is rebuilt from `runs/`.
import type { DatabaseSync } from 'node:sqlite'

import type { HarnessEnv } from '../core/env'
import { invalid, notFound } from '../core/errors'
import { all, run as execute, transaction, withIndex } from '../core/index'
import { findProject, listProjects } from '../core/projects'
import { charCount, takeChars } from '../core/text'
import type { RunEvent, RunRecord } from '../sessions/contracts'
import { readAllRuns } from '../sessions/runIndex'
import { findRun, readEvents } from '../sessions/runStore'
import { isSession, projectOf, type CallerContext } from './caller'

const PASSAGE_LIMIT = 6000
const READ_LIMIT = 12_000
const SEARCH_DEFAULT = 8
const SEARCH_MAX = 30

export interface Passage {
  /** `user`, `event` (a turn the application started, not the user), `assistant`, or `tool`. */
  role: 'user' | 'event' | 'assistant' | 'tool'
  at: string
  text: string
}

/** A run as recall sees it: what was asked, what the assistant said, and which tools it used. */
export function passages(run: RunRecord, events: readonly RunEvent[]): Passage[] {
  const found: Passage[] = []
  const goal = run.goal?.trim()
  if (goal) found.push({ role: goal.startsWith('[App coordination event') ? 'event' : 'user', at: run.startedAt, text: takeChars(goal, PASSAGE_LIMIT) })
  for (const event of events) {
    const payload = event.payload as { role?: unknown; text?: unknown; name?: unknown; summary?: unknown }
    if (event.type === 'message.completed' && payload.role === 'assistant') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (text) found.push({ role: 'assistant', at: event.timestamp, text: takeChars(text, PASSAGE_LIMIT) })
    } else if (event.type === 'tool.started') {
      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
      if (summary) found.push({ role: 'tool', at: event.timestamp, text: takeChars(`${typeof payload.name === 'string' ? payload.name : 'tool'}: ${summary}`, PASSAGE_LIMIT) })
    }
  }
  return found
}

function writeRun(database: DatabaseSync, run: RunRecord, found: readonly Passage[]): void {
  execute(database, 'DELETE FROM recall_fts WHERE run_id = ?1', run.id)
  found.forEach((passage, seq) => {
    execute(database, 'INSERT INTO recall_fts (run_id, seq, role, at, mode, session_id, project_id, text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)', run.id, seq, passage.role, passage.at, run.mode, run.sessionId, run.projectId, passage.text)
  })
  execute(database, 'INSERT OR REPLACE INTO recall_runs (run_id, passages, status) VALUES (?1, ?2, ?3)', run.id, found.length, run.status)
}

function eventsOf(root: string, runId: string): RunEvent[] {
  try {
    return readEvents(root, runId)
  } catch {
    return []
  }
}

/** Indexes one run from its record and events. Index failures never block a run. */
export function indexRun(root: string, runId: string): void {
  const run = findRun(root, runId)
  if (!run) return
  const found = passages(run, eventsOf(root, runId))
  try {
    withIndex(root, (database) => writeRun(database, run, found))
  } catch (error) {
    process.stderr.write(`[recall] run ${runId} was not indexed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Indexes every run that is missing or whose status changed since it was indexed. Returns how
 * many were (re)indexed. Called at startup, so earlier conversations are searchable.
 */
export function sync(root: string): number {
  const known = new Map<string, string>()
  withIndex(root, (database) => {
    for (const row of all<{ run_id: string; status: string }>(database, 'SELECT run_id, status FROM recall_runs')) known.set(row.run_id, row.status)
  })
  const pending = readAllRuns(root)
    .filter((run) => known.get(run.id) !== run.status)
    .map((run) => ({ run, found: passages(run, eventsOf(root, run.id)) }))
  if (pending.length) withIndex(root, (database) => transaction(database, () => pending.forEach(({ run, found }) => writeRun(database, run, found))))
  return pending.length
}

// ---- Search ---------------------------------------------------------------------------------

/**
 * What a caller may recall. An agent searches its own conversations by default and everything
 * when it asks; a session only sees session runs in its own project (or its own session when
 * it has none), never an agent's conversation.
 */
export interface Scope {
  /** Only runs of this session. */
  sessionId?: string | null
  /** Only runs of this mode (`code` for sessions). */
  mode?: string | null
  projectId?: string | null
  /** ISO date or timestamp; only passages at or after it. */
  since?: string | null
}

export interface RecallHit {
  runId: string
  seq: number
  role: string
  at: string
  mode: string
  sessionId: string
  projectId: string | null
  snippet: string
}

/** Any word may match; passages that match more of them, and rarer ones, rank first. */
function ftsAny(query: string): string | null {
  const terms: string[] = []
  for (const word of query.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    if (charCount(word) <= 1) continue
    const term = `"${word.toLowerCase()}"*`
    if (!terms.includes(term) && terms.length < 24) terms.push(term)
  }
  return terms.length ? terms.join(' OR ') : null
}

interface HitRow {
  run_id: string
  seq: number | string
  role: string
  at: string | null
  mode: string | null
  session_id: string | null
  project_id: string | null
  snippet: string
}

export function search(root: string, query: string, scope: Scope, limit: number): RecallHit[] {
  const fts = ftsAny(query)
  if (!fts) return []
  return withIndex(root, (database) =>
    all<HitRow>(
      database,
      `SELECT run_id, seq, role, at, mode, session_id, project_id, snippet(recall_fts, 7, '', '', '…', 40) AS snippet
       FROM recall_fts WHERE recall_fts MATCH ?1
         AND (?2 IS NULL OR session_id = ?2) AND (?3 IS NULL OR mode = ?3)
         AND (?4 IS NULL OR project_id = ?4) AND (?5 IS NULL OR at >= ?5)
       ORDER BY bm25(recall_fts), at DESC LIMIT ?6`,
      fts,
      scope.sessionId ?? null,
      scope.mode ?? null,
      scope.projectId ?? null,
      scope.since ?? null,
      Math.min(Math.max(limit, 1), SEARCH_MAX)
    ).map((row) => ({ runId: row.run_id, seq: Number(row.seq), role: row.role, at: row.at ?? '', mode: row.mode ?? '', sessionId: row.session_id ?? '', projectId: row.project_id, snippet: row.snippet }))
  )
}

export interface RecallMessage {
  seq: number
  role: string
  at: string
  text: string
}

export function read(root: string, runId: string): RecallMessage[] {
  return withIndex(root, (database) =>
    all<{ seq: number | string; role: string; at: string | null; text: string }>(database, 'SELECT seq, role, at, text FROM recall_fts WHERE run_id = ?1 ORDER BY CAST(seq AS INTEGER)', runId).map((row) => ({ seq: Number(row.seq), role: row.role, at: row.at ?? '', text: row.text }))
  )
}

// ---- Tools ----------------------------------------------------------------------------------

type Params = Record<string, unknown> | null | undefined

function textParam(params: Params, key: string): string {
  const value = params?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** The widest scope a caller may use, narrowed by what it asked for. */
function callerScope(root: string, context: CallerContext, params: Params): Scope {
  const since = textParam(params, 'since') || null
  if (isSession(context)) {
    // A session never reads an agent's conversations: only session runs of its project, or its own.
    const projectId = projectOf(root, context)?.id ?? null
    if (!projectId && !context.sessionId) throw invalid('Recall needs a session.')
    return { sessionId: projectId ? null : context.sessionId, mode: 'code', projectId, since }
  }
  if (!context.agentId) throw invalid('Recall needs an agent or a Harness session.')
  const key = textParam(params, 'project')
  let projectId: string | null = null
  if (key) {
    const project = listProjects(root).find((entry) => entry.id === key || entry.slug === key || entry.name.toLowerCase() === key.toLowerCase())
    if (!project) throw invalid(`There is no project called ${key}.`)
    projectId = project.id
  }
  const everything = textParam(params, 'scope') === 'all' || projectId !== null
  return { sessionId: everything ? null : context.agentId, mode: null, projectId, since }
}

function mayRead(scope: Scope, run: RunRecord): boolean {
  if (!scope.mode) return true
  return scope.mode === run.mode && (!scope.projectId || scope.projectId === run.projectId) && (!scope.sessionId || scope.sessionId === run.sessionId)
}

/** Who a run belonged to, for a person or a model reading a hit. */
export function sourceLabel(env: HarnessEnv, mode: string, sessionId: string, projectId: string | null): string {
  if (mode === 'chat') {
    // One of an agent's extra conversations has its own id.
    const owner = env.directory.sessionAgent(sessionId)
    const name = env.directory.agentName(sessionId) ?? (owner ? env.directory.agentName(owner) : null)
    return name ? `chat with ${name}` : 'group or earlier chat'
  }
  try {
    return projectId ? `Harness session in ${findProject(env.root, projectId).name}` : 'Harness session'
  } catch {
    return 'Harness session'
  }
}

/** Whether a conversation belongs to an agent the caller may not recall. */
function excluded(env: HarnessEnv, context: CallerContext, sessionId: string): boolean {
  const hidden = context.recallExcludeAgents ?? []
  if (!hidden.length) return false
  return hidden.includes(sessionId) || hidden.includes(env.directory.sessionAgent(sessionId) ?? '')
}

/** `recall.search` as text for a model. */
export function searchTool(env: HarnessEnv, context: CallerContext, params: Params): string {
  const query = textParam(params, 'query')
  if (!query) throw invalid('Give a query.')
  const scope = callerScope(env.root, context, params)
  const requested = params?.limit
  const limit = typeof requested === 'number' && Number.isInteger(requested) && requested >= 0 ? requested : SEARCH_DEFAULT
  // The caller's current run is what it is in the middle of, not something to recall.
  const hits = search(env.root, query, scope, limit + 4 + (context.recallExcludeAgents?.length ? SEARCH_MAX : 0)).filter((hit) => hit.runId !== context.runId && !excluded(env, context, hit.sessionId)).slice(0, Math.min(Math.max(limit, 1), SEARCH_MAX))
  if (!hits.length) {
    return scope.sessionId && !isSession(context) ? 'Nothing in your own conversations matches. Pass scope "all" to search every conversation and Harness run.' : 'Nothing in the recorded history matches.'
  }
  return `${hits.map((hit) => `- [run ${hit.runId} · ${hit.at.slice(0, 10)} · ${sourceLabel(env, hit.mode, hit.sessionId, hit.projectId)}] ${hit.role}: ${hit.snippet.replaceAll('\n', ' ')}`).join('\n')}\n\nRead a whole run with history_read and its run id.`
}

/** `recall.read` as text for a model. */
export function readTool(env: HarnessEnv, context: CallerContext, params: Params): string {
  const runId = textParam(params, 'run') || textParam(params, 'runId')
  const run = findRun(env.root, runId)
  if (!run) throw notFound('Run')
  // Reading is as wide as an "all" search for an agent, and as narrow as a search for a session.
  if (!mayRead(callerScope(env.root, context, { scope: 'all' }), run) || excluded(env, context, run.sessionId)) throw notFound('Run')
  const messages = read(env.root, run.id)
  if (!messages.length) return 'That run has no recorded messages.'
  let text = `Run ${run.id} · ${run.startedAt.slice(0, 16)} · ${sourceLabel(env, run.mode, run.sessionId, run.projectId)} · ${run.status}\n`
  for (const message of messages) {
    const line = `\n${message.role}: ${message.text}\n`
    if (charCount(text) + charCount(line) > READ_LIMIT) {
      text += '\n(The rest of the run was left out.)\n'
      break
    }
    text += line
  }
  return text
}

export interface RecallFilter {
  sessionId?: string | null
  projectId?: string | null
  since?: string | null
}

export type RecallResult = RecallHit & { source: string }

/** A person's search: every conversation and run, narrowed only by the filter. */
export function searchAll(env: HarnessEnv, query: string, filter: RecallFilter = {}): RecallResult[] {
  return search(env.root, query, { sessionId: filter.sessionId, mode: null, projectId: filter.projectId, since: filter.since || null }, SEARCH_MAX).map((hit) => ({ ...hit, source: sourceLabel(env, hit.mode, hit.sessionId, hit.projectId) }))
}
