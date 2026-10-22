// One refinement: k shared base executions on the current harness, one recursion mode, blind
// selection of a final, reflection, and a library entry. Everything is written under
// `<data>/refine/<id>/` as it happens; `summary.json` is the record a person or an application
// reads.
//
// Shaped after Harness² (Apache-2.0, Google LLC; `harness2/core/schedule.py::run_task`).
import { join } from 'node:path'

import { now, readJson, safeId, writeJson } from '../core/fs'
import * as store from '../tree/store'
import { PI_SURFACE, type Tree } from '../tree/surface'
import { isUnchanged, writeTree } from '../tree/tree'
import { Library, hasExperience, type Experience } from './library'
import type { LedgerRecord } from './ledger'
import { mapLimit, modeRecord, runMode, type ModeRecord, type RecursionEvent } from './recursion'
import { reflectAdoption, runSelection, selectionPool, trivialSelection, type Selection } from './selection'
import type { Executor, Improver, RecursionMode, RefineTask, Rollout } from './types'

export type RefineStatus = 'running' | 'ok' | 'partial' | 'failed' | 'cancelled'

export interface RefineSummary {
  id: string
  taskId: string
  scope: string
  area: string
  k: number
  mode: RecursionMode
  status: RefineStatus
  startedAt: string
  endedAt: string | null
  /** The head the refinement started from. */
  baseFingerprint: string
  base: { label: string; runId: string; ok: boolean; delivered: boolean; error: string }[]
  recursion: ModeRecord | null
  selection: Selection | null
  /** The chosen harness, saved as a version of the scope without moving its head; null when it is the base. */
  chosenFingerprint: string | null
  chosenIsBase: boolean
  libraryEntry: string | null
  experience: Partial<Experience> | null
  usd: number
  errors: string[]
  /** The executor and improver settings the refinement was started with (PROP-0003). Run records hold what each run resolved. */
  settings?: { executor: RefineSettings | null; improver: RefineSettings | null }
}

export interface RefineSettings {
  model?: string | null
  effort?: string | null
  accountId?: string | null
  poolId?: string | null
}

export type RefineEvent =
  | RecursionEvent
  | { type: 'phase'; phase: 'base' | 'recursion' | 'selection' | 'reflection' | 'done' }
  | { type: 'summary'; summary: RefineSummary }

export interface RefineRunInput {
  root: string
  id: string
  task: RefineTask
  k: number
  mode: RecursionMode
  executor: Executor
  improver: Improver
  /** The selector; defaults to the improver. */
  selector?: Improver
  /** The harness to start from. Defaults to the scope's head. */
  baseTree?: Tree
  proposeWidth?: number
  rolloutWidth?: number
  /** Recorded on the summary only; the executor and improver already carry them. */
  settings?: { executor: RefineSettings | null; improver: RefineSettings | null }
  onEvent?: (event: RefineEvent) => void
  signal?: AbortSignal
}

export function refineDir(root: string, id: string): string {
  return join(root, 'refine', safeId(id))
}

export function readSummary(root: string, id: string): RefineSummary | null {
  return readJson<RefineSummary>(join(refineDir(root, id), 'summary.json'))
}

const modeToken = (mode: RecursionMode): 'agg' | 'seq' => (mode === 'parallel' ? 'agg' : 'seq')

/** Runs one refinement to the end. Failures are recorded on the summary; only bad input throws. */
export async function runRefinement(input: RefineRunInput): Promise<RefineSummary> {
  const { root, id, task, k, mode, executor, improver } = input
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error('k must be a whole number from 1 to 8.')
  safeId(task.scope)
  const workDir = refineDir(root, id)
  const area = task.domain ?? task.scope
  const baseTree = input.baseTree ?? store.headTree(root, task.scope)?.tree
  if (!baseTree) throw new Error(`The harness '${task.scope}' has no version to start from.`)
  const baseFingerprint = store.fingerprint(baseTree)
  const library = new Library(root, task.scope, area)
  const runIdOf = (label: string) => `${id}-${label}`
  const emit = (event: RefineEvent) => input.onEvent?.(event)

  const summary: RefineSummary = {
    id,
    taskId: task.id,
    scope: task.scope,
    area,
    k,
    mode,
    status: 'running',
    startedAt: now(),
    endedAt: null,
    baseFingerprint,
    base: [],
    recursion: null,
    selection: null,
    chosenFingerprint: null,
    chosenIsBase: false,
    libraryEntry: null,
    experience: null,
    usd: 0,
    errors: [],
    ...(input.settings ? { settings: input.settings } : {})
  }
  const save = () => {
    writeJson(join(workDir, 'summary.json'), summary)
    emit({ type: 'summary', summary: structuredClone(summary) })
  }
  const finish = (status: RefineStatus) => {
    summary.status = input.signal?.aborted ? 'cancelled' : status
    summary.endedAt = now()
    save()
    emit({ type: 'phase', phase: 'done' })
    return summary
  }
  writeJson(join(workDir, 'task.json'), { task, k, mode })
  save()

  // The library a refinement reads is the one before it, so the record of what it read is stable.
  const libraryDir = library.contextDir()

  emit({ type: 'phase', phase: 'base' })
  const baseDir = writeTree(PI_SURFACE, baseTree, join(workDir, 'harnesses', 'base'))
  const labels = Array.from({ length: k }, (_, i) => `base${i + 1}`)
  const base: Rollout[] = await mapLimit(labels, input.rolloutWidth ?? 4, async (label) => {
    emit({ type: 'rollout.started', label })
    let rollout: Rollout
    try {
      if (input.signal?.aborted) throw new Error('Refinement was cancelled.')
      rollout = await executor.execute(task, baseDir, label, runIdOf(label))
    } catch (error) {
      rollout = { label, runId: runIdOf(label), dir: join(workDir, 'missing', label), ok: false, delivered: false, costUsd: 0, wallMs: 0, error: error instanceof Error ? error.message : String(error) }
    }
    emit({ type: 'rollout.finished', label, ok: rollout.ok, delivered: rollout.delivered, error: rollout.error })
    return rollout
  })
  summary.base = base.map((r) => ({ label: r.label, runId: r.runId, ok: r.ok, delivered: r.delivered, error: r.error }))
  if (!base.some((rollout) => rollout.ok)) {
    summary.errors.push('no base rollout produced anything')
    summary.usd = base.reduce((sum, r) => sum + r.costUsd, 0)
    return finish('failed')
  }
  save()

  emit({ type: 'phase', phase: 'recursion' })
  let result
  try {
    result = await runMode(mode, { task, executor, improver, workDir, runIdOf, baseTree, libraryDir, proposeWidth: input.proposeWidth, rolloutWidth: input.rolloutWidth, onEvent: emit, signal: input.signal }, k, base)
  } catch (error) {
    summary.errors.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`)
    return finish(input.signal?.aborted ? 'cancelled' : 'failed')
  }
  summary.recursion = modeRecord(result)
  summary.usd = result.ledger.usd()
  save()

  emit({ type: 'phase', phase: 'selection' })
  const token = modeToken(mode)
  const candidates = selectionPool(token, k, result.rollouts)
  const sel = k === 1
    ? trivialSelection({ task, k, mode: token, candidates, executor, workDir })
    : await runSelection({ task, k, mode: token, candidates, executor, improver: input.selector ?? improver, workDir, signal: input.signal })
  summary.selection = sel
  if (!sel.ok) summary.errors.push(`${mode}: selection failed: ${sel.error}`)
  const chosen = candidates[sel.chosenLabel]
  if (chosen && !chosen.delivered) summary.errors.push(`${mode}: selected run ${chosen.runId} produced no deliverable`)

  const chosenTree = result.trees[sel.chosenLabel] ?? baseTree
  summary.chosenIsBase = isUnchanged(PI_SURFACE, baseTree, chosenTree)
  if (sel.chosenLabel && !summary.chosenIsBase) {
    try {
      summary.chosenFingerprint = store.commit(root, task.scope, chosenTree, { kind: 'refinement', refineId: id, label: sel.chosenLabel, note: sel.why.slice(0, 500) }, { moveHead: false }).fingerprint
    } catch (error) {
      summary.errors.push(`could not save the chosen harness: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  save()

  if (sel.ok) {
    emit({ type: 'phase', phase: 'reflection' })
    const decisions = Object.fromEntries(result.stages.map((stage) => [stage.label, stage.notes || stage.error]))
    const experience = await reflectAdoption({ task, selection: sel, rollouts: result.rollouts, executor, improver: input.selector ?? improver, workDir, baseTree, decisions, signal: input.signal })
    summary.experience = Object.keys(experience).length ? experience : null
    if (hasExperience(experience)) {
      try {
        summary.libraryEntry = library.add(task.id, chosenTree, { why: sel.why, label: sel.chosenLabel, runId: sel.chosenRunId, experience })
      } catch (error) {
        summary.errors.push(`could not add to the library: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  summary.usd = Math.round((result.ledger.usd() + sel.usd) * 1e6) / 1e6
  const ok = summary.recursion.ok && sel.ok && Boolean(sel.chosenLabel) && !summary.errors.length
  return finish(ok ? 'ok' : sel.chosenLabel ? 'partial' : 'failed')
}

export type { LedgerRecord }
