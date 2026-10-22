import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as store from '../tree/store'
import type { Tree } from '../tree/surface'
import { DemoExecutor, demoBaseTree, demoTasks } from './demo'
import { runRefineCli } from './cli'
import { readMatrix, runMatrix, type MatrixSummary } from './suite'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'refine-suite-'))
  return { root, tasks: demoTasks(root), executor: new DemoExecutor(root) }
}

/** The demo's improved tree: the same script without the positive-only filter. */
function improvedTree(): Tree {
  const tree = demoBaseTree()
  return { ...tree, 'scripts/summarize.mjs': tree['scripts/summarize.mjs']!.replace('.filter((amount) => amount > 0)', '') }
}

/** A tree that stages cleanly but fails every execution. */
function failingTree(): Tree {
  const tree = demoBaseTree()
  return { ...tree, 'scripts/summarize.mjs': 'process.exit(1)\n' }
}

describe('the evaluation matrix', () => {
  it('runs every version × task and records deliverability with comparability keys', async () => {
    const { root, tasks, executor } = setup()
    const summary = await runMatrix({
      root,
      id: 'matrix-1',
      versions: [
        { label: 'base', tree: demoBaseTree() },
        { label: 'improved', tree: improvedTree() },
        { label: 'failing', tree: failingTree() }
      ],
      tasks,
      executor
    })

    expect(summary.status).toBe('ok')
    expect(summary.rows).toHaveLength(6)
    const delivered = (version: string) => summary.rows.filter((row) => row.version === version && row.delivered).length
    expect(delivered('base')).toBe(2)
    expect(delivered('improved')).toBe(2)
    expect(delivered('failing')).toBe(0)
    expect(summary.rows.filter((row) => row.version === 'failing').every((row) => !row.ok)).toBe(true)
    expect(summary.usd).toBe(0)

    // Fingerprints identify each tree, and a row matches the tree it ran.
    expect(summary.rows[0]!.fingerprint).toBe(store.fingerprint(demoBaseTree()))
    expect(new Set(summary.rows.map((row) => row.fingerprint)).size).toBe(3)
    expect(summary.rows.filter((row) => row.version === 'improved')[0]!.fingerprint).toBe(store.fingerprint(improvedTree()))

    // Comparability keys: identical task text hashes, the executor's name, this package's release.
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    for (const row of summary.rows) {
      expect(row.taskHash).toMatch(/^[0-9a-f]{16}$/)
      expect(row.executor).toBe('DemoExecutor')
      expect(row.packageVersion).toBe(version)
    }

    // The record round-trips; the input echo is beside it.
    const record = JSON.parse(readFileSync(join(root, 'refine', 'matrix-1', 'matrix.json'), 'utf8')) as MatrixSummary
    expect(record.status).toBe('ok')
    expect(record.rows).toHaveLength(6)
    expect(JSON.parse(readFileSync(join(root, 'refine', 'matrix-1', 'suite.json'), 'utf8'))).toMatchObject({ id: 'matrix-1' })
  })

  it('rejects a tree that carries grader output before any execution runs', async () => {
    const { root, tasks, executor } = setup()
    const poisoned: Tree = { ...demoBaseTree(), 'guardrails.md': 'Never write review_verdict into a note.\n' }
    const summary = await runMatrix({
      root,
      id: 'poisoned',
      versions: [
        { label: 'clean', tree: demoBaseTree() },
        { label: 'poisoned', tree: poisoned }
      ],
      tasks,
      executor
    })

    const poisonedRows = summary.rows.filter((row) => row.version === 'poisoned')
    expect(poisonedRows).toHaveLength(2)
    for (const row of poisonedRows) {
      expect(row.ok).toBe(false)
      expect(row.error).toContain('grader-verdict marker')
    }
    // The clean version still ran every task.
    expect(summary.rows.filter((row) => row.version === 'clean').every((row) => row.delivered)).toBe(true)
    expect(executor.executions).toBe(2)
  })

  it('runs the executor tree validation as a row failure, not an abort', async () => {
    const { root, tasks, executor } = setup()
    const { 'scripts/summarize.mjs': _omit, ...noScript } = demoBaseTree()
    const summary = await runMatrix({
      root,
      id: 'unvalidated',
      versions: [{ label: 'no-script', tree: noScript }],
      tasks,
      executor
    })
    expect(summary.rows.every((row) => row.error.includes('invalid tree for this task'))).toBe(true)
    expect(summary.status).toBe('partial')
    expect(executor.executions).toBe(0)
  })

  it('cancels cleanly and reports bad input', async () => {
    const { root, tasks, executor } = setup()
    const aborted = new AbortController()
    aborted.abort()
    const summary = await runMatrix({ root, id: 'aborted', versions: [{ label: 'base', tree: demoBaseTree() }], tasks, executor, signal: aborted.signal })
    expect(summary.status).toBe('cancelled')
    expect(summary.rows.every((row) => row.error === 'The matrix was cancelled.')).toBe(true)
    expect(executor.executions).toBe(0)

    await expect(runMatrix({ root, id: 'bad1', versions: [], tasks, executor })).rejects.toThrow()
    await expect(runMatrix({ root, id: 'bad2', versions: [{ label: 'base', tree: demoBaseTree() }], tasks: [], executor })).rejects.toThrow()
    await expect(runMatrix({ root, id: 'bad3', versions: [{ label: 'bad label', tree: demoBaseTree() }], tasks, executor })).rejects.toThrow()
  })
})

describe('the refine matrix command', () => {
  it('evaluates the demo suite with no model and writes the requested copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refine-matrix-'))
    const out = join(root, 'sweep-copy.json')
    const lines: string[] = []
    const code = await runRefineCli(['matrix', '--demo', '--data', root, '--out', out], { write: (text) => lines.push(text) })
    expect(code).toBe(0)
    expect(lines.join('')).toContain('base')
    expect(lines.join('')).toContain('2/2 delivered')

    const summary = JSON.parse(readFileSync(out, 'utf8')) as MatrixSummary
    expect(summary.status).toBe('ok')
    expect(readMatrix(root, 'matrix')?.rows).toHaveLength(2)
  })

  it('evaluates a committed scope version without touching its head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refine-matrix-'))
    store.seed(root, 'demo', demoBaseTree())
    const record = store.commit(root, 'demo', improvedTree(), { kind: 'edit', note: 'signed sums' }, { moveHead: false })
    const suite = {
      id: 'lineage',
      versions: [{ label: 'committed', scope: 'demo', version: record.fingerprint }],
      tasks: demoTasks(root)
    }
    const suiteFile = join(root, 'suite.json')
    writeFileSync(suiteFile, JSON.stringify(suite))
    const lines: string[] = []
    const code = await runRefineCli(['matrix', '--suite', suiteFile, '--data', root], { write: (text) => lines.push(text) })
    expect(code).toBe(0)
    expect(store.head(root, 'demo')?.fingerprint).toBe(store.fingerprint(demoBaseTree()))
    expect(lines.join('')).toContain('committed')
  })

  it('prints usage when given nothing to run', async () => {
    const lines: string[] = []
    const code = await runRefineCli(['matrix'], { write: (text) => lines.push(text) })
    expect(code).toBe(2)
    expect(lines.join('')).toContain('Usage:')
  })

  it('refuses an executor that needs a model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refine-matrix-'))
    const suiteFile = join(root, 'suite.json')
    writeFileSync(suiteFile, JSON.stringify({ id: 'x', versions: [{ label: 'base', scope: 'demo' }], tasks: demoTasks(root), executor: 'pi' }))
    store.seed(root, 'demo', demoBaseTree())
    const lines: string[] = []
    const code = await runRefineCli(['matrix', '--suite', suiteFile, '--data', root], { write: (text) => lines.push(text) })
    expect(code).toBe(1)
    expect(lines.join('')).toContain('needs a model')
  })
})
