// `xingular-harness refine`: refinement from a terminal.
//
//   refine demo [--k N] [--mode parallel|sequential] [--out <dir>]
//       Runs the deterministic ledger demo end to end with no model and no credentials.
//   refine run --tree <dir> --task <file.md> [--source <dir>] [--scope <id>] [--k N]
//              [--mode parallel|sequential] [--data <dir>] [--state <dir>] [--model <id>]
//       Refines a harness tree on one task with the default Pi account.
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { createHarness } from '../harness'
import * as store from '../tree/store'
import { PI_SURFACE } from '../tree/surface'
import { readTree } from '../tree/tree'
import { DemoExecutor, DemoImprover, demoBaseTree, demoTasks } from './demo'
import { Library } from './library'
import { runRefinement, type RefineSummary } from './runner'
import type { RecursionMode } from './types'

export const REFINE_USAGE = `Usage: xingular-harness refine <demo | run> [options]

  demo [--k N] [--mode parallel|sequential] [--out <dir>]
        Run the deterministic demo: no model, no credentials.
  run --tree <dir> --task <file.md> [--source <dir>] [--scope <id>] [--k N]
      [--mode parallel|sequential] [--data <dir>] [--state <dir>] [--model <id>]
        Refine a harness on one task with the default account. Costs about
        4k executions and 3k improver sessions.
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
    if (arg.startsWith('--') && i + 1 < rest.length) values[arg.slice(2)] = rest[++i]!
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

export async function runRefineCli(argv: string[], io: { write: (text: string) => void } = { write: (text) => void process.stdout.write(text) }): Promise<number> {
  const { command, values } = parse(argv)
  try {
    if (command === 'demo') {
      const root = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), 'harness-refine-demo-'))
      const k = Number(values.k ?? 1)
      store.seed(root, 'demo', demoBaseTree(), 'demo base harness')
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
      if (!values.tree || !values.task) {
        io.write(REFINE_USAGE)
        return 2
      }
      const base = join(homedir(), '.xingular-harness')
      const harness = createHarness({ dataRoot: resolve(values.data ?? join(base, 'data')), stateDir: resolve(values.state ?? join(base, 'state')) })
      try {
        const scope = values.scope ?? basename(resolve(values.tree)).replace(/[^A-Za-z0-9_-]/g, '-')
        const tree = readTree(PI_SURFACE, resolve(values.tree))
        store.commit(harness.env.root, scope, tree, { kind: 'import', note: `from ${values.tree}` })
        const prompt = readFileSync(resolve(values.task), 'utf8')
        const { id } = harness.refine.start({
          task: { id: basename(values.task).replace(/\.md$/, '').replace(/[^A-Za-z0-9_-]/g, '-'), prompt, scope, sourceDir: values.source ? resolve(values.source) : null },
          k: Number(values.k ?? 1),
          mode: mode(values.mode),
          improver: values.model ? { model: values.model } : {}
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
    io.write(REFINE_USAGE)
    return command ? 2 : 0
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
