// Refinement through real Pi sessions with a scripted model: executions are probe runs in their
// own folders, improvers edit the harness with Pi's own file tools, and every session is recorded.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { fauxModel } from '../../tests/faux'
import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { listRuns } from '../sessions/runStore'
import * as store from '../tree/store'
import { DEFAULT_REFINE_HOST } from './host'
import { Library } from './library'
import { IMPROVER_TRIGGER, PiExecutor, PiImprover, PROBE_TRIGGER } from './pi'
import { refineDir, runRefinement } from './runner'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

type Message = { role: string; content: unknown }
const text = (message: Message | undefined): string => (!message ? '' : Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : String(message.content))

it('runs probes and improvers as Pi sessions, harvests the edited tree, and records a lesson', async () => {
  const root = mkdtempSync(join(tmpdir(), 'refine-pi-'))
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'refine-pi-state-')), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const faux = await fauxModel(harness)
  const base = { 'systemprompt.md': 'Answer with the total.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' }
  store.seed(root, 'ledger', base)

  const seen: string[] = []
  // One responder for every request: what it answers depends on what it is asked.
  const respond = (context: { messages: Message[] }) => {
    const last = context.messages.at(-1)
    const first = context.messages.filter((message) => message.role === 'user').map(text).join('\n')
    if (last?.role === 'toolResult') return faux.says('<notes>Recorded that credits count: the base total dropped them.</notes>')
    if (first.includes('YOUR DIMENSION') || first.includes('composing THE final harness')) {
      seen.push('improver')
      return faux.calls(['write', { path: 'context/harness/memory.md', content: 'Credits are negative amounts and count toward the total.\n' }])
    }
    if (first.includes('complete record of one improvement round')) {
      seen.push('reflector')
      return faux.says('<edits>\ncomponent: memory.md\ncandidates: inv1, dom1, agg1\nchange: noted that credits count\nobserved: the probe total matched the signed sum\nverdict: helped\n</edits>\n<experience>\ncue: When a ledger mixes credits and debits\nlesson: Record in memory.md that credits are negative amounts that count.\nevidence: the memory.md row; the probe total included credits\nconfidence: medium, one probe\n</experience>')
    }
    seen.push('probe')
    return faux.says('Total: 85.15')
  }
  faux.script(Array.from({ length: 30 }, () => respond))

  const id = 'pi-refine'
  const dir = refineDir(root, id)
  const runtime = { root: () => root, runs: harness.runs, run: (input: Parameters<Harness['sessions']['run']>[0]) => harness.sessions.run({ ...input, model: faux.model }) }
  const summary = await runRefinement({
    root,
    id,
    task: { id: 'ledger-1', scope: 'ledger', prompt: 'Sum every signed amount: 100.25, -20.10, 5.00.' },
    k: 1,
    mode: 'parallel',
    executor: new PiExecutor(runtime, DEFAULT_REFINE_HOST, id, dir),
    improver: new PiImprover(runtime, dir, { model: faux.model }),
    proposeWidth: 1,
    rolloutWidth: 1
  })

  expect(summary.status).toBe('ok')
  expect(summary.recursion?.ledger).toMatchObject({ R: 4, P: 3 })
  expect(summary.recursion?.fellBack).toEqual([])
  expect(seen.filter((kind) => kind === 'improver')).toHaveLength(3)
  expect(seen.filter((kind) => kind === 'probe')).toHaveLength(4)
  // The chosen harness carries the improver's edit, saved as a version without moving the head.
  const chosen = store.readVersion(root, 'ledger', summary.chosenFingerprint!)
  expect(chosen['memory.md']).toBe('Credits are negative amounts and count toward the total.\n')
  expect(store.head(root, 'ledger')!.fingerprint).toBe(summary.baseFingerprint)
  expect(readFileSync(join(dir, 'rollouts', 'agg1', 'deliverables', 'reply.md'), 'utf8')).toBe('Total: 85.15')
  expect(new Library(root, 'ledger').list().map((entry) => entry.cue)).toEqual(['When a ledger mixes credits and debits'])

  // Every execution and improver session is an ordinary recorded run, marked by its trigger.
  const runs = listRuns(root, {})
  expect(runs.filter((run) => run.trigger === PROBE_TRIGGER)).toHaveLength(4)
  expect(runs.filter((run) => run.trigger === PROBE_TRIGGER).every((run) => run.harnessScope === 'ledger' && run.status === 'completed')).toBe(true)
  expect(runs.filter((run) => run.trigger === IMPROVER_TRIGGER)).toHaveLength(4)

  // Adopting makes the chosen harness the head.
  const adopted = harness.refine.adopt(id)
  expect(adopted.fingerprint).toBe(summary.chosenFingerprint)
})
