// A deterministic local executor and improver that exercise the real refinement workflow with
// no model and no credentials: the base harness sums only positive ledger amounts, and the
// scripted improver removes that filter.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/demo.py`).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Tree } from '../tree/surface'
import type { Executor, Improver, ImproverCall, ImproverReply, RefineTask, Rollout } from './types'

export const DEMO_SCRIPT = `import { readFileSync } from 'node:fs'

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\\n').slice(1)
const cents = rows.map((row) => Math.round(Number(row) * 100))
const total = cents.filter((amount) => amount > 0).reduce((sum, amount) => sum + amount, 0)
console.log(\`Total: \${(total / 100).toFixed(2)}\`)
`

export function demoBaseTree(): Tree {
  return {
    'systemprompt.md': 'Reconcile the ledger using node scripts/summarize.mjs.\n',
    'guardrails.md': '',
    'memory.md': '',
    'tool_guidance.md': '',
    'scripts/summarize.mjs': DEMO_SCRIPT
  }
}

export const DEMO_LEDGERS: Record<string, string> = {
  'ledger-1': '100.25\n-20.10\n5.00\n',
  'ledger-2': '35.50\n-10.25\n-5.00\n'
}

/** Writes the demo's source ledgers under `root` and returns the tasks. */
export function demoTasks(root: string, scope = 'demo'): RefineTask[] {
  return Object.entries(DEMO_LEDGERS).map(([id, amounts]) => {
    const sourceDir = join(root, 'sources', id)
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'ledger.csv'), `amount\n${amounts}`)
    writeFileSync(join(sourceDir, 'reference_answer.txt'), 'never shown to a model')
    return {
      id,
      scope,
      domain: 'accounting',
      prompt: 'Sum every signed amount in ledger.csv. Return Total: with two decimal places.',
      sourceDir,
      leakGlobs: ['reference_answer.txt'],
      prompts: { work: 'reconcile signed amounts in a transaction ledger' }
    }
  })
}

export class DemoExecutor implements Executor {
  executions = 0

  constructor(private readonly root: string) {}

  async execute(task: RefineTask, harnessDir: string | null, label: string, runId: string): Promise<Rollout> {
    this.executions++
    const dir = join(this.root, 'executions', runId)
    mkdirSync(dir, { recursive: true })
    const script = join(harnessDir ?? '', 'scripts', 'summarize.mjs')
    const result = spawnSync(process.execPath, [script, join(task.sourceDir ?? '', 'ledger.csv')], { encoding: 'utf8', timeout: 10_000 })
    if (result.status !== 0) {
      return { label, runId, dir, ok: false, delivered: false, costUsd: 0, wallMs: 0, error: result.stderr || 'script failed' }
    }
    writeFileSync(join(dir, 'answer.txt'), result.stdout)
    writeFileSync(join(dir, 'trajectory.md'), `[ACTION] Run scripts/summarize.mjs on ledger.csv\n[OBSERVATION]\n${result.stdout}`)
    return { label, runId, dir, ok: true, delivered: true, costUsd: 0, wallMs: 0, error: '' }
  }

  trajectory(rollout: Rollout): string {
    return readFileSync(join(rollout.dir, 'trajectory.md'), 'utf8')
  }

  deliverableFiles(rollout: Rollout): Record<string, string> {
    const path = join(rollout.dir, 'answer.txt')
    return existsSync(path) ? { 'answer.txt': readFileSync(path, 'utf8') } : {}
  }

  validateTree(_task: RefineTask, tree: Tree): void {
    if (!tree['scripts/summarize.mjs']) throw new Error('The local executor requires scripts/summarize.mjs')
  }
}

function signedTotal(ledger: string): string {
  const cents = ledger.trim().split('\n').slice(1).map((row) => Math.round(Number(row) * 100))
  return (cents.reduce((sum, amount) => sum + amount, 0) / 100).toFixed(2)
}

/** Scripted edits, selection and reflection. */
export class DemoImprover implements Improver {
  readonly calls: string[] = []

  async call(input: ImproverCall): Promise<ImproverReply> {
    this.calls.push(input.label)
    const context = input.contextDir
    let workspace: string | null = null
    let text: string
    if (input.label.startsWith('select.')) {
      const expected = `Total: ${signedTotal(readFileSync(join(context, 'source', 'ledger.csv'), 'utf8'))}`
      const ids = readdirSync(join(context, 'candidates')).filter((name) => name.endsWith('.md')).sort()
      const chosen = ids.find((name) => readFileSync(join(context, 'candidates', name), 'utf8').includes(expected))?.replace(/\.md$/, '') ?? ids[0]!.replace(/\.md$/, '')
      text = `<why>The signed total matches the source ledger.</why>\n\`\`\`choice\n${chosen}\n\`\`\``
    } else if (input.label.startsWith('experience.')) {
      const changed = readFileSync(join(context, 'harness', 'scripts', 'summarize.mjs'), 'utf8') !== readFileSync(join(context, 'base_harness', 'scripts', 'summarize.mjs'), 'utf8')
      text =
        `<edits>\ncomponent: scripts/summarize.mjs\ncandidates: inv1\nchange: dropped the positive-only filter from the amount sum\nobserved: the probe total included the credits the base run omitted\nverdict: ${changed ? 'helped' : 'no observed effect'}\n</edits>\n\n` +
        (changed
          ? '<experience>\ncue: When a ledger includes credits and debits\nlesson: Include both signs when summing in scripts/summarize.mjs.\nevidence: The scripts/summarize.mjs row -- removing the positive-only filter changed the probe total to include the credits omitted by the base trajectory.\nconfidence: high for this observed arithmetic contrast\n</experience>'
          : 'NO_ENTRY')
    } else {
      workspace = mkdtempSync(join(tmpdir(), 'harness-demo-'))
      cpSync(join(context, 'harness'), workspace, { recursive: true })
      const script = join(workspace, 'scripts', 'summarize.mjs')
      writeFileSync(script, readFileSync(script, 'utf8').replace('.filter((amount) => amount > 0)', ''))
      text = '<notes>Keep signed amounts: the base total omitted credits in the source ledger.</notes>'
    }
    return { label: input.label, text, costUsd: 0, attempts: 1, cached: false, workspace }
  }
}
