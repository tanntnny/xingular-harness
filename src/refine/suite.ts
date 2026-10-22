// Evaluating variants on a task set: one execution per version × task, recorded as an
// answer-free matrix of what each variant delivered. No improver, no selection, no adoption —
// the only executions here are the given Executor's probe runs. Records live beside a
// refinement's, under `<data root>/refine/<id>/`, so a sweep over variant versions or package
// commits reads the same record family (`refine/<id>/matrix.json`).
//
// Every row carries its comparability keys (task-prompt hash, executor name, package
// version, variant fingerprint), so two matrices — taken at different commits or versions —
// are diffable without re-reading the runs that produced them.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { now, readJson, safeId, writeJson } from '../core/fs'
import * as store from '../variant/store'
import { PI_SURFACE, type Variant } from '../variant/surface'
import { writeVariant } from '../variant/variant'
import { assertVariantHasNoGraderVerdicts } from './evidence'
import { mapLimit } from './recursion'
import type { Executor, RefineTask, Rollout } from './types'

export type MatrixStatus = 'running' | 'ok' | 'partial' | 'failed' | 'cancelled'

export interface MatrixVersion {
  /** Record label; also names the variant copy under the record's variants/ folder. */
  label: string
  variant: Variant
}

export interface MatrixRow {
  version: string
  fingerprint: string
  task: string
  runId: string
  dir: string
  ok: boolean
  delivered: boolean
  costUsd: number
  wallMs: number
  error: string
  /** Comparability keys: one task text, one executor, one package release. */
  taskHash: string
  executor: string
  packageVersion: string
}

export interface MatrixSummary {
  id: string
  status: MatrixStatus
  startedAt: string
  endedAt: string | null
  versions: string[]
  tasks: string[]
  rows: MatrixRow[]
  usd: number
  errors: string[]
}

export type MatrixEvent =
  | { type: 'execution.started'; version: string; task: string; label: string }
  | { type: 'execution.finished'; version: string; task: string; ok: boolean; delivered: boolean; error: string }
  | { type: 'summary'; summary: MatrixSummary }

export interface MatrixInput {
  root: string
  id: string
  versions: MatrixVersion[]
  tasks: RefineTask[]
  executor: Executor
  /** The executor's name for the records; defaults to its constructor's name. */
  executorName?: string
  rolloutWidth?: number
  onEvent?: (event: MatrixEvent) => void
  signal?: AbortSignal
}

export function matrixDir(root: string, id: string): string {
  return join(root, 'refine', safeId(id))
}

export function readMatrix(root: string, id: string): MatrixSummary | null {
  return readJson<MatrixSummary>(join(matrixDir(root, id), 'matrix.json'))
}

let packageVersionMemo: string | null = null

/** This package's release, whatever shape the module took: source, esbuild bundle, or an
 * installed copy. Walks up from the module's own URL to the nearest package.json. */
function packageVersion(): string {
  if (packageVersionMemo === null) {
    packageVersionMemo = 'unknown'
    try {
      let dir = fileURLToPath(import.meta.url)
      for (let up = 0; up < 6; up++) {
        dir = dirname(dir)
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest)) {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
          if (json.version) packageVersionMemo = json.version
          break
        }
      }
    } catch {
      // A record without a version is still a record.
    }
  }
  return packageVersionMemo
}

function taskHash(task: RefineTask): string {
  return createHash('sha256').update(task.prompt).digest('hex').slice(0, 16)
}

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/

function stage(input: MatrixInput): { label: string; variant: Variant; fingerprint: string; dir: string; error: string }[] {
  const labels: string[] = []
  for (const entry of input.versions) {
    if (!SEGMENT.test(entry.label)) throw new Error(`Version label '${entry.label}' must be a usable record name (A-Z a-z 0-9 _ -).`)
    labels.push(entry.label)
  }
  if (new Set(labels).size !== labels.length) throw new Error('Version labels must be unique.')
  if (input.tasks.some((task) => !SEGMENT.test(task.id))) throw new Error('Task ids must be usable record names (A-Z a-z 0-9 _ -).')
  if (new Set(input.tasks.map((task) => task.id)).size !== input.tasks.length) throw new Error('Task ids must be unique.')

  // Staging and the tripwire happen before any execution: a variant carrying grader output
  // never reaches an execution, the same guard the refinement's evidence folder applies
  // (INV-REF-1). A variant that cannot be written becomes an error row, never an abort.
  return input.versions.map((entry) => {
    try {
      assertVariantHasNoGraderVerdicts(entry.variant)
      return { label: entry.label, variant: entry.variant, fingerprint: store.fingerprint(entry.variant), dir: writeVariant(PI_SURFACE, entry.variant, join(matrixDir(input.root, input.id), 'variants', entry.label)), error: '' }
    } catch (error) {
      return { label: entry.label, variant: entry.variant, fingerprint: store.fingerprint(entry.variant), dir: '', error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Runs the full version × task matrix. Bad input throws; execution failures become rows. */
export async function runMatrix(input: MatrixInput): Promise<MatrixSummary> {
  if (!input.versions.length) throw new Error('A matrix needs at least one harness version.')
  if (!input.tasks.length) throw new Error('A matrix needs at least one task.')
  if (input.tasks.some((task) => !task.prompt.trim())) throw new Error('Every task needs a non-empty prompt.')

  const { root, id, tasks, executor } = input
  const executorName = input.executorName ?? executor.constructor?.name ?? 'executor'
  const emit = (event: MatrixEvent) => input.onEvent?.(event)
  const staged = stage(input)

  const summary: MatrixSummary = {
    id,
    status: 'running',
    startedAt: now(),
    endedAt: null,
    versions: staged.map((entry) => entry.label),
    tasks: tasks.map((task) => task.id),
    rows: [],
    usd: 0,
    errors: []
  }
  const save = () => {
    summary.usd = Math.round(summary.rows.reduce((sum, row) => sum + row.costUsd, 0) * 1e6) / 1e6
    writeJson(join(matrixDir(root, id), 'matrix.json'), summary)
    emit({ type: 'summary', summary: structuredClone(summary) })
  }
  writeJson(join(matrixDir(root, id), 'suite.json'), { id, versions: staged.map(({ label, fingerprint }) => ({ label, fingerprint })), tasks })
  save()

  const pairs = staged.flatMap((version) => tasks.map((task) => ({ version, task })))
  await mapLimit(pairs, input.rolloutWidth ?? 4, async ({ version, task }) => {
    const runId = `${id}-${version.label}-${task.id}`
    let row: MatrixRow
    if (input.signal?.aborted) row = failedRow(version, task, runId, executorName, 'The matrix was cancelled.')
    else if (version.error) row = failedRow(version, task, runId, executorName, `the variant could not be staged: ${version.error}`)
    else {
      let validation: string | null = null
      if (executor.validateVariant) {
        try {
          executor.validateVariant(task, version.variant)
        } catch (error) {
          validation = `invalid variant for this task: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (validation) row = failedRow(version, task, runId, executorName, validation)
      else {
        emit({ type: 'execution.started', version: version.label, task: task.id, label: runId })
        let rollout: Rollout
        try {
          rollout = await executor.execute(task, version.dir, runId, runId)
        } catch (error) {
          // The Executor contract says execute never throws; this keeps the record honest if one does.
          rollout = { label: runId, runId, dir: join(matrixDir(root, id), 'missing', version.label, task.id), ok: false, delivered: false, costUsd: 0, wallMs: 0, error: error instanceof Error ? error.message : String(error) }
        }
        emit({ type: 'execution.finished', version: version.label, task: task.id, ok: rollout.ok, delivered: rollout.delivered, error: rollout.error })
        row = rowOf(version, task, runId, executorName, rollout)
      }
    }
    summary.rows.push(row)
    save()
  })

  for (const error of staged.filter((entry) => entry.error).map((entry) => `${entry.label}: ${entry.error}`)) summary.errors.push(error)
  summary.status = input.signal?.aborted ? 'cancelled' : summary.rows.some((row) => row.ok) ? 'ok' : summary.rows.length ? 'partial' : 'failed'
  summary.endedAt = now()
  save()
  return summary
}

function rowOf(version: { label: string; fingerprint: string }, task: RefineTask, runId: string, executorName: string, rollout: Rollout): MatrixRow {
  return {
    version: version.label,
    fingerprint: version.fingerprint,
    task: task.id,
    runId,
    dir: rollout.dir,
    ok: rollout.ok,
    delivered: rollout.delivered,
    costUsd: rollout.costUsd,
    wallMs: rollout.wallMs,
    error: rollout.error,
    taskHash: taskHash(task),
    executor: executorName,
    packageVersion: packageVersion()
  }
}

function failedRow(version: { label: string; fingerprint: string }, task: RefineTask, runId: string, executorName: string, error: string): MatrixRow {
  return rowOf(version, task, runId, executorName, { label: runId, runId, dir: '', ok: false, delivered: false, costUsd: 0, wallMs: 0, error })
}
