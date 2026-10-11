// Canonical run records and their event logs.
//
// `<data root>/runs/<run id>/run.json` holds the run's fields; `events.jsonl` is the
// append-only, validated event log. The harness is the only writer of both.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { notFound } from '../core/errors'
import { newId, now, readJson, safeId, writeJson } from '../core/fs'
import { compareText, lines } from '../core/text'
import { isActiveStatus, runEventSchema, runRecordSchema, type RunEvent, type RunRecord } from './contracts'
import { readAllRuns, recordRun, runsForSession } from './runIndex'

export function runDir(root: string, runId: string): string {
  return join(root, 'runs', safeId(runId))
}

const recordPath = (root: string, runId: string): string => join(runDir(root, runId), 'run.json')

// Field order of the file, so a record written here reads the same as one written before.
function ordered(record: RunRecord): RunRecord {
  return {
    resumedFromRunId: record.resumedFromRunId,
    terminalReason: record.terminalReason,
    id: record.id,
    projectId: record.projectId,
    mode: record.mode,
    harness: record.harness,
    sessionType: record.sessionType,
    sessionId: record.sessionId,
    nativeSessionId: record.nativeSessionId,
    workingDirectory: record.workingDirectory,
    worktreeId: record.worktreeId,
    goal: record.goal,
    attachmentCount: record.attachmentCount,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    exitCode: record.exitCode,
    handoffId: record.handoffId,
    accountId: record.accountId,
    agentId: record.agentId,
    trigger: record.trigger
  }
}

function write(root: string, record: RunRecord): void {
  writeJson(recordPath(root, record.id), ordered(record))
  recordRun(root, record)
}

export function saveRun(root: string, record: RunRecord): void {
  write(root, record)
}

function readRecord(path: string): RunRecord | null {
  const parsed = runRecordSchema.safeParse(readJson(path))
  return parsed.success ? parsed.data : null
}

export function loadRun(root: string, runId: string): RunRecord {
  const record = readRecord(recordPath(root, runId))
  if (!record) throw notFound('Run')
  return record
}

export function findRun(root: string, runId: string): RunRecord | null {
  try {
    return loadRun(root, runId)
  } catch {
    return null
  }
}

/** Changes a run's record. A settled run keeps its outcome whatever the change says. */
export function updateRun(root: string, runId: string, update: (record: RunRecord) => void): void {
  const record = readRecord(recordPath(root, runId))
  if (!record) return
  const { status, endedAt, terminalReason } = record
  update(record)
  if (!isActiveStatus(status)) Object.assign(record, { status, endedAt, terminalReason })
  write(root, record)
}

export function terminalStatus(event: Pick<RunEvent, 'type' | 'payload'>): 'completed' | 'failed' | 'interrupted' | null {
  if (event.type === 'completed') return 'completed'
  if (event.type === 'failed') return 'failed'
  if (event.type !== 'status.changed') return null
  const status = (event.payload as { status?: unknown } | null)?.status
  return status === 'interrupted' || status === 'failed' || status === 'completed' ? status : null
}

function reasonOf(event: RunEvent): string | null {
  const payload = event.payload as { reason?: unknown; message?: unknown } | null
  const reason = payload?.reason ?? payload?.message
  return typeof reason === 'string' ? reason : null
}

export function appendEvent(root: string, event: RunEvent): void {
  const directory = runDir(root, event.runId)
  mkdirSync(directory, { recursive: true })
  // O_APPEND with a single write keeps each line intact.
  appendFileSync(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`)
}

/** A stored event as it was written: structurally an event, whatever its payload. */
function storedEvent(line: string): RunEvent | null {
  try {
    const value = JSON.parse(line) as RunEvent
    const valid = value && typeof value.id === 'string' && typeof value.runId === 'string' && typeof value.sessionId === 'string' && Number.isInteger(value.sequence) && value.sequence >= 0 && typeof value.timestamp === 'string' && typeof value.type === 'string' && value.payload !== undefined
    return valid ? value : null
  } catch {
    return null
  }
}

/** A torn final line (a crash mid-write) is skipped rather than failing the whole log. */
export function readEvents(root: string, runId: string): RunEvent[] {
  let text: string
  try {
    text = readFileSync(join(runDir(root, runId), 'events.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return lines(text).flatMap((line) => storedEvent(line) ?? [])
}

/** An incoming event that passes the contract, or `null`. */
export function parseEvent(value: unknown): RunEvent | null {
  const parsed = runEventSchema.safeParse(value)
  if (!parsed.success) return null
  try {
    safeId(parsed.data.runId)
  } catch {
    return null
  }
  return parsed.data
}

/** The events that affected execution; what arrived after the outcome stays in the raw log as evidence. */
export function executionEvents(events: readonly RunEvent[]): RunEvent[] {
  const end = events.findIndex((event) => terminalStatus(event) !== null)
  return events.slice(0, end < 0 ? events.length : end + 1).filter((event) => (event.native as { hostIgnored?: unknown } | null | undefined)?.hostIgnored === undefined)
}

/**
 * Appends an event and applies it to the run record. An event that arrives after the run
 * settled is kept as evidence and returns `false`: it is never applied or relayed.
 */
export function persistEvent(root: string, event: RunEvent): boolean {
  const record = loadRun(root, event.runId)
  if (!isActiveStatus(record.status)) {
    event.native = { hostIgnored: 'run_already_ended', event: event.native ?? null }
    appendEvent(root, event)
    return false
  }
  appendEvent(root, event)
  // Most events (text deltas above all) leave the record as it is; it is rewritten only when it changes.
  let changed = false
  const outcome = terminalStatus(event)
  if (outcome) {
    record.status = outcome
    record.endedAt = event.timestamp
    record.terminalReason = reasonOf(event)
    changed = true
  } else if (event.type === 'status.changed') {
    const status = (event.payload as { status?: unknown }).status
    if (typeof status === 'string' && status !== record.status) {
      record.status = status
      changed = true
    }
  }
  const payload = event.payload as { role?: unknown; text?: unknown }
  if (event.type === 'message.completed' && payload.role === 'user' && record.mode === 'code' && !record.goal) {
    record.goal = typeof payload.text === 'string' ? payload.text : null
    changed = true
  }
  if (changed) write(root, record)
  return true
}

const STOPPED = 'The harness stopped before the run settled.'

/** Startup reconciliation for every run that did not settle before the process stopped. */
export function markInterruptedRuns(root: string, reason = STOPPED): number {
  let count = 0
  for (const record of readAllRuns(root)) {
    const path = recordPath(root, record.id)
    const events = readEvents(root, record.id)
    const settled = events.find((event) => terminalStatus(event) !== null)
    if (settled) {
      const status = terminalStatus(settled)!
      const settledReason = reasonOf(settled)
      if (record.status !== status || record.endedAt !== settled.timestamp || record.terminalReason !== settledReason) {
        const backup = `${path}.before-outcome-repair`
        if (!existsSync(backup)) copyFileSync(path, backup)
        Object.assign(record, { status, endedAt: settled.timestamp, terminalReason: settledReason })
        write(root, record)
      }
    }
    if (!isActiveStatus(record.status)) continue
    record.status = 'interrupted'
    record.terminalReason = reason
    record.endedAt ??= now()
    const last = events.reduce((highest, event) => Math.max(highest, event.sequence), -1)
    appendEvent(root, { id: newId(), runId: record.id, sessionId: record.sessionId, sequence: last + 1, timestamp: now(), type: 'status.changed', payload: { status: 'interrupted', reason } })
    write(root, record)
    count += 1
  }
  return count
}

/** An approval or question a run asked for that nothing has answered yet. */
export interface PendingDecision {
  kind: 'approval' | 'question'
  id: string
  eventId: string
  payload: unknown
}

/** The run's unanswered approvals and questions, oldest first. */
export function pendingDecisions(events: readonly RunEvent[]): PendingDecision[] {
  const pending: PendingDecision[] = []
  for (const requested of events) {
    const shape = requested.type === 'approval.requested' ? (['approval', 'approvalId', 'approval.resolved'] as const) : requested.type === 'question.requested' ? (['question', 'questionId', 'question.answered'] as const) : null
    if (!shape) continue
    const [kind, key, answered] = shape
    const id = (requested.payload as Record<string, unknown>)[key]
    if (typeof id !== 'string') continue
    if (events.some((entry) => entry.type === answered && (entry.payload as Record<string, unknown>)[key] === id)) continue
    pending.push({ kind, id, eventId: requested.id, payload: requested.payload })
  }
  return pending
}

export interface RunSnapshot {
  run: RunRecord
  events: RunEvent[]
  lastSequence: number
}

export function snapshot(root: string, runId: string): RunSnapshot {
  const run = loadRun(root, runId)
  const events = executionEvents(readEvents(root, runId))
  return { run, events, lastSequence: events.reduce((highest, event) => Math.max(highest, event.sequence), -1) }
}

export interface RunListFilter {
  projectId?: string | null
  sessionId?: string | null
  activeOnly?: boolean
}

/** A session's history comes from the index; other filters scan run records. At most 200, newest first. */
export function listRuns(root: string, filter: RunListFilter): RunRecord[] {
  if (filter.sessionId) {
    try {
      const records = runsForSession(root, filter.sessionId, 200).flatMap((id) => findRun(root, id) ?? [])
      return filter.activeOnly ? records.filter((record) => isActiveStatus(record.status)) : records
    } catch {
      // Fall through to the files.
    }
  }
  return readAllRuns(root)
    .filter((record) => !filter.projectId || record.projectId === filter.projectId)
    .filter((record) => !filter.sessionId || record.sessionId === filter.sessionId)
    .filter((record) => !filter.activeOnly || isActiveStatus(record.status))
    .sort((left, right) => compareText(right.startedAt, left.startedAt))
    .slice(0, 200)
}
