// Read-only views over the canonical run records and validated event logs.
import type { HarnessEnv } from '../core/env'
import { invalid, notFound } from '../core/errors'
import { listProjects } from '../core/projects'
import { compareText } from '../core/text'
import { scrub } from '../accounts/store'
import { scrubSensitive } from '../mcp/connections'
import { isActiveStatus, runStatusSchema, type RunEvent, type RunRecord } from '../sessions/contracts'
import { readAllRuns } from '../sessions/runIndex'
import { findRun, snapshot } from '../sessions/runStore'
import type { CallerContext } from './caller'

const SEARCH_DEFAULT = 10
const SEARCH_MAX = 30
const READ_DEFAULT = 8
const READ_MAX = 10
const EVENT_MAX_CHARS = 18_000
const PAGE_MAX_CHARS = 48_000

export type Params = Record<string, unknown> | null | undefined

function textParam(params: Params, key: string): string {
  const value = params?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function boundedInteger(params: Params, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = params?.[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${key} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function dateValue(params: Params, key: string): { text: string; timestamp: number } | null {
  const value = textParam(params, key)
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw invalid(`${key} must be a YYYY-MM-DD date or ISO timestamp.`)
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}${key === 'until' ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}` : value)
  if (!Number.isFinite(timestamp)) throw invalid(`${key} must be a valid date or ISO timestamp.`)
  return { text: value, timestamp }
}

interface Cursor {
  startedAt: string
  id: string
}

function decodeCursor(value: string): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.startedAt !== 'string' || !parsed.startedAt || typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid cursor')
    return { startedAt: parsed.startedAt, id: parsed.id }
  } catch {
    throw invalid('The trajectory cursor is invalid. Start a new search without it.')
  }
}

function encodeCursor(run: RunRecord): string {
  return Buffer.from(JSON.stringify({ startedAt: run.startedAt, id: run.id })).toString('base64url')
}

function hidden(env: HarnessEnv, context: CallerContext, run: RunRecord): boolean {
  const excluded = context.recallExcludeAgents ?? []
  if (!excluded.length) return false
  return excluded.includes(run.agentId ?? '') || excluded.includes(run.sessionId) || excluded.includes(env.directory.sessionAgent(run.sessionId) ?? '')
}

function afterCursor(run: RunRecord, cursor: Cursor): boolean {
  return run.startedAt < cursor.startedAt || (run.startedAt === cursor.startedAt && run.id < cursor.id)
}

function summary(env: HarnessEnv, run: RunRecord, projects: ReturnType<typeof listProjects>) {
  const project = projects.find((entry) => entry.id === run.projectId)
  const goal = run.goal?.trim() ?? ''
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentId ? env.directory.agentName(run.agentId) : null,
    project: project ? { id: project.id, name: project.name, slug: project.slug } : null,
    mode: run.mode,
    status: run.status,
    goal: goal.length > 500 ? `${goal.slice(0, 497)}…` : goal || null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    parentRunId: run.parentRunId,
    relation: run.relation
  }
}

/** `trajectory.search`: structured list/search over the current Harness data root. */
export function searchTool(env: HarnessEnv, context: CallerContext, params: Params): string {
  const agent = textParam(params, 'agent')
  const projectKey = textParam(params, 'project')
  const mode = textParam(params, 'mode')
  const status = textParam(params, 'status')
  const since = dateValue(params, 'since')
  const until = dateValue(params, 'until')
  const limit = boundedInteger(params, 'limit', SEARCH_DEFAULT, 1, SEARCH_MAX)
  const cursor = decodeCursor(textParam(params, 'cursor'))

  if (status && !runStatusSchema.safeParse(status).success) throw invalid(`Unknown run status ${status}.`)
  const projects = listProjects(env.root)
  const project = projectKey ? projects.find((entry) => entry.id === projectKey || entry.slug === projectKey || entry.name.toLowerCase() === projectKey.toLowerCase()) : null
  if (projectKey && !project) throw invalid(`There is no project called ${projectKey}.`)

  const matching = readAllRuns(env.root)
    .filter((run) => !hidden(env, context, run))
    .filter((run) => !agent || run.agentId === agent || (run.agentId !== null && env.directory.agentName(run.agentId)?.toLowerCase() === agent.toLowerCase()))
    .filter((run) => !projectKey || run.projectId === project?.id)
    .filter((run) => !mode || run.mode === mode)
    .filter((run) => !status || run.status === status)
    .filter((run) => !since || Date.parse(run.startedAt) >= since.timestamp)
    .filter((run) => !until || Date.parse(run.startedAt) <= until.timestamp)
    .filter((run) => !cursor || afterCursor(run, cursor))
    .sort((left, right) => compareText(right.startedAt, left.startedAt) || compareText(right.id, left.id))

  const page = matching.slice(0, limit)
  const hasMore = matching.length > page.length
  return JSON.stringify({
    runs: page.map((run) => summary(env, run, projects)),
    hasMore,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null
  })
}

function boundedValue(value: unknown, path: string, truncated: string[], stringLimit: number, arrayLimit: number, depth = 0): unknown {
  if (typeof value === 'string') {
    const fieldLimit = path.endsWith('.systemPrompt') || path.endsWith('.contextUpdate') ? Math.min(12_000, stringLimit) :
      path.endsWith('.input') || path.endsWith('.output') || path.endsWith('.summary') ? Math.min(10_000, stringLimit) : stringLimit
    if (value.length <= fieldLimit) return value
    truncated.push(path)
    return `${value.slice(0, Math.max(0, fieldLimit - 16))}… [truncated]`
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, arrayLimit).map((item, index) => boundedValue(item, `${path}[${index}]`, truncated, stringLimit, arrayLimit, depth + 1))
    if (value.length > arrayLimit) truncated.push(path)
    return kept
  }
  if (!value || typeof value !== 'object' || depth >= 8) return value
  const entries = Object.entries(value as Record<string, unknown>)
  const kept = entries.slice(0, 40).map(([key, item]) => [key, boundedValue(item, `${path}.${key}`, truncated, stringLimit, arrayLimit, depth + 1)])
  if (entries.length > 40) truncated.push(path)
  return Object.fromEntries(kept)
}

function publicEvent(event: RunEvent): Record<string, unknown> {
  let stringLimit = 12_000
  let arrayLimit = 20
  while (true) {
    const truncated: string[] = []
    const omitted: string[] = []
    let payload = scrubSensitive(event.payload)
    if (event.type === 'account.status' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const account = payload as Record<string, unknown>
      if (Object.hasOwn(account, 'accountId')) {
        delete account.accountId
        omitted.push('payload.accountId')
      }
      if (typeof account.message === 'string') account.message = scrub(account.message)
    }
    if (event.type === 'usage.updated' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const request = (payload as Record<string, unknown>).request
      if (request && typeof request === 'object' && !Array.isArray(request) && Object.hasOwn(request, 'reasoningSummary')) {
        delete (request as Record<string, unknown>).reasoningSummary
        omitted.push('payload.request.reasoningSummary')
      }
    }
    const value: Record<string, unknown> = {
      id: event.id,
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      payload: boundedValue(payload, 'payload', truncated, stringLimit, arrayLimit)
    }
    if (event.coalescedFrom !== undefined) value.coalescedFrom = event.coalescedFrom
    if (truncated.length) value.truncatedFields = truncated.slice(0, 40)
    if (omitted.length) value.omittedFields = omitted
    if (JSON.stringify(value).length <= EVENT_MAX_CHARS || (stringLimit <= 500 && arrayLimit <= 1)) return value
    stringLimit = Math.max(500, Math.floor(stringLimit / 2))
    arrayLimit = Math.max(1, Math.floor(arrayLimit / 2))
  }
}

/** `trajectory.read`: a bounded page of the events that affected a run. */
export function readTool(env: HarnessEnv, context: CallerContext, params: Params): string {
  const requested = textParam(params, 'run')
  if (!requested) throw invalid('Give a run id or "current".')
  const runId = requested === 'current' ? context.runId ?? '' : requested
  if (!runId) throw invalid('This caller has no current run.')
  const run = findRun(env.root, runId)
  if (!run || hidden(env, context, run)) throw notFound('Run')

  const afterSequence = boundedInteger(params, 'afterSequence', -1, -1, Number.MAX_SAFE_INTEGER)
  const limit = boundedInteger(params, 'limit', READ_DEFAULT, 1, READ_MAX)
  const captured = snapshot(env.root, run.id)
  const candidates = captured.events.filter((event) => event.sequence > afterSequence)
  const events: Record<string, unknown>[] = []
  let eventChars = 0
  for (const event of candidates.slice(0, limit)) {
    const bounded = publicEvent(event)
    const size = JSON.stringify(bounded).length
    if (events.length && eventChars + size > PAGE_MAX_CHARS) break
    events.push(bounded)
    eventChars += size
  }
  const lastSequence = events.length ? Number(events[events.length - 1].sequence) : afterSequence
  const hasMore = candidates.some((event) => event.sequence > lastSequence)
  const projects = listProjects(env.root)
  const result = {
    run: summary(env, captured.run, projects),
    active: isActiveStatus(captured.run.status),
    events,
    hasMore,
    nextAfterSequence: lastSequence
  }
  return JSON.stringify(result)
}
