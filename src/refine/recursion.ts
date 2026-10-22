// Task-level recursion, parallel and sequential. Each mode schedules 4k rollouts and 3k
// improvement stages, including the shared base executions. An invalid proposal gets one retry
// with the validator's message, then inherits the current harness.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/recursion.py`).
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { PI_SURFACE, type Variant } from '../variant/surface'
import { autotrigger, diversity, isUnchanged, readVariant, VariantError, validate, writeVariant } from '../variant/variant'
import * as evidence from './evidence'
import { Ledger, type LedgerRecord } from './ledger'
import * as P from './prompts'
import { ImproverError, type Executor, type Improver, type RefineTask, type Rollout } from './types'

export const STAGE_ATTEMPTS = 2

export type StageDim = 'INV' | 'DOM' | 'AGG' | 'COMPOSE'

export interface Stage {
  label: string
  dim: StageDim
  variant: Variant
  keptBase: boolean
  fellBack: boolean
  error: string
  usd: number
  attempts: number
  cached: boolean
  notes: string
}

export interface StageRecord extends Omit<Stage, 'variant'> {}

export interface ModeResult {
  mode: 'agg' | 'seq'
  taskId: string
  k: number
  stages: Stage[]
  variants: Record<string, Variant>
  rollouts: Record<string, Rollout>
  finals: string[]
  ledger: Ledger
  similarity: ReturnType<typeof diversity> | null
  errors: string[]
}

export interface ModeRecord {
  mode: 'agg' | 'seq'
  taskId: string
  k: number
  finals: string[]
  ok: boolean
  fellBack: string[]
  keptBase: string[]
  stages: StageRecord[]
  similarity: ReturnType<typeof diversity> | null
  ledger: LedgerRecord
  errors: string[]
}

export function modeRecord(result: ModeResult): ModeRecord {
  return {
    mode: result.mode,
    taskId: result.taskId,
    k: result.k,
    finals: result.finals,
    ok: result.finals.length > 0 && result.errors.length === 0,
    fellBack: result.stages.filter((stage) => stage.fellBack).map((stage) => stage.label),
    keptBase: result.stages.filter((stage) => stage.keptBase).map((stage) => stage.label),
    stages: result.stages.map(({ variant: _tree, ...rest }) => ({ ...rest, error: rest.error.slice(0, 400) })),
    similarity: result.similarity,
    ledger: result.ledger.toRecord(),
    errors: result.errors
  }
}

/** Progress a caller may show while a mode runs. */
export type RecursionEvent =
  | { type: 'stage.started'; label: string; dim: StageDim }
  | { type: 'stage.finished'; label: string; dim: StageDim; fellBack: boolean; keptBase: boolean; error: string }
  | { type: 'rollout.started'; label: string }
  | { type: 'rollout.finished'; label: string; ok: boolean; delivered: boolean; error: string }

export interface RecursionContext {
  task: RefineTask
  executor: Executor
  improver: Improver
  workDir: string
  runIdOf: (label: string) => string
  baseVariant: Variant
  libraryDir?: string | null
  /** How many improver sessions run at once. */
  proposeWidth?: number
  /** How many rollouts run at once. */
  rolloutWidth?: number
  onEvent?: (event: RecursionEvent) => void
  signal?: AbortSignal
}

/** Runs `fn` over `items` with at most `width` at a time, keeping input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Refinement was cancelled.')
}

/** Repairs, then validates, a proposed variant. Returns whether it equals the fallback and any error. */
export function acceptVariant(task: RefineTask, executor: Executor, next: Variant, fallback: Variant): { keptBase: boolean; error: string } {
  autotrigger(PI_SURFACE, next)
  const keptBase = isUnchanged(PI_SURFACE, fallback, next)
  try {
    validate(PI_SURFACE, next, { allowSubagents: task.allowSubagents !== false })
    executor.validateVariant?.(task, next)
    evidence.assertVariantHasNoGraderVerdicts(next)
  } catch (error) {
    return { keptBase, error: error instanceof VariantError ? error.problems.join(' | ') : error instanceof Error ? error.message : String(error) }
  }
  return { keptBase, error: '' }
}

interface StageInput {
  label: string
  dim: StageDim
  job: string
  fallback: Variant
  rollouts: readonly Rollout[]
  variantDir: string
  pool?: readonly evidence.PoolEntry[]
  decisions?: Record<string, string>
}

/** Builds evidence, asks for an edit, and retries an invalid one once. Never throws. */
export async function runStage(ctx: RecursionContext, input: StageInput): Promise<Stage> {
  const { label, dim, fallback } = input
  ctx.onEvent?.({ type: 'stage.started', label, dim })
  const finish = (stage: Stage): Stage => {
    ctx.onEvent?.({ type: 'stage.finished', label, dim, fellBack: stage.fellBack, keptBase: stage.keptBase, error: stage.error })
    return stage
  }
  let folder: evidence.EvidenceFolder
  let mission: string
  try {
    folder = evidence.build(join(ctx.workDir, 'context', label), {
      task: ctx.task,
      executor: ctx.executor,
      rollouts: input.rollouts,
      variantDir: input.variantDir,
      libraryDir: ctx.libraryDir,
      pool: input.pool,
      decisions: input.decisions
    })
    mission = evidence.mission(folder, input.job)
  } catch (error) {
    return finish({ label, dim, variant: { ...fallback }, keptBase: false, fellBack: true, error: `could not build evidence: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400), usd: 0, attempts: 0, cached: false, notes: '' })
  }

  let err = ''
  let usd = 0
  let attempts = 0
  let allCached = true
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    if (ctx.signal?.aborted) {
      err = 'cancelled'
      break
    }
    let reply
    try {
      reply = await ctx.improver.call({
        mission: mission + (err ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\nFix it in \`context/harness/\` and reply again.` : ''),
        contextDir: folder.root,
        label: `${label}.a${attempt}`,
        harvest: 'context/harness',
        signal: ctx.signal
      })
    } catch (error) {
      err = error instanceof Error ? error.message : String(error)
      attempts += error instanceof ImproverError ? error.attempts || 1 : 1
      usd += error instanceof ImproverError ? error.costUsd : 0
      allCached = false
      break
    }
    usd += reply.costUsd
    attempts += reply.cached ? 0 : Math.max(1, reply.attempts)
    allCached = allCached && reply.cached
    if (!reply.workspace || !existsSync(reply.workspace)) {
      err = 'the harness directory did not come back from the session; edit the files in `context/harness/` in place'
      continue
    }
    const rejected: string[] = []
    const next = readVariant(PI_SURFACE, reply.workspace, rejected)
    if (!Object.keys(next).length) {
      err = '`context/harness/` came back empty -- edit the files, do not delete them all'
      continue
    }
    if (rejected.length) {
      err = `these files are off the editable surface and were not applied: ${rejected.sort().slice(0, 6).join(', ')}. Component names must be lowercase letters, digits, \`_\` or \`-\` (e.g. \`skills/doc_review/SKILL.md\`, \`scripts/check_totals.py\`).`
      continue
    }
    const accepted = acceptVariant(ctx.task, ctx.executor, next, fallback)
    if (accepted.error) {
      err = accepted.error
      // The next attempt edits what came back, so it fixes rather than restarts.
      writeVariant(PI_SURFACE, next, join(folder.root, 'harness'))
      continue
    }
    const notes = /<notes>([\s\S]*?)<\/notes>/.exec(reply.text)?.[1]?.trim() ?? reply.text.trim()
    return finish({ label, dim, variant: next, keptBase: accepted.keptBase, fellBack: false, error: '', usd, attempts, cached: allCached, notes })
  }
  return finish({ label, dim, variant: { ...fallback }, keptBase: false, fellBack: true, error: err.slice(0, 400), usd, attempts, cached: allCached, notes: '' })
}

function recordSessions(ledger: Ledger, stages: readonly Stage[]): void {
  for (const stage of stages) ledger.session(stage.label, stage.usd, { cached: stage.cached, attempts: stage.attempts })
}

/** Writes a harness and rolls it once. A dead rollout is recorded, never thrown. */
async function roll(ctx: RecursionContext, label: string, variant: Variant): Promise<Rollout> {
  const variantDir = writeVariant(PI_SURFACE, variant, join(ctx.workDir, 'variants', label))
  const runId = ctx.runIdOf(label)
  ctx.onEvent?.({ type: 'rollout.started', label })
  let rollout: Rollout
  try {
    checkAborted(ctx.signal)
    rollout = await ctx.executor.execute(ctx.task, variantDir, label, runId)
  } catch (error) {
    rollout = { label, runId, dir: join(ctx.workDir, 'missing', label), ok: false, delivered: false, costUsd: 0, wallMs: 0, error: error instanceof Error ? error.message : String(error) }
  }
  ctx.onEvent?.({ type: 'rollout.finished', label, ok: rollout.ok, delivered: rollout.delivered, error: rollout.error })
  return rollout
}

/** Rolls independent harnesses concurrently, then records them in the caller's order. */
async function rollMany(ctx: RecursionContext, ledger: Ledger, items: readonly (readonly [string, Variant])[]): Promise<Record<string, Rollout>> {
  const got = await mapLimit(items, ctx.rolloutWidth ?? 4, ([label, variant]) => roll(ctx, label, variant))
  const out: Record<string, Rollout> = {}
  items.forEach(([label], i) => {
    ledger.rollout(label, got[i]!.costUsd)
    out[label] = got[i]!
  })
  return out
}

function newResult(mode: 'agg' | 'seq', ctx: RecursionContext, k: number, base: readonly Rollout[]): ModeResult {
  const ledger = new Ledger(mode, ctx.task.id, k)
  for (const rollout of base) ledger.rollout(rollout.label, rollout.costUsd)
  return { mode, taskId: ctx.task.id, k, stages: [], variants: {}, rollouts: Object.fromEntries(base.map((rollout) => [rollout.label, rollout])), finals: [], ledger, similarity: null, errors: [] }
}

const variantPath = (ctx: RecursionContext, label: string): string => join(ctx.workDir, 'variants', label)

/** WIDTH: 2k independent candidates from shared evidence, then k independent compositions. */
export async function runParallel(ctx: RecursionContext, k: number, base: readonly Rollout[]): Promise<ModeResult> {
  const result = newResult('agg', ctx, k, base)
  const prompts = ctx.task.prompts ?? defaultPrompts()
  const baseDir = writeVariant(PI_SURFACE, ctx.baseVariant, variantPath(ctx, 'base'))

  const specs: [string, 'INV' | 'DOM', number][] = []
  for (let i = 1; i <= k; i++) for (const dim of ['INV', 'DOM'] as const) specs.push([`${dim.toLowerCase()}${i}`, dim, i])
  const stages = await mapLimit(specs, ctx.proposeWidth ?? 4, ([label, dim, index]) =>
    runStage(ctx, { label, dim, job: P.propose(prompts, dim, { k, index }), fallback: ctx.baseVariant, rollouts: base, variantDir: baseDir })
  )
  recordSessions(result.ledger, stages)
  for (const stage of stages) {
    result.stages.push(stage)
    result.variants[stage.label] = stage.variant
  }
  Object.assign(result.rollouts, await rollMany(ctx, result.ledger, stages.map((stage) => [stage.label, stage.variant] as const)))

  const pool = stages.map((stage) => ({ label: stage.label, variantDir: variantPath(ctx, stage.label), rollout: result.rollouts[stage.label] ?? null }))
  const decisions = Object.fromEntries(stages.map((stage) => [stage.label, stage.notes || stage.error]))
  const aggs = await mapLimit(Array.from({ length: k }, (_, i) => i + 1), ctx.proposeWidth ?? 4, (index) =>
    runStage(ctx, { label: `agg${index}`, dim: 'AGG', job: P.aggregate(prompts, { k, index }), fallback: ctx.baseVariant, rollouts: base, variantDir: baseDir, pool, decisions })
  )
  recordSessions(result.ledger, aggs)
  for (const stage of aggs) {
    result.stages.push(stage)
    result.variants[stage.label] = stage.variant
    result.finals.push(stage.label)
  }
  Object.assign(result.rollouts, await rollMany(ctx, result.ledger, aggs.map((stage) => [stage.label, stage.variant] as const)))
  result.similarity = diversity(Object.fromEntries(aggs.map((stage) => [stage.label, stage.variant])))
  result.ledger.assertIdentity()
  return result
}

/** DEPTH: k nested passes over the same shared base evidence. */
export async function runSequential(ctx: RecursionContext, k: number, base: readonly Rollout[]): Promise<ModeResult> {
  const result = newResult('seq', ctx, k, base)
  const prompts = ctx.task.prompts ?? defaultPrompts()
  let current = { ...ctx.baseVariant }
  let history: evidence.PoolEntry[] = []
  for (let t = 1; t <= k; t++) {
    checkAborted(ctx.signal)
    const currentLabel = t > 1 ? `c${t - 1}` : 'base'
    const currentDir = writeVariant(PI_SURFACE, current, variantPath(ctx, currentLabel))
    const decisions = () => Object.fromEntries(result.stages.map((stage) => [stage.label, stage.notes || stage.error]))
    const specs: [string, 'INV' | 'DOM'][] = [[`inv${t}`, 'INV'], [`dom${t}`, 'DOM']]
    const before = decisions()
    const fallback = current
    const stages = await mapLimit(specs, Math.min(2, ctx.proposeWidth ?? 2), ([label, dim]) =>
      runStage(ctx, { label, dim, job: P.propose(prompts, dim, { k, index: t, roundT: k > 1 ? t : null }), fallback, rollouts: base, variantDir: currentDir, pool: [...history], decisions: before })
    )
    recordSessions(result.ledger, stages)
    for (const stage of stages) {
      result.stages.push(stage)
      result.variants[stage.label] = stage.variant
    }
    Object.assign(result.rollouts, await rollMany(ctx, result.ledger, stages.map((stage) => [stage.label, stage.variant] as const)))
    const roundPool = [...history, ...stages.map((stage) => ({ label: stage.label, variantDir: variantPath(ctx, stage.label), rollout: result.rollouts[stage.label] ?? null }))]
    const ck = `c${t}`
    const job = k === 1 ? P.aggregate(prompts, { k: 1, index: 1 }) : P.composeRound(prompts, { t, k })
    const comp = await runStage(ctx, { label: ck, dim: 'COMPOSE', job, fallback: current, rollouts: base, variantDir: currentDir, pool: roundPool, decisions: decisions() })
    recordSessions(result.ledger, [comp])
    result.stages.push(comp)
    result.variants[ck] = comp.variant
    const rolled = await roll(ctx, ck, comp.variant)
    result.ledger.rollout(ck, rolled.costUsd)
    result.rollouts[ck] = rolled
    history = [...roundPool, { label: ck, variantDir: variantPath(ctx, ck), rollout: rolled }]
    current = comp.variant
  }
  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`)
  result.ledger.assertIdentity()
  return result
}

export function defaultPrompts(): P.WorkPrompts {
  return {
    work: 'The work is the request in `context/task.md`, done for the person who asked for it, with the tools this agent has.',
    domainWord: 'area'
  }
}

export function runMode(mode: 'parallel' | 'sequential', ctx: RecursionContext, k: number, base: readonly Rollout[]): Promise<ModeResult> {
  return mode === 'parallel' ? runParallel(ctx, k, base) : runSequential(ctx, k, base)
}

/** Reads a harness a stage wrote, for callers that hold only labels. */
export function stageVariant(workDir: string, label: string): Variant {
  return readVariant(PI_SURFACE, variantPath({ workDir } as RecursionContext, label))
}
