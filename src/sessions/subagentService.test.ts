import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { SessionRunInput } from './sessions'
import { SUBAGENT_OWNER, SUBAGENT_RECEIPT, subagentHistory } from './subagents'
import { loadRun, recordSubagent, saveRun } from './runStore'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

function setup() {
  const finish = new Map<string, (text: string) => void>()
  const systems = new Map<string, string>()
  const root = mkdtempSync(join(tmpdir(), 'native-subagents-'))
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), sessionFactory: async ({ params }) => {
    systems.set(params.runId, params.system)
    let emit: (event: any) => void = () => {}
    let done: () => void = () => {}
    return { sessionId: 'native-history', subscribe: (listener) => { emit = listener; return () => {} }, sendCustomMessage: async () => {},
      prompt: () => new Promise<void>((resolve) => { done = resolve; finish.set(params.runId, (text) => {
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }); resolve()
      }) }), abort: async () => done(), dispose: () => {} }
  } })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const start = (id: string, extra: Partial<SessionRunInput> = {}) => harness.sessions.run({
    run: { id, sessionId: 'opaque-parent' }, caller: { agentId: 'caller', actor: 'Chat' }, cwd: root,
    sessionDir: join(root, 'history'), text: 'Parent', tools: { allow: ['read'] }, ...extra
  })
  return { harness, finish, start, systems }
}
const empty = () => ({ owners: [], receipts: [] })

describe('subagents a harness defines (c5)', () => {
  it('starts one by name with its own instructions instead of the parent\'s, and refuses a name the harness lacks', async () => {
    const { harness, start, systems } = setup()
    const { commit } = await import('../variant/store')
    commit(harness.env.root, 'caller', { 'systemprompt.md': 'You coordinate releases.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '', 'sub_agents/reader/AGENT.md': '---\ndescription: reads long logs and answers briefly\n---\nRead the log and answer in three lines.\n' }, { kind: 'seed' })
    await start('parent', { variant: { scope: 'caller' }, tools: { allow: ['read', 'spawn_subagent', 'wait_subagents'] } })
    expect(systems.get('parent')).toContain('You coordinate releases.')
    expect(systems.get('parent')).toContain('- reader — reads long logs and answers briefly')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Summarise build.log', agent: 'reader' })
    expect(systems.get(child.runId)).toContain('Read the log and answer in three lines.')
    expect(systems.get(child.runId)).not.toContain('You coordinate releases.')
    // A plain child keeps the parent's harness, pinned to the same version.
    const copy = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Check the tests' })
    expect(systems.get(copy.runId)).toContain('You coordinate releases.')
    expect(loadRun(harness.env.root, copy.runId).variantVersion).toBe(loadRun(harness.env.root, 'parent').variantVersion)
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'x', agent: 'writer' })).rejects.toThrow('There is no subagent named writer.')
  })
})

describe('native subagent ownership and delivery', () => {
  it('spawns asynchronously, joins selected children, and rejects foreign handles', async () => {
    const { harness, finish, start } = setup()
    await start('parent')
    const a = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'First', tools: ['read'] })
    const b = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Second', tools: [] })
    expect(harness.subagents.results({ parentRunId: 'parent' }).map(result => result.status)).toEqual(['running', 'running'])
    await expect(harness.subagents.wait({ parentRunId: 'parent', runIds: ['foreign'] })).rejects.toMatchObject({ code: 'invalid_request' })
    let joined = false
    const pending = harness.subagents.wait({ parentRunId: 'parent', runIds: [b.runId] }).then(results => { joined = true; return results })
    finish.get(a.runId)!('First result')
    await harness.runs.wait(a.runId)
    expect(joined).toBe(false)
    const canceled = new AbortController()
    canceled.abort()
    await expect(harness.subagents.wait({ parentRunId: 'parent', runIds: [b.runId] }, canceled.signal)).rejects.toMatchObject({ code: 'run_not_active' })
    finish.get(b.runId)!('Second result')
    expect(await pending).toMatchObject([{ runId: b.runId, status: 'completed', text: 'Second result' }])
    expect(loadRun(harness.env.root, a.runId).sessionId).not.toContain(':subagent:')
  })

  it('delivers already-settled results, retries uncommitted drafts, and trusts only typed receipts', async () => {
    const { harness, finish, start } = setup()
    await start('parent')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Find evidence' })
    finish.get(child.runId)!('Evidence')
    await harness.runs.wait(child.runId)
    const mentioned = subagentHistory([{ content: `I mentioned ${child.runId}` }])
    const first = await harness.subagents.delivery('parent', mentioned, true)
    expect(first?.text).toContain('Evidence')
    expect(await harness.subagents.delivery('parent', empty(), true)).toEqual(first)
    const committed = subagentHistory([{ type: 'custom_message', details: { [SUBAGENT_RECEIPT]: first!.receipt } }])
    expect(await harness.subagents.delivery('parent', committed, true)).toBeNull()
  })

  it('waits before final delivery and releases pending joins when the parent stops', async () => {
    const { harness, start } = setup()
    await start('parent')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Wait' })
    const pending = harness.subagents.delivery('parent', empty(), true)
    const interrupted = expect(pending).rejects.toMatchObject({ code: 'run_not_active' })
    await harness.runs.interrupt('parent')
    await interrupted
    expect(loadRun(harness.env.root, child.runId).status).toBe('interrupted')
    expect(harness.subagents.results({ parentRunId: 'parent' })).toMatchObject([{ runId: child.runId, status: 'interrupted' }])
  })

  it('recovers a child whose spawn return was lost, only from its owning history and account', async () => {
    const { harness, finish, start } = setup()
    await start('original')
    const child = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Recover' })
    finish.get(child.runId)!('Retained result')
    await harness.runs.wait(child.runId)
    recordSubagent(harness.env.root, 'original', 'reserved-before-crash')
    await harness.runs.interrupt('original')
    await start('resumed')
    expect(await harness.subagents.delivery('resumed', empty(), true)).toBeNull()
    const branch = subagentHistory([{ type: 'custom', customType: SUBAGENT_OWNER, data: { runId: 'original' } }])
    const recovered = await harness.subagents.delivery('resumed', branch, true)
    expect(recovered?.text).toContain('Retained result')
    expect(recovered?.receipt.delivered).toEqual([child.runId, 'reserved-before-crash'])
    expect(loadRun(harness.env.root, 'reserved-before-crash')).toMatchObject({ status: 'interrupted', relation: 'subagent', parentRunId: 'original' })
    await harness.runs.interrupt('resumed')
    const other = harness.accounts.create('Other', 'apiKey').accounts.find(account => account.label === 'Other')!
    await start('wrong-account', { accountId: other.id })
    expect(await harness.subagents.delivery('wrong-account', branch, true)).toBeNull()
  })

  it('reconstructs disk ownership after reopening without automatically restarting model work', async () => {
    const { harness, finish, start } = setup()
    await start('original')
    const child = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Persisted work' })
    finish.get(child.runId)!('On-disk result')
    await harness.runs.wait(child.runId)
    recordSubagent(harness.env.root, 'original', 'orphan-after-crash')
    const original = loadRun(harness.env.root, 'original')
    saveRun(harness.env.root, { ...original, id: 'orphan-after-crash', sessionId: 'orphan-session', parentRunId: 'original', relation: 'subagent', status: 'running' })
    const dataRoot = harness.env.root
    const stateDir = harness.stateDir
    await harness.close()
    open.splice(open.indexOf(harness), 1)
    let opened = 0
    const restarted = createHarness({ dataRoot, stateDir, secrets: memorySecretStore(), sessionFactory: async () => {
      opened++
      return { sessionId: 'native-history', subscribe: () => () => {}, prompt: async () => new Promise<void>(() => {}), sendCustomMessage: async () => {}, abort: async () => {}, dispose: () => {} }
    } })
    open.push(restarted)
    expect(opened).toBe(0)
    expect(loadRun(dataRoot, 'orphan-after-crash').status).toBe('interrupted')
    await restarted.sessions.run({ run: { id: 'explicit-resume', sessionId: original.sessionId, resumedFromRunId: original.id }, caller: { agentId: 'caller', actor: 'Chat' }, cwd: original.workingDirectory!, sessionDir: join(original.workingDirectory!, 'history'), text: 'Resume', tools: { allow: ['read'] } })
    const delivery = await restarted.subagents.delivery('explicit-resume', { owners: ['original'], receipts: [] }, true)
    expect(delivery?.text).toContain('On-disk result')
    expect(delivery?.receipt.delivered).toEqual([child.runId, 'orphan-after-crash'])
    expect(opened).toBe(1)
  })

  it('enables interactive callers at a host depth without extending native nesting or unattended access', async () => {
    const { harness, start } = setup()
    await start('host-depth', { depth: 3 })
    const child = await harness.subagents.spawn({ parentRunId: 'host-depth', brief: 'One native level' })
    await expect(harness.subagents.spawn({ parentRunId: child.runId, brief: 'Too deep' })).rejects.toMatchObject({ code: 'invalid_request' })
    await harness.runs.interrupt('host-depth')
    await start('unattended', { automatic: true })
    await expect(harness.subagents.spawn({ parentRunId: 'unattended', brief: 'Not enabled' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('does not acknowledge results omitted from a bounded delivery batch', async () => {
    const { harness, finish, start } = setup()
    await start('parent')
    const children = await Promise.all([1, 2, 3].map(n => harness.subagents.spawn({ parentRunId: 'parent', brief: String(n) })))
    for (const child of children) finish.get(child.runId)!('x'.repeat(16_000))
    await harness.subagents.wait({ parentRunId: 'parent' })
    const receipts: any[] = []
    const delivered: string[] = []
    for (let i = 0; i < 3; i++) {
      const batch = await harness.subagents.delivery('parent', { owners: [], receipts }, true)
      expect(batch).not.toBeNull()
      delivered.push(...batch!.receipt.delivered!)
      receipts.push(batch!.receipt)
    }
    expect(delivered).toEqual(children.map(child => child.runId))
    expect(await harness.subagents.delivery('parent', { owners: [], receipts }, true)).toBeNull()
  })
})
