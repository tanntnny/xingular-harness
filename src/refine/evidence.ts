// The evidence folder an improver reads. Evidence is served as files and the prompt is a short
// pointer, so nothing is truncated to fit a prompt:
//
//   context/task.md                  the task as the agent received it
//   context/source/                  the material it was done from
//   context/rollouts/<label>.md      full trajectories
//   context/deliverables/<label>/    what each rollout produced
//   context/harness/<rel>            the tree being edited
//   context/library/INDEX.md         earlier tasks in this area and their full harnesses
//   context/pool/<label>/            candidate harnesses, their diffs and rollouts
//   context/decisions/<label>.md     earlier edit and composition notes
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/context.py`).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'

import { PI_SURFACE, type Tree } from '../tree/surface'
import { readTree } from '../tree/tree'
import type { Executor, RefineTask, Rollout } from './types'

/** Strings that only a grader's own output contains. A tripwire, not the defence itself. */
export const GRADER_VERDICT_MARKERS = [
  'deterministic_eval_summary',
  'deterministic_eval_result',
  'judge_scope_and_deterministic_status',
  'Judge findings on the rendered result',
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"',
  'review_verdict',
  '"reviewVerdict"'
] as const

const SCANNED = new Set(['.md', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.htm', '.log', '.py', '.js', '.mjs', '.ts', '.sh', '.xml', '.ini', '.toml', '.patch', '.diff', ''])

/** Minimum per-observation truncation; lower values fabricate defects. */
export const MIN_OBS_TRUNC = 10_000

function files(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...files(path))
    else out.push(path)
  }
  return out
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  for (const ch of pattern) {
    if (ch === '*') out += '[^]*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^(?:[^]*/)?${out}$`)
}

/** Refuses a folder holding a path the task marks as an answer key. */
export function assertNoLeakPaths(root: string, globs: readonly string[] = []): void {
  if (!globs.length || !existsSync(root)) return
  const rx = globs.map(globToRegExp)
  const hits = files(root).map((path) => rel(root, path)).filter((path) => rx.some((r) => r.test(path)))
  if (hits.length) throw new Error(`answer-key path(s) would enter model context: ${hits.sort().slice(0, 8).join(', ')}`)
}

/** Refuses a folder containing a grader's output, by file name and by content. */
export function assertNoGraderVerdicts(root: string, markers: readonly string[] = GRADER_VERDICT_MARKERS): void {
  if (!existsSync(root)) return
  for (const path of files(root)) {
    const name = rel(root, path)
    for (const marker of markers) {
      if (name.includes(marker)) throw new Error(`grader verdict would enter model context: '${name}' matched marker '${marker}' in its NAME. Find the read path that produced it.`)
    }
    if (!SCANNED.has(extname(path).toLowerCase())) continue
    let body: string
    try {
      body = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const marker of markers) {
      const at = body.indexOf(marker)
      if (at >= 0) throw new Error(`grader verdict would enter model context: '${name}' contains marker '${marker}' at offset ${at}. Find the read path that produced it.`)
    }
  }
}

/** The same tripwire on a tree, before it is rolled or stored. */
export function assertTreeHasNoGraderVerdicts(tree: Record<string, string>, markers: readonly string[] = GRADER_VERDICT_MARKERS): void {
  for (const [name, body] of Object.entries(tree).sort()) {
    for (const marker of markers) {
      if (name.includes(marker)) throw new Error(`harness file '${name}' has grader-verdict marker '${marker}' in its NAME; rename it`)
      if (SCANNED.has(extname(name).toLowerCase()) && body.includes(marker)) throw new Error(`harness file '${name}' contains grader-verdict marker '${marker}'; remove that string -- files carrying it cannot be served as evidence to later tasks`)
    }
  }
}

function copyFolder(src: string, dst: string): number {
  let n = 0
  for (const path of files(src)) {
    if (path.includes(`${sep}__pycache__${sep}`) || path.endsWith('.pyc')) continue
    const target = join(dst, relative(src, path))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(path, target)
    n++
  }
  return n
}

/** Copies the task's source material under `root/source`, minus answer-key paths. */
export function copySource(task: RefineTask, root: string): number {
  const src = task.sourceDir
  if (!src || !existsSync(src)) return 0
  const leak = (task.leakGlobs ?? []).map(globToRegExp)
  let n = 0
  for (const path of files(src)) {
    const name = rel(src, path)
    if (name.split('/').includes('__pycache__') || leak.some((r) => r.test(name))) continue
    const target = join(root, 'source', name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(path, target)
    n++
  }
  if (n) assertNoLeakPaths(join(root, 'source'), task.leakGlobs)
  return n
}

/** A line-based unified diff, enough for a reader to see what changed. */
export function unifiedDiff(before: Tree, after: Tree, fromLabel: string, toLabel: string): string {
  const out: string[] = []
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[name] ?? ''
    const b = after[name] ?? ''
    if (a === b) continue
    out.push(`--- ${fromLabel}/${name}`, `+++ ${toLabel}/${name}`)
    const x = a ? a.split('\n') : []
    const y = b ? b.split('\n') : []
    // A longest-common-subsequence walk; trees are small enough for the quadratic table.
    const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        out.push(` ${x[i]}`)
        i++
        j++
      } else if (j < y.length && (i >= x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
        out.push(`+${y[j]}`)
        j++
      } else {
        out.push(`-${x[i]}`)
        i++
      }
    }
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

export interface PoolEntry {
  label: string
  /** The candidate's harness folder, or null. */
  harnessDir: string | null
  rollout: Rollout | null
}

export interface EvidenceTree {
  root: string
  taskId: string
  rollouts: string[]
  deliverables: string[]
  harnessFiles: number
  library: boolean
  pool: string[]
  failed: string[]
  sourceFiles: number
  decisions: number
}

/** The evidence-layout listing that goes in a mission; it mentions only what exists. */
export function layout(tree: EvidenceTree): string {
  const lines = ['context/task.md                  the task as the agent received it']
  if (tree.sourceFiles) lines.push('context/source/                 task source materials')
  if (tree.decisions) lines.push('context/decisions/              earlier edits and composition decisions')
  if (tree.rollouts.length) {
    const names = tree.rollouts.slice(0, 6).map((label) => `${label}.md`).join(', ')
    const more = tree.rollouts.length > 6 ? ` (+${tree.rollouts.length - 6} more)` : ''
    lines.push(`context/rollouts/               FULL trajectories: ${names}${more}`)
  }
  if (tree.deliverables.length) lines.push('context/deliverables/<label>/    the files each rollout produced, one per artifact (browse INDEX.md for the set)')
  if (tree.harnessFiles) lines.push(`context/harness/                the harness you are editing (${tree.harnessFiles} files)`)
  if (tree.pool.length) lines.push(`context/pool/                   ${tree.pool.length} candidates, each with its harness and its rollout`)
  if (tree.library) lines.push('context/library/                earlier tasks in this area -- browse INDEX.md first, then open what looks relevant')
  return lines.join('\n')
}

export interface BuildInput {
  task: RefineTask
  executor: Executor
  rollouts?: readonly Rollout[]
  harnessDir?: string | null
  libraryDir?: string | null
  pool?: readonly PoolEntry[]
  decisions?: Record<string, string>
  obsTrunc?: number
}

function writeRollout(dest: string, rollout: Rollout, executor: Executor, obsTrunc: number): string {
  let failure = ''
  mkdirSync(join(dest, 'rollouts'), { recursive: true })
  try {
    writeFileSync(join(dest, 'rollouts', `${rollout.label}.md`), executor.trajectory(rollout, { obsTrunc }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeFileSync(join(dest, 'rollouts', `${rollout.label}.md`), `(trajectory unavailable: ${message})`)
    failure = `${rollout.label}: ${message}`
  }
  const dir = join(dest, 'deliverables', rollout.label)
  mkdirSync(dir, { recursive: true })
  let produced: Record<string, string> = {}
  try {
    produced = executor.deliverableFiles(rollout)
  } catch (error) {
    produced = { 'unavailable.md': `(deliverable unavailable: ${error instanceof Error ? error.message : String(error)})` }
  }
  const names = Object.keys(produced).sort()
  for (const name of names) {
    const target = join(dir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, produced[name]!)
  }
  writeFileSync(join(dir, 'INDEX.md'), names.length ? `# ${rollout.label} produced ${names.length} file(s)\n\n${names.map((name) => `- \`${name}\``).join('\n')}\n` : `# ${rollout.label} produced nothing\n`)
  return failure
}

function renderDeliverable(executor: Executor, rollout: Rollout): string {
  const produced = executor.deliverableFiles(rollout)
  const names = Object.keys(produced).sort()
  if (!names.length) return ''
  if (names.length === 1) return produced[names[0]!]!
  return names.map((name) => `## ${name}\n\n${produced[name]}`).join('\n\n')
}

export { renderDeliverable }

/**
 * Writes the evidence folder and returns what landed, so a mission describes only that. A
 * trajectory is written in full; `obsTrunc` applies per observation.
 */
export function build(dest: string, input: BuildInput): EvidenceTree {
  const { task, executor } = input
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const obsTrunc = Math.max(input.obsTrunc ?? 50_000, MIN_OBS_TRUNC)

  writeFileSync(join(dest, 'task.md'), task.prompt)
  const sourceFiles = copySource(task, dest)
  for (const [label, notes] of Object.entries(input.decisions ?? {})) {
    mkdirSync(join(dest, 'decisions'), { recursive: true })
    writeFileSync(join(dest, 'decisions', `${label}.md`), notes || 'No decision notes returned.')
  }

  const rollouts: string[] = []
  const deliverables: string[] = []
  const failed: string[] = []
  for (const rollout of input.rollouts ?? []) {
    const failure = writeRollout(dest, rollout, executor, obsTrunc)
    if (failure) failed.push(failure)
    else rollouts.push(rollout.label)
    deliverables.push(rollout.label)
  }

  let harnessFiles = 0
  if (input.harnessDir && existsSync(input.harnessDir)) {
    assertNoLeakPaths(input.harnessDir, task.leakGlobs)
    harnessFiles = copyFolder(input.harnessDir, join(dest, 'harness'))
  }

  const pool: string[] = []
  for (const entry of input.pool ?? []) {
    const dir = join(dest, 'pool', entry.label)
    mkdirSync(dir, { recursive: true })
    if (entry.harnessDir && existsSync(entry.harnessDir)) {
      assertNoLeakPaths(entry.harnessDir, task.leakGlobs)
      copyFolder(entry.harnessDir, join(dir, 'harness'))
      const reference = readTree(PI_SURFACE, join(dest, 'harness'))
      const candidate = readTree(PI_SURFACE, entry.harnessDir)
      writeFileSync(join(dir, 'harness.diff'), unifiedDiff(reference, candidate, 'current', entry.label))
    }
    if (entry.rollout) {
      try {
        writeFileSync(join(dir, 'rollout.md'), executor.trajectory(entry.rollout, { obsTrunc }))
        writeFileSync(join(dir, 'produced.md'), renderDeliverable(executor, entry.rollout) || '(nothing produced)')
      } catch (error) {
        writeFileSync(join(dir, 'rollout.md'), `(unavailable: ${error instanceof Error ? error.message : String(error)})`)
      }
    }
    pool.push(entry.label)
  }

  let library = false
  if (input.libraryDir && existsSync(input.libraryDir) && readdirSync(input.libraryDir).length) {
    assertNoLeakPaths(input.libraryDir, task.leakGlobs)
    cpSync(input.libraryDir, join(dest, 'library'), { recursive: true })
    library = true
  }

  assertNoLeakPaths(dest, task.leakGlobs)
  assertNoGraderVerdicts(dest)
  if ((input.rollouts ?? []).length && !rollouts.length) {
    throw new Error(`no trajectory could be rendered for ANY rollout -- the improver would be adapting on nothing: ${failed.slice(0, 4).join('; ')}`)
  }
  return { root: dest, taskId: task.id, rollouts, deliverables, harnessFiles, library, pool, failed, sourceFiles, decisions: Object.keys(input.decisions ?? {}).length }
}

/** The short pointer to the evidence on disk: the job, where the evidence is, and the instruction to open it. */
export function mission(tree: EvidenceTree, job: string): string {
  return [
    job.trim(),
    '',
    '# YOUR EVIDENCE',
    '',
    'It is on disk, in `context/`. Read it -- do not answer from this message alone.',
    '',
    layout(tree),
    '',
    'Every trajectory EVENT is present: the trajectory was not clipped to fit this mission. An individual observation may contain an explicit renderer-truncation marker; that marker is ours, not behavior by the solver. Do not diagnose it as a solver failure.',
    '',
    'Read `task.md` and the current harness first. Inventory every available rollout or candidate and inspect each at least once before deciding. For a candidate, compare what changed from its editing baseline, what behavior changed in its rollout, what improved, and what regressed or remained unresolved. Then deep-read the evidence relevant to any edit. Cite the specific trajectory moment behind every change; one you cannot trace to a moment is speculation.'
  ].join('\n')
}
