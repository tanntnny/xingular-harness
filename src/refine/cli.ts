// `xharness refine`: refinement from a terminal.
//
//   refine demo [--k N] [--mode parallel|sequential] [--out <dir>]
//       Runs the deterministic ledger demo end to end with no model and no credentials.
//   refine run --variant <dir> --task <file.md> [--source <dir>] [--scope <id>] [--k N]
//              [--mode parallel|sequential] [--data <dir>] [--state <dir>] [--model <id>]
//              [--executor-model <id>] [--retain-workspaces]
//       Refines a variant on one task with the default Pi account. --model is the improver's
//       model; --executor-model is the executions' model (default: the account's default). With --retain-workspaces
//       each execution's workspace is kept under the refinement's rollouts/<label>/workspace/.
//   refine matrix --suite <file.json> [--data <dir>] [--out <file.json>]
//       Evaluates variants on a task set with no model (demo executor): one probe
//       execution per version × task, recorded as <data>/refine/<id>/matrix.json.
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { writeJson } from '../core/fs'
import { createHarness } from '../harness'
import * as store from '../variant/store'
import { PI_SURFACE } from '../variant/surface'
import { readVariant } from '../variant/variant'
import { DemoExecutor, DemoImprover, demoBaseVariant, demoTasks } from './demo'
import { Library } from './library'
import { runRefinement, type RefineSummary } from './runner'
import { runMatrix, type MatrixSummary } from './suite'
import type { RecursionMode, RefineTask } from './types'

export const REFINE_USAGE = `Usage: xharness refine <demo | run | matrix> [options]

  demo [--k N] [--mode parallel|sequential] [--out <dir>]
        Run the deterministic demo: no model, no credentials.
  run --variant <dir> --task <file.md> [--source <dir>] [--scope <id>] [--k N]
      [--mode parallel|sequential] [--data <dir>] [--state <dir>] [--model <id>]
      [--executor-model <id>] [--retain-workspaces]
        Refine a harness on one task with the default account. Costs about
        4k executions and 3k improver sessions. --model sets the improver's
        model, --executor-model the executions' model. --retain-workspaces
        keeps each execution's files for grading afterwards.
  matrix --suite <file.json> [--data <dir>] [--out <file.json>]
        Evaluate variants on a task set with the demo executor: no model.
        Versions come from a variant directory ({ label, dir }) or a committed
        scope ({ label, scope, version? }); tasks are RefineTask records.
        Writes <data>/refine/<id>/matrix.json and --out's copy when given.
`

interface Parsed {
  command: string | undefined
  values: Record<string, string>
}

function parse(argv: string[]): Parsed {
  const [command, ...rest] = argv
  const values: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--')) continue
    const next = rest[i + 1]
    values[arg.slice(2)] = next === undefined || next.startsWith('--') ? 'true' : rest[++i]!
  }
  return { command, values }
}

function mode(value: string | undefined): RecursionMode {
  if (!value || value === 'parallel') return 'parallel'
  if (value === 'sequential') return 'sequential'
  throw new Error('--mode is parallel or sequential.')
}

function describe(summary: RefineSummary, write: (text: string) => void): void {
  const ledger = summary.recursion?.ledger
  write(`${summary.taskId}: ${summary.status}${ledger ? ` · R=${ledger.R}/${ledger.expectedR} executions, P=${ledger.P}/${ledger.expectedP} improver sessions` : ''} · $${summary.usd.toFixed(4)}\n`)
  if (summary.selection?.chosenLabel) write(`  chose ${summary.selection.chosenLabel}${summary.chosenIsBase ? ' (unchanged harness)' : ''}: ${summary.selection.why.split('\n')[0]}\n`)
  if (summary.experience?.lesson) write(`  lesson: ${summary.experience.lesson}\n`)
  for (const error of summary.errors) write(`  ! ${error}\n`)
}

function describeMatrix(summary: MatrixSummary, write: (text: string) => void): void {
  write(`${summary.id}: ${summary.status} · ${summary.versions.length} versions × ${summary.tasks.length} tasks · $${summary.usd.toFixed(4)}\n`)
  for (const version of summary.versions) {
    const rows = summary.rows.filter((row) => row.version === version)
    const delivered = rows.filter((row) => row.delivered).length
    const fingerprint = summary.rows.find((row) => row.version === version)?.fingerprint
    write(`  ${version}${fingerprint ? ` (${fingerprint})` : ''}: ${delivered}/${rows.length} delivered\n`)
    for (const row of rows) {
      if (!row.ok || !row.delivered) write(`    ${row.task}: ${row.ok ? 'no deliverable' : 'failed'}${row.error ? ` — ${row.error}` : ''}\n`)
    }
  }
  for (const error of summary.errors) write(`  ! ${error}\n`)
}

interface SuiteFile {
  id: string
  versions: { label: string; dir?: string; scope?: string; version?: string | null }[]
  tasks: RefineTask[]
  executor?: string
  rolloutWidth?: number
}

export async function runRefineCli(argv: string[], io: { write: (text: string) => void } = { write: (text) => void process.stdout.write(text) }): Promise<number> {
  const { command, values } = parse(argv)
  try {
    if (command === 'demo') {
      const root = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), 'harness-refine-demo-'))
      const k = Number(values.k ?? 1)
      store.seed(root, 'demo', demoBaseVariant(), 'demo base harness')
      const executor = new DemoExecutor(root)
      const improver = new DemoImprover()
      for (const task of demoTasks(root)) {
        const summary = await runRefinement({ root, id: `${task.id}-${mode(values.mode)}-${k}`, task, k, mode: mode(values.mode), executor, improver })
        describe(summary, io.write)
      }
      io.write(`library: ${new Library(root, 'demo', 'accounting').entries().join(', ') || '(empty)'}\nrecords: ${join(root, 'refine')}\n`)
      return 0
    }
    if (command === 'run') {
      if (!values.variant || !values.task) {
        io.write(REFINE_USAGE)
        return 2
      }
      const base = join(homedir(), '.xingular-harness')
      const harness = createHarness({ dataRoot: resolve(values.data ?? join(base, 'data')), stateDir: resolve(values.state ?? join(base, 'state')) })
      try {
        const scope = values.scope ?? basename(resolve(values.variant)).replace(/[^A-Za-z0-9_-]/g, '-')
        const variant = readVariant(PI_SURFACE, resolve(values.variant))
        store.commit(harness.env.root, scope, variant, { kind: 'import', note: `from ${values.variant}` })
        const prompt = readFileSync(resolve(values.task), 'utf8')
        const { id } = harness.refine.start({
          task: { id: basename(values.task).replace(/\.md$/, '').replace(/[^A-Za-z0-9_-]/g, '-'), prompt, scope, sourceDir: values.source ? resolve(values.source) : null },
          k: Number(values.k ?? 1),
          mode: mode(values.mode),
          improver: values.model ? { model: values.model } : {},
          executor: values['executor-model'] ? { model: values['executor-model'] } : undefined,
          retainWorkspaces: values['retain-workspaces'] === 'true'
        })
        harness.bus.on((notice) => {
          if (notice.type === 'refine.event' && notice.id === id) {
            const event = notice.event as { type: string; label?: string; phase?: string }
            if (event.type === 'phase') io.write(`· ${event.phase}\n`)
            else if (event.type === 'stage.finished' || event.type === 'rollout.finished') io.write(`  ${event.type === 'stage.finished' ? 'proposed' : 'ran'} ${event.label}\n`)
          }
        })
        const summary = await harness.refine.wait(id)
        if (summary) describe(summary, io.write)
        return summary?.status === 'ok' ? 0 : 1
      } finally {
        await harness.close()
      }
    }
    if (command === 'matrix') {
      const root = resolve(values.data ?? join(homedir(), '.xingular-harness', 'data'))
      let versions: { label: string; variant: Record<string, string> }[] = []
      let tasks: RefineTask[]
      if (values.demo) {
        store.seed(root, 'demo', demoBaseVariant(), 'demo base harness')
        versions = [{ label: 'base', variant: demoBaseVariant() }]
        tasks = demoTasks(root)
      } else {
        if (!values.suite) {
          io.write(REFINE_USAGE)
          return 2
        }
        const suite = JSON.parse(readFileSync(resolve(values.suite), 'utf8')) as SuiteFile
        if (suite.executor && suite.executor !== 'demo') throw new Error(`Executor '${suite.executor}' needs a model; this command runs without one. Use 'demo'.`)
        for (const entry of suite.versions) {
          if (entry.dir) versions.push({ label: entry.label, variant: readVariant(PI_SURFACE, resolve(entry.dir)) })
          else if (entry.scope) {
            const fingerprint = entry.version ?? store.head(root, entry.scope)?.fingerprint
            if (!fingerprint) throw new Error(`The harness '${entry.scope}' has no head version to evaluate.`)
            versions.push({ label: entry.label, variant: store.readVersion(root, entry.scope, fingerprint) })
          } else throw new Error(`Version '${entry.label}' needs a dir or a scope.`)
        }
        tasks = suite.tasks
      }
      const executor = new DemoExecutor(root)
      const summary = await runMatrix({ root, id: values.id ?? 'matrix', versions, tasks, executor, rolloutWidth: values.width ? Number(values.width) : undefined })
      if (values.out) writeJson(resolve(values.out), summary)
      describeMatrix(summary, io.write)
      return summary.status === 'ok' || summary.status === 'partial' ? 0 : 1
    }
    io.write(REFINE_USAGE)
    return command ? 2 : 0
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
