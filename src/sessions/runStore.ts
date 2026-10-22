// Canonical run records and their event logs.
//
// `<data root>/runs/<run id>/run.json` holds the run's fields; `events.jsonl` is the
// append-only, validated event log. The harness is the only writer of both.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { notFound } from '../core/errors'
import { newId, now, readJson, readJsonOr, safeId, writeJson } from '../core/fs'
import { compareText, lines } from '../core/text'
import { isActiveStatus, runEventSchema, runRecordSchema, upgradeRunRecord, usagePayloadSchema, type RunEvent, type RunRecord, type UsagePayload } from './contracts'
import { readAllRuns, recordRun, runsForSession } from './runIndex'

export function runDir(root: string, runId: string): string {
  return join(root, 'runs', safeId(runId))
}

const recordPath = (root: string, runId: string): string => join(runDir(root, runId), 'run.json')

// Field order of the file, so a record written here reads the same as one written before.
function ordered(record: RunRecord): RunRecord {
  return {
    resumedFromRunId: record.resumedFromRunId,
    parentRunId: record.parentRunId,
    relation: record.relation,
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
    trigger: record.trigger,
    ...(record.variantScope ? { variantScope: record.variantScope } : {}),
    ...(record.variantVersion ? { variantVersion: record.variantVersion } : {})
  }
}

function write(root: string, record: RunRecord): void {
  writeJson(recordPath(root, record.id), ordered(record))
  if (isActiveStatus(record.status)) claimOwner(root, record.id)
  recordRun(root, record)
}

// The process that is driving an active run. Startup recovery leaves such a run alone while that process lives.
const ownerPath = (root: string, runId: string): string => join(runDir(root, runId), 'owner.json')

function claimOwner(root: string, runId: string): void {
  const path = ownerPath(root, runId)
  if (readJsonOr<{ pid?: unknown } | null>(path, null)?.pid === process.pid) return
  writeJson(path, { pid: process.pid })
}

/** True only when a different live process owns the run. No marker, or a dead owner, means nothing holds it. */
function ownedElsewhere(root: string, runId: string): boolean {
  const pid = readJsonOr<{ pid?: unknown } | null>(ownerPath(root, runId), null)?.pid
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function saveRun(root: string, record: RunRecord): void {
  write(root, record)
}

function readRecord(path: string): RunRecord | null {
  const parsed = runRecordSchema.safeParse(upgradeRunRecord(readJson(path)))
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

/** A parent's reserved child IDs survive a crash before the spawn tool returns. */
export function recordSubagent(root: string, parentRunId: string, childRunId: string): void {
  loadRun(root, parentRunId)
  const ids = recordedSubagents(root, parentRunId)
  if (!ids.includes(childRunId)) writeJson(join(runDir(root, parentRunId), 'subagents.json'), [...ids, childRunId])
}

export function recordedSubagents(root: string, parentRunId: string): string[] {
  const value = readJson(join(runDir(root, parentRunId), 'subagents.json'))
  if (value === null) return []
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('Recorded subagent ownership is unreadable.')
  return value as string[]
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
export function markInterruptedRuns(root: string, reason = STOPPED): string[] {
  const interrupted: string[] = []
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
    // Another live Harness on the same data folder is still running this; it is not an orphan.
    if (ownedElsewhere(root, record.id)) continue
    record.status = 'interrupted'
    record.terminalReason = reason
    record.endedAt ??= now()
    const last = events.reduce((highest, event) => Math.max(highest, event.sequence), -1)
    appendEvent(root, { id: newId(), runId: record.id, sessionId: record.sessionId, sequence: last + 1, timestamp: now(), type: 'status.changed', payload: { status: 'interrupted', reason } })
    write(root, record)
    interrupted.push(record.id)
  }
  return interrupted
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

export interface RunFamilySnapshot {
  rootRunId: string
  runs: { run: RunRecord; usage: UsagePayload | null }[]
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number | null
    costUsd: number | null
    requests: number | null
  }
  settled: boolean
}

function belongsToRoot(record: RunRecord, rootRunId: string, records: Map<string, RunRecord>): boolean {
  const visited = new Set<string>()
  let current: RunRecord | undefined = record
  while (current && !visited.has(current.id)) {
    if (current.id === rootRunId) return true
    visited.add(current.id)
    current = current.parentRunId ? records.get(current.parentRunId) : undefined
  }
  return false
}

/** A root run and all descendants linked through opaque parent-run metadata. */
export function runFamily(root: string, runId: string): RunFamilySnapshot {
  const all = readAllRuns(root)
  const byId = new Map(all.map((record) => [record.id, record]))
  const target = byId.get(runId)
  if (!target) throw notFound('Run')

  let familyRoot = target
  const ancestors = new Set<string>([target.id])
  while (familyRoot.parentRunId) {
    const parent = byId.get(familyRoot.parentRunId)
    if (!parent || ancestors.has(parent.id)) break
    ancestors.add(parent.id)
    familyRoot = parent
  }

  const members = all.filter((record) => belongsToRoot(record, familyRoot.id, byId))
    .sort((left, right) => compareText(left.startedAt, right.startedAt))
  const runs = members.map((run) => {
    const events = executionEvents(readEvents(root, run.id))
    const lastUsage = events.filter((event) => event.type === 'usage.updated').at(-1)?.payload
    const parsed = usagePayloadSchema.safeParse(lastUsage)
    return { run, usage: parsed.success ? parsed.data : null }
  })
  const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'requests'] as const
  const usage = Object.fromEntries(counters.map((counter) => {
    const values = runs.map(({ usage: current }) => current?.[counter])
    return [counter, values.every((value) => typeof value === 'number') ? values.reduce<number>((total, value) => total + (value as number), 0) : null]
  })) as RunFamilySnapshot['usage']

  return { rootRunId: familyRoot.id, runs, usage, settled: runs.every(({ run }) => !isActiveStatus(run.status)) }
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
