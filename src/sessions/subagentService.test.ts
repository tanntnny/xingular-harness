import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { SessionRunInput } from './sessions'
import { SUBAGENT_OWNER, SUBAGENT_RECEIPT, subagentHistory } from './subagents'
import { loadRun, recordSubagent } from './runStore'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

function setup() {
  const finish = new Map<string, (text: string) => void>()
  const root = mkdtempSync(join(tmpdir(), 'native-subagents-'))
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), sessionFactory: async ({ params }) => {
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
  return { harness, finish, start }
}
const empty = () => ({ owners: [], receipts: [] })

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
