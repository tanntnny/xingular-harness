// Choosing one anonymised final output, then reflecting on the refinement that produced it.
// The selector sees only the request, the source and the outputs, shuffled under arbitrary ids;
// it never sees a harness, a trajectory, or any verdict.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/selection.py`).
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJson } from '../core/fs'
import { PI_SURFACE, type Tree } from '../tree/surface'
import { writeTree } from '../tree/tree'
import * as evidence from './evidence'
import type { Experience } from './library'
import * as P from './prompts'
import { defaultPrompts } from './recursion'
import { ImproverError, type Executor, type Improver, type RefineTask, type Rollout } from './types'

export interface Selection {
  taskId: string
  mode: 'agg' | 'seq'
  k: number
  chosenId: string
  chosenLabel: string
  chosenRunId: string
  chosenDir: string
  why: string
  idMap: Record<string, string>
  dropped: string[]
  candidates: number
  ok: boolean
  fallback: boolean
  trivial: boolean
  error: string
  usd: number
  experience: Partial<Experience>
}

/** A seeded mulberry32, so a shuffle is stable across reruns of the same task. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A..Z, AA..AZ, BA...: always accepted by the choice parser. */
export function anonId(index: number): string {
  let out = ''
  let n = index + 1
  while (n) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** anon id → label, by canonical sort then a seeded shuffle. */
export function assignIds(labels: readonly string[], taskId: string, k: number, mode: string): Record<string, string> {
  const seed = parseInt(createHash('sha1').update(`${taskId}|${k}|${mode}`).digest('hex').slice(0, 8), 16)
  const ordered = [...labels].sort()
  const random = seeded(seed)
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]
  }
  return Object.fromEntries(ordered.map((label, i) => [anonId(i), label]))
}

/** Exactly the k finals of a mode: agg1..aggk or c1..ck. The base executions are never in it. */
export function selectionPool(mode: 'agg' | 'seq', k: number, rollouts: Record<string, Rollout>): Record<string, Rollout> {
  const labels = Array.from({ length: k }, (_, i) => (mode === 'agg' ? `agg${i + 1}` : `c${i + 1}`))
  return Object.fromEntries(labels.filter((label) => rollouts[label]).map((label) => [label, rollouts[label]!]))
}

function newSelection(taskId: string, mode: 'agg' | 'seq', k: number): Selection {
  return { taskId, mode, k, chosenId: '', chosenLabel: '', chosenRunId: '', chosenDir: '', why: '', idMap: {}, dropped: [], candidates: 0, ok: false, fallback: false, trivial: false, error: '', usd: 0, experience: {} }
}

/** Drops non-answers before anonymising, recording each drop and its cause. */
function renderPool(candidates: Record<string, Rollout>, executor: Executor, sel: Selection): { pool: Record<string, Rollout>; artifacts: Record<string, string> } {
  const pool: Record<string, Rollout> = {}
  const artifacts: Record<string, string> = {}
  for (const [label, rollout] of Object.entries(candidates)) {
    if (!(rollout.ok && rollout.delivered)) {
      sel.dropped.push(label)
      continue
    }
    let text = ''
    try {
      text = evidence.renderDeliverable(executor, rollout)
    } catch (error) {
      sel.dropped.push(`${label} (render failed: ${error instanceof Error ? error.message : String(error)})`.slice(0, 200))
      continue
    }
    if (!text.trim()) {
      sel.dropped.push(label)
      continue
    }
    pool[label] = rollout
    artifacts[label] = text
  }
  return { pool, artifacts }
}

function persist(sel: Selection, root: string): void {
  try {
    writeJson(join(root, 'selection.json'), sel)
  } catch (error) {
    sel.ok = false
    sel.error = `${sel.error} | could not persist selection: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400)
  }
}

function choose(sel: Selection, label: string, pool: Record<string, Rollout>): void {
  sel.chosenLabel = label
  sel.chosenId = Object.entries(sel.idMap).find(([, l]) => l === label)?.[0] ?? ''
  sel.chosenRunId = pool[label]?.runId ?? ''
  sel.chosenDir = pool[label]?.dir ?? ''
}

export interface SelectInput {
  task: RefineTask
  k: number
  mode: 'agg' | 'seq'
  candidates: Record<string, Rollout>
  executor: Executor
  improver: Improver
  workDir: string
  signal?: AbortSignal
}

/** Picks one output. A selector failure falls back to the first final and never throws. */
export async function runSelection(input: SelectInput): Promise<Selection> {
  const { task, k, mode, executor } = input
  const sel = newSelection(task.id, mode, k)
  const { pool, artifacts } = renderPool(input.candidates, executor, sel)
  sel.candidates = Object.keys(pool).length
  if (!sel.candidates) {
    sel.error = 'no candidate produced an artifact'
    return sel
  }
  sel.idMap = assignIds(Object.keys(pool), task.id, k, mode)
  const root = join(input.workDir, 'selection', `${mode}${k}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'candidates'), { recursive: true })
  writeFileSync(join(root, 'task.md'), task.prompt)
  evidence.copySource(task, root)
  for (const [anon, label] of Object.entries(sel.idMap)) {
    const text = artifacts[label]!
    writeFileSync(join(root, 'candidates', `${anon}.md`), `<!-- candidate ${anon}: ${text.length.toLocaleString('en-US')} chars, ${(text.split('\n').length).toLocaleString('en-US')} lines. COMPLETE -- nothing trimmed. Navigate with grep/offsets; evaluating a candidate means opening the part that determines whether it works. -->\n${text}`)
  }
  const ids = Object.keys(sel.idMap).sort().join(', ')
  const mission = [
    P.select(task.prompts ?? defaultPrompts(), sel.candidates, { poolKind: 'finals' }),
    `# YOUR EVIDENCE\n\nIt is on disk. Read it -- do not answer from this message alone.\n\ncontext/task.md                 the instructions\ncontext/source/                 task source materials, when supplied\ncontext/candidates/<id>.md      one file per candidate: ${ids}\n\nOpen every candidate before choosing. Choose exactly one of: ${ids}.`
  ].join('\n\n')
  evidence.assertNoGraderVerdicts(root)
  try {
    const reply = await input.improver.call({ mission, contextDir: root, label: `select.${mode}${k}`, signal: input.signal })
    sel.usd += reply.costUsd
    const choice = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?\s*```/.exec(reply.text)?.[1]?.trim()
    if (!choice) throw new Error('no ```choice block in the reply')
    if (!sel.idMap[choice]) throw new Error(`chose '${choice}', which is not one of ${ids}`)
    sel.why = (/<why>([\s\S]*?)<\/why>/.exec(reply.text)?.[1]?.trim() ?? '').slice(0, 2000)
    sel.ok = true
    choose(sel, sel.idMap[choice]!, pool)
  } catch (error) {
    if (error instanceof ImproverError) sel.usd += error.costUsd
    // The neutral stand-in: the first final in canonical order. It is delivered, but the
    // selection did not succeed, so nothing is reflected on or added to the library.
    choose(sel, Object.keys(pool).sort()[0]!, pool)
    sel.fallback = true
    sel.ok = false
    sel.error = (error instanceof Error ? error.message : String(error)).slice(0, 400)
  }
  persist(sel, root)
  return sel
}

/** Delivers the single k=1 final without a selector session. */
export function trivialSelection(input: Omit<SelectInput, 'improver' | 'signal'>): Selection {
  const { task, k, mode } = input
  if (Object.keys(input.candidates).length > 1) throw new Error(`trivialSelection expects at most one candidate, got ${Object.keys(input.candidates).sort().join(', ')}`)
  const sel = newSelection(task.id, mode, k)
  sel.trivial = true
  const { pool } = renderPool(input.candidates, input.executor, sel)
  sel.candidates = Object.keys(pool).length
  if (!sel.candidates) {
    sel.error = 'no candidate produced an artifact (the finals-only pool has no base fallback)'
    return sel
  }
  const label = Object.keys(pool)[0]!
  sel.idMap = { A: label }
  choose(sel, label, pool)
  sel.ok = true
  sel.why = 'trivial pool: single final at k=1; delivered without a selector session'
  const root = join(input.workDir, 'selection', `${mode}${k}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  persist(sel, root)
  return sel
}

export interface ReflectInput {
  task: RefineTask
  selection: Selection
  rollouts: Record<string, Rollout>
  executor: Executor
  improver: Improver
  workDir: string
  baseTree: Tree
  decisions?: Record<string, string>
  signal?: AbortSignal
}

/** Learns from the edits, decisions, trajectories and outputs after adoption. Never throws. */
export async function reflectAdoption(input: ReflectInput): Promise<Partial<Experience>> {
  const { task, selection: sel } = input
  const chosen = input.rollouts[sel.chosenLabel]
  if (!sel.ok || !chosen) return {}
  const root = join(input.workDir, 'reflection', `${sel.mode}${sel.k}`)
  const harnesses = join(input.workDir, 'harnesses')
  let layout = ''
  try {
    const built = evidence.build(root, {
      task,
      executor: input.executor,
      rollouts: Object.values(input.rollouts),
      harnessDir: join(harnesses, sel.chosenLabel),
      pool: Object.entries(input.rollouts).filter(([label]) => !label.startsWith('base')).map(([label, rollout]) => ({ label, harnessDir: join(harnesses, label), rollout })),
      decisions: input.decisions
    })
    layout = evidence.layout(built)
    writeTree(PI_SURFACE, input.baseTree, join(root, 'base_harness'), { stubs: false })
    writeFileSync(join(root, 'adoption.json'), `${JSON.stringify({ chosen_label: sel.chosenLabel, candidate_ids: sel.idMap, reason: sel.why }, null, 2)}\n`)
    evidence.assertNoLeakPaths(root, task.leakGlobs)
    evidence.assertNoGraderVerdicts(root)
  } catch {
    return {}
  }
  const mission = [
    P.experience(task.prompts ?? defaultPrompts()),
    `# WHAT HAPPENED\n\nHarness ${sel.chosenLabel} was adopted. The selection reasoning was:\n\n${sel.why}\n\ncontext/adoption.json maps any anonymous IDs in that reasoning to rollout labels. Compare context/harness/ with context/base_harness/ and the candidates in context/pool/. Read the decisions and execution contrasts before writing.\n\n${layout}`
  ].join('\n\n')
  const expRoot = `${root}.experience`
  rmSync(expRoot, { recursive: true, force: true })
  cpSync(root, expRoot, { recursive: true })
  let text: string
  try {
    const reply = await input.improver.call({ mission, contextDir: expRoot, label: `experience.${sel.mode}${sel.k}`, signal: input.signal })
    sel.usd += reply.costUsd
    text = reply.text
  } catch (error) {
    if (error instanceof ImproverError) sel.usd += error.costUsd
    return {}
  }
  const out = parseExperience(text)
  if (out.edits) writeFileSync(join(root, 'edits.md'), `${out.edits}\n`)
  try {
    evidence.assertTreeHasNoGraderVerdicts({ 'EXPERIENCE.md': JSON.stringify(out) })
  } catch {
    return {}
  }
  sel.experience = out
  persist(sel, join(input.workDir, 'selection', `${sel.mode}${sel.k}`))
  return out
}

/** Reads `<edits>` and `<experience>` blocks. A reply without a supported lesson gives only the edits. */
export function parseExperience(text: string): Partial<Experience> {
  const edits = /<edits>([\s\S]*?)<\/edits>/.exec(text)?.[1]?.trim()
  const block = /<experience>([\s\S]*?)<\/experience>/.exec(text)?.[1]
  const out: Partial<Experience> = {}
  if (block) {
    for (const line of block.trim().split('\n')) {
      const at = line.indexOf(':')
      if (at < 0) continue
      const key = line.slice(0, at).trim().toLowerCase()
      if (key === 'cue' || key === 'lesson' || key === 'evidence' || key === 'confidence') out[key] = line.slice(at + 1).trim()
    }
  }
  if (!out.cue || !out.lesson || !out.evidence) return edits ? { edits } : {}
  if (edits) out.edits = edits
  return out
}
