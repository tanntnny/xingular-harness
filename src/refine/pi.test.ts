// Refinement through real Pi sessions with a scripted model: executions are probe runs in their
// own folders, improvers edit the harness with Pi's own file tools, and every session is recorded.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { fauxModel } from '../../tests/faux'
import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { listRuns } from '../sessions/runStore'
import * as store from '../variant/store'
import { DEFAULT_REFINE_HOST } from './host'
import { Library } from './library'
import { IMPROVER_TRIGGER, PiExecutor, PiImprover, PROBE_TRIGGER, RETAINED_WORKSPACE } from './pi'
import type { RefineHost } from './host'
import { refineDir, runRefinement } from './runner'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

type Message = { role: string; content: unknown }
const text = (message: Message | undefined): string => (!message ? '' : Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : String(message.content))

it('runs probes and improvers as Pi sessions, harvests the edited variant, and records a lesson', async () => {
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
  expect(runs.filter((run) => run.trigger === PROBE_TRIGGER).every((run) => run.variantScope === 'ledger' && run.status === 'completed')).toBe(true)
  expect(runs.filter((run) => run.trigger === IMPROVER_TRIGGER)).toHaveLength(4)

  // Adopting makes the chosen harness the head.
  const adopted = harness.refine.adopt(id)
  expect(adopted.fingerprint).toBe(summary.chosenFingerprint)
})

// PROP-0002: retained workspaces are kept whole for measurement and never reach the method.
const BLOB = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x00, 0x10])

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name)
    if (name.isDirectory()) walk(path, into)
    else into.push(path)
  }
  return into
}

async function refineWith(retainWorkspaces: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'refine-retain-'))
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'refine-retain-state-')), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const faux = await fauxModel(harness)
  store.seed(root, 'memo', { 'systemprompt.md': 'Write the memo.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' })
  faux.script(Array.from({ length: 30 }, () => (context: { messages: Message[] }) => {
    const first = context.messages.filter((message) => message.role === 'user').map(text).join('\n')
    if (context.messages.at(-1)?.role === 'toolResult') return faux.says('<notes>No change.</notes>')
    if (first.includes('YOUR DIMENSION') || first.includes('composing THE final harness')) return faux.calls(['write', { path: 'context/harness/memory.md', content: 'Keep memos short.\n' }])
    if (first.includes('complete record of one improvement round')) return faux.says('NO_ENTRY')
    return faux.says('Memo written.')
  }))
  // A host whose executions leave a binary file and a nested folder behind.
  const cleaned: string[] = []
  const host: RefineHost = {
    async prepareWorkspace() {
      const cwd = mkdtempSync(join(tmpdir(), 'refine-retain-ws-'))
      writeFileSync(join(cwd, 'memo.docx'), BLOB)
      mkdirSync(join(cwd, 'nested', 'deep'), { recursive: true })
      writeFileSync(join(cwd, 'nested', 'deep', 'note.txt'), 'kept')
      return { cwd, cleanup: async () => { cleaned.push(cwd); rmSync(cwd, { recursive: true, force: true }) } }
    },
    async session({ task }) {
      return { caller: { agentId: task.scope, actor: 'Code' }, tools: { allow: ['read', 'write'] } }
    }
  }
  const id = 'retain'
  const dir = refineDir(root, id)
  const runtime = { root: () => root, runs: harness.runs, run: (input: Parameters<Harness['sessions']['run']>[0]) => harness.sessions.run({ ...input, model: faux.model }) }
  const summary = await runRefinement({
    root,
    id,
    task: { id: 'memo-1', scope: 'memo', prompt: 'Write the memo.' },
    k: 1,
    mode: 'parallel',
    executor: new PiExecutor(runtime, host, id, dir, undefined, { retainWorkspaces }),
    improver: new PiImprover(runtime, dir, { model: faux.model }),
    proposeWidth: 1,
    rolloutWidth: 1
  })
  return { harness, dir, summary, cleaned, candidates: harness.refine.candidates(id) }
}

it('retains every execution\'s workspace whole when asked, outside the evidence', async () => {
  const { dir, summary, cleaned, candidates } = await refineWith(true)
  expect(summary.status).toBe('ok')
  const labels = readdirSync(join(dir, 'rollouts'))
  expect(labels).toHaveLength(4)
  for (const label of labels) {
    const kept = join(dir, 'rollouts', label, RETAINED_WORKSPACE)
    expect(readFileSync(join(kept, 'memo.docx')).equals(BLOB)).toBe(true)
    expect(readFileSync(join(kept, 'nested', 'deep', 'note.txt'), 'utf8')).toBe('kept')
  }
  // The host still cleans up its own folder after the copy.
  expect(cleaned).toHaveLength(4)
  expect(cleaned.every((cwd) => !existsSync(cwd))).toBe(true)
  // Candidate views point at the retained folders.
  expect(candidates.every((candidate) => candidate.workspace === join(dir, 'rollouts', candidate.label, RETAINED_WORKSPACE))).toBe(true)
  // The binary file exists only through retention: no evidence, selection or reflection folder carries it.
  const leaked = walk(dir).filter((path) => path.endsWith('memo.docx')).filter((path) => !path.includes(`/${RETAINED_WORKSPACE}/`))
  expect(leaked).toEqual([])
})

it('keeps no workspace by default', async () => {
  const { dir, candidates } = await refineWith(false)
  for (const label of readdirSync(join(dir, 'rollouts'))) expect(existsSync(join(dir, 'rollouts', label, RETAINED_WORKSPACE))).toBe(false)
  expect(candidates.every((candidate) => candidate.workspace === null)).toBe(true)
})

// PROP-0003: a caller names the executions' model and account; a host's own settings still win.
it('runs executions with the caller\'s executor settings unless the host names its own', async () => {
  const seen: { model: unknown; effort: unknown; accountId: unknown }[] = []
  const runtime = {
    root: () => mkdtempSync(join(tmpdir(), 'refine-exec-')),
    runs: {} as Harness['runs'],
    run: async (input: Parameters<Harness['sessions']['run']>[0]) => {
      seen.push({ model: input.model, effort: input.effort, accountId: input.accountId })
      throw new Error('stop after recording the settings')
    }
  }
  const task = { id: 't', scope: 's', prompt: 'p' }
  const settings = { model: 'openai-codex/gpt-6-luna', effort: 'high' as const, accountId: 'acct-1' }
  const dir = mkdtempSync(join(tmpdir(), 'refine-exec-dir-'))

  const plain = await new PiExecutor(runtime, DEFAULT_REFINE_HOST, 'r', dir, undefined, { settings }).execute(task, null, 'base1', 'r-base1')
  expect(plain.ok).toBe(false)
  const host: RefineHost = { ...DEFAULT_REFINE_HOST, session: async (input) => ({ ...(await DEFAULT_REFINE_HOST.session(input)), model: 'host/model' }) }
  await new PiExecutor(runtime, host, 'r', dir, undefined, { settings }).execute(task, null, 'base2', 'r-base2')
  await new PiExecutor(runtime, DEFAULT_REFINE_HOST, 'r', dir).execute(task, null, 'base3', 'r-base3')

  expect(seen).toEqual([
    { model: 'openai-codex/gpt-6-luna', effort: 'high', accountId: 'acct-1' },
    { model: 'host/model', effort: 'high', accountId: 'acct-1' },
    { model: null, effort: null, accountId: null }
  ])
})

it('records the settings a refinement was started with on its summary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'refine-settings-'))
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'refine-settings-state-')), secrets: memorySecretStore() })
  open.push(harness)
  store.seed(root, 'memo', { 'systemprompt.md': '', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' })
  const { id } = harness.refine.start({ task: { id: 'memo-1', scope: 'memo', prompt: 'Write the memo.' }, executor: { model: 'openai-codex/gpt-6-luna' }, improver: { model: 'openai-codex/gpt-6-luna', effort: 'low' } })
  const summary = await harness.refine.wait(id)
  expect(summary?.settings).toEqual({ executor: { model: 'openai-codex/gpt-6-luna' }, improver: { model: 'openai-codex/gpt-6-luna', effort: 'low' } })
})
