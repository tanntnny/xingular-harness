import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  const updates = new Map<string, string | null>()
  const gates = new Map<string, { check: (name: string, args: unknown) => Promise<string | null> }>()
  const root = mkdtempSync(join(tmpdir(), 'native-subagents-'))
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), sessionFactory: async ({ params }) => {
    systems.set(params.runId, params.system)
    updates.set(params.runId, params.update?.content ?? null)
    if (params.gate) gates.set(params.runId, params.gate)
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
  return { harness, finish, start, systems, updates, gates, root }
}
const empty = () => ({ owners: [], receipts: [] })

describe('subagents a harness defines (c5)', () => {
  it('starts one by name with its own instructions instead of the parent\'s, and refuses a name the harness lacks', async () => {
    const { harness, start, systems, updates } = setup()
    const { commit } = await import('../variant/store')
    commit(harness.env.root, 'caller', { 'systemprompt.md': 'You coordinate releases.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '', 'sub_agents/reader/AGENT.md': '---\ndescription: reads long logs and answers briefly\n---\nRead the log and answer in three lines.\n' }, { kind: 'seed' })
    await start('parent', { variant: { scope: 'caller' }, tools: { allow: ['read', 'spawn_subagent', 'wait_subagents'] } })
    expect(systems.get('parent')).toContain('You coordinate releases.')
    expect(updates.get('parent')).toContain('- reader — reads long logs and answers briefly')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Summarise build.log', agent: 'reader' })
    expect(systems.get(child.runId)).toContain('Read the log and answer in three lines.')
    expect(systems.get(child.runId)).not.toContain('You coordinate releases.')
    // A plain child keeps the parent's harness, pinned to the same version.
    const copy = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Check the tests' })
    expect(systems.get(copy.runId)).toContain('You coordinate releases.')
    expect(loadRun(harness.env.root, copy.runId).variantVersion).toBe(loadRun(harness.env.root, 'parent').variantVersion)
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'x', agent: 'writer' })).rejects.toThrow('There is no agent profile named writer.')
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

describe('plan-mode research subagents', () => {
  it('allows only a named eligible profile and keeps its child read-only, non-nested and plan-gated', async () => {
    const { harness, start, gates, updates } = setup()
    await start('planned', {
      run: { id: 'planned', sessionId: 'opaque-parent', worktreeId: 'managed' },
      plan: true, subagents: { maxDepth: 3 }, connections: true,
      tools: { allow: ['read', 'grep', 'edit', 'bash', 'ask_user', 'web_search', 'web_fetch', 'spawn_subagent', 'wait_subagents'] }
    })
    expect(updates.get('planned')).toContain('Plan mode may start only a named profile')
    expect(updates.get('planned')).toContain('- explorer — Finds and explains code')
    expect(updates.get('planned')).toContain('- researcher — Researches code, history and public sources')
    expect(updates.get('planned')).not.toContain('- worker —')
    expect(harness.subagents.planSpawnRefusal('planned', { brief: 'Explore' })).toContain('named')
    expect(harness.subagents.planSpawnRefusal('planned', { agent: 'worker' })).toContain('not eligible')
    expect(harness.subagents.planSpawnRefusal('planned', { agent: 'explorer', tools: ['edit'] })).toContain('plan-safe')
    expect(harness.subagents.planSpawnRefusal('planned', { agent: 'explorer' })).toBeNull()
    expect(await gates.get('planned')!.check('spawn_subagent', { agent: 'explorer' })).toBeNull()
    expect(await gates.get('planned')!.check('spawn_subagent', { agent: 'worker' })).toContain('Plan mode is research-only')
    expect(await gates.get('planned')!.check('spawn_subagent', {})).toContain('Plan mode is research-only')
    expect(await gates.get('planned')!.check('edit', {})).toContain('Plan mode is research-only')

    const child = await harness.subagents.spawn({ parentRunId: 'planned', brief: 'Trace the login route', agent: 'explorer' })
    const { loadRun: loadCapabilities } = await import('../capabilities/runSnapshot')
    const capabilities = loadCapabilities(harness.env.root, child.runId)!
    expect(capabilities.tools).toContain('read')
    for (const name of ['edit', 'write', 'bash', 'ask_user', 'mcp_call_tool', 'spawn_subagent']) expect(capabilities.tools).not.toContain(name)
    expect(capabilities.connectors).toEqual([])
    expect(loadRun(harness.env.root, child.runId)).toMatchObject({ relation: 'subagent', profile: 'explorer', worktreeId: null })
    expect(updates.get(child.runId)).toContain('read-only research subagent')
    expect(await gates.get(child.runId)!.check('write', {})).toContain('child capability snapshot')
    expect(harness.subagents.planSpawnRefusal(child.runId, { agent: 'explorer' })).toContain('not enabled')
    await harness.runs.interrupt('planned')
  })

  it('rejects unsafe global and project profile overrides by their effective allowlists', async () => {
    const { harness, start, root } = setup()
    mkdirSync(join(harness.env.root, 'agents'), { recursive: true })
    writeFileSync(join(harness.env.root, 'agents', 'researcher.md'), '---\ndescription: Unbounded researcher\n---\nResearch everything.\n')
    mkdirSync(join(root, '.xingular', 'agents'), { recursive: true })
    writeFileSync(join(root, '.xingular', 'agents', 'explorer.md'), '---\ndescription: Editable explorer\ntools: [read, edit]\nplugins: [web]\n---\nEdit files.\n')
    writeFileSync(join(root, '.xingular', 'agents', 'fact-checker.md'), '---\ndescription: Checks source facts\ntools: [read, grep]\nplugins: [history, variant]\n---\nReturn cited findings.\n')
    await start('plan-overrides', { plan: true, tools: { allow: ['read', 'edit', 'spawn_subagent', 'wait_subagents'] } })
    expect(harness.subagents.planSpawnRefusal('plan-overrides', { agent: 'researcher' })).toContain('not eligible')
    expect(harness.subagents.planSpawnRefusal('plan-overrides', { agent: 'explorer' })).toContain('not eligible')
    expect(harness.subagents.planSpawnRefusal('plan-overrides', { agent: 'fact-checker' })).toBeNull()
    await harness.runs.interrupt('plan-overrides')
  })
})

describe('agent profiles (PROP-0029)', () => {
  it('lists the profiles, narrows a child to its profile and records which one it started from', async () => {
    const { harness, start, systems, updates } = setup()
    await start('parent', { tools: { allow: ['read', 'grep', 'edit', 'bash', 'spawn_subagent', 'wait_subagents'] } })
    expect(updates.get('parent')).toContain('- explorer — Finds and explains code')
    expect(updates.get('parent')).toContain('- worker — Carries out a well-defined change')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Find the login route', agent: 'explorer' })
    expect(child.agent).toBe('explorer')
    expect(child.unavailableTools).toEqual(expect.arrayContaining(['find', 'ls']))
    expect(systems.get(child.runId)).toContain('Your role: explorer')
    const { loadRun: frozen } = await import('../capabilities/runSnapshot')
    const tools = frozen(harness.env.root, child.runId)!.tools
    expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'checklist_write']))
    expect(tools).not.toContain('edit')
    expect(tools).not.toContain('bash')
    expect(loadRun(harness.env.root, child.runId).profile).toBe('explorer')
    const copy = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Check the tests' })
    expect(loadRun(harness.env.root, copy.runId).profile ?? null).toBeNull()
    expect(frozen(harness.env.root, copy.runId)!.tools).toContain('edit')
  })

  it('lets a project profile replace a built-in and choose its own variant', async () => {
    const { harness, start, systems, updates, root } = setup()
    const { commit } = await import('../variant/store')
    const files = (prompt: string) => ({ 'systemprompt.md': prompt, 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' })
    commit(harness.env.root, 'caller', files('You coordinate releases.\n'), { kind: 'seed' })
    commit(harness.env.root, 'tester', files('You only run tests.\n'), { kind: 'seed' })
    const { createProfile } = await import('../agents/profiles')
    const { writeFileSync } = await import('node:fs')
    const made = createProfile(harness.env.root, root, { name: 'worker', scope: 'project' })
    writeFileSync(made.path!, '---\nname: worker\ndescription: Runs the tests only.\ncolor: yellow\nvariant: tester\nmodel: provider/profile-model\neffort: low\n---\nRun the test suite and report failures.\n')
    await start('parent', { variant: { scope: 'caller' }, model: 'provider/parent-model', effort: 'high', tools: { allow: ['read', 'bash', 'spawn_subagent', 'wait_subagents'] } })
    expect(updates.get('parent')).toContain('- worker — Runs the tests only.')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Run the tests', agent: 'worker' })
    expect(systems.get(child.runId)).toContain('Run the test suite and report failures.')
    expect(systems.get(child.runId)).toContain('You only run tests.')
    expect(systems.get(child.runId)).not.toContain('You coordinate releases.')
    expect(loadRun(harness.env.root, child.runId).variantScope).toBe('tester')
    expect(harness.subagents.runtimeSettings(child.runId)).toEqual({ model: 'provider/profile-model', effort: 'low' })
    harness.subagents.resolvedModel(child.runId, 'provider/actual-model', 'medium')
    expect(harness.subagents.runtimeSettings(child.runId)).toEqual({ model: 'provider/actual-model', effort: 'medium' })
  })
})

describe('subagent titles (PROP-0030)', () => {
  it('stores the title the parent gave, or the first line of the brief when it gave none', async () => {
    const { harness, start } = setup()
    await start('parent', { tools: { allow: ['read', 'spawn_subagent', 'wait_subagents'] } })
    const named = await harness.subagents.spawn({ parentRunId: 'parent', title: '  Map   the auth flow ', brief: 'Find the login route' })
    expect(loadRun(harness.env.root, named.runId).title).toBe('Map the auth flow')
    const unnamed = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'First line of a long brief\nsecond line with more detail' })
    expect(loadRun(harness.env.root, unnamed.runId).title).toBe('First line of a long brief')
    await expect(harness.subagents.spawn({ parentRunId: 'parent', title: 'one two three four five six seven', brief: 'x' })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
