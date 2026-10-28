import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { SessionRunInput } from './sessions'
import type { SessionFactory } from './runner'
import { SUBAGENT_OWNER, SUBAGENT_RECEIPT, subagentHistory } from './subagents'
import { loadRun, readEvents, recordSubagent, recordedSubagents, saveRun } from './runStore'
import type { Resolver } from '../plugins/discover'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

function setup(options: { resolver?: Resolver } = {}) {
  const finish = new Map<string, (text: string) => void>()
  const systems = new Map<string, string>()
  const updates = new Map<string, string | null>()
  const gates = new Map<string, { check: (name: string, args: unknown) => Promise<string | null> }>()
  const paramsByRun = new Map<string, Parameters<SessionFactory>[0]['params']>()
  const root = mkdtempSync(join(tmpdir(), 'native-subagents-'))
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), ...(options.resolver ? { resolver: options.resolver } : {}), sessionFactory: async ({ params }) => {
    paramsByRun.set(params.runId, params)
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
  return { harness, finish, start, systems, updates, gates, paramsByRun, root }
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

describe('subagent budgets', () => {
  const tools = { allow: ['read', 'spawn_subagent', 'wait_subagents'] }

  it('caps each profile and reports the effective quota', async () => {
    const { harness, start } = setup()
    await start('parent', { tools, subagents: { maxChildren: 20 } })
    expect(harness.subagents.quota('parent')).toEqual({ children: 20, profiles: { worker: 2, explorer: 3 }, other: 1, unprofiled: 1 })
    await harness.subagents.spawn({ parentRunId: 'parent', brief: 'One', agent: 'worker' })
    await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Two', agent: 'worker' })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'Three', agent: 'worker' })).rejects.toThrow('This run has used its 2 worker subagent slots.')
    expect(recordedSubagents(harness.env.root, 'parent')).toHaveLength(2)
    for (const brief of ['One', 'Two', 'Three']) await harness.subagents.spawn({ parentRunId: 'parent', brief, agent: 'explorer' })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'Four', agent: 'explorer' })).rejects.toThrow('This run has used its 3 explorer subagent slots.')
    await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Review', agent: 'researcher' })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'Review again', agent: 'researcher' })).rejects.toThrow('This run has used its 1 researcher subagent slot.')
    await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Unprofiled' })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'Unprofiled again' })).rejects.toThrow('This run has used its 1 unprofiled subagent slot.')
  })

  it('caps the total at four by default', async () => {
    const { harness, start } = setup()
    await start('parent', { tools, subagents: { maxUnprofiled: 10 } })
    for (const brief of ['1', '2', '3', '4']) await harness.subagents.spawn({ parentRunId: 'parent', brief })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: '5' })).rejects.toThrow('This run has used its 4 subagent slots.')
  })

  it('honours an explicit total before a profile limit', async () => {
    const { harness, start } = setup()
    await start('parent', { tools, subagents: { maxChildren: 1 } })
    await harness.subagents.spawn({ parentRunId: 'parent', brief: 'One', agent: 'worker' })
    await expect(harness.subagents.spawn({ parentRunId: 'parent', brief: 'Two', agent: 'explorer' })).rejects.toThrow('This run has used its 1 subagent slot.')
  })

  it('cannot overspend when two spawns arrive together', async () => {
    const { harness, start } = setup()
    await start('parent', { tools, subagents: { maxChildren: 1 } })
    const results = await Promise.allSettled([
      harness.subagents.spawn({ parentRunId: 'parent', brief: 'One' }),
      harness.subagents.spawn({ parentRunId: 'parent', brief: 'Two' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(recordedSubagents(harness.env.root, 'parent')).toHaveLength(1)
  })

  it('keeps the budget when a work slice continues the parent run', async () => {
    const { harness, start, root } = setup()
    await start('first', { tools, subagents: { maxChildren: 1 } })
    await harness.subagents.spawn({ parentRunId: 'first', brief: 'One', title: 'One' })
    await harness.runs.interrupt('first')
    mkdirSync(join(root, 'history'), { recursive: true })
    writeFileSync(join(root, 'history', 'parent.jsonl'), `${JSON.stringify({ type: 'session', id: 'native-history' })}\n`)
    await start('second', { tools, subagents: { maxChildren: 1 }, continueFrom: 'first' })
    expect(loadRun(harness.env.root, 'second').resumedFromRunId).toBe('first')
    await expect(harness.subagents.spawn({ parentRunId: 'second', brief: 'Two', title: 'Two' })).rejects.toThrow('This run has used its 1 subagent slot.')
  })
})

describe('native subagent ownership and delivery', () => {
  it('spawns asynchronously, joins selected children, and rejects foreign handles', async () => {
    const { harness, finish, start } = setup()
    await start('parent', { subagents: { maxChildren: 5, maxUnprofiled: 5 } })
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
    await start('parent', { subagents: { maxChildren: 5, maxUnprofiled: 5 } })
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

describe('subagent profiles a package brings', () => {
  it('lists them for the run and starts a child from one by its frontmatter name', async () => {
    const pkg = mkdtempSync(join(tmpdir(), 'profile-package-'))
    mkdirSync(join(pkg, 'agents'), { recursive: true })
    writeFileSync(join(pkg, 'plugin.json'), JSON.stringify({ name: 'egm', description: 'Spec reviews.' }))
    const persona = join(pkg, 'agents', 'design_critic.md')
    writeFileSync(persona, '---\nname: egm-design\ndescription: Hostile design critic.\ntools: [Read, Grep]\n---\nAudit the design with no prior context.\n')
    const resolver: Resolver = async () => [{ kind: 'agent', path: persona, origin: 'package', project: false, packageRoot: pkg, source: pkg, enabled: true }]
    const { harness, start, systems, updates } = setup({ resolver })
    await start('parent', { tools: { allow: ['read', 'grep', 'spawn_subagent', 'wait_subagents'] } })
    expect(updates.get('parent')).toContain('- egm-design — Hostile design critic.')
    const child = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'Review docs/design.md', agent: 'egm-design' })
    expect(child.agent).toBe('egm-design')
    expect(systems.get(child.runId)).toContain('Audit the design with no prior context.')
  })
})

describe('plan-mode research subagents', () => {
  it('allows only a named eligible profile and keeps its child read-only, non-nested and plan-gated', async () => {
    const { harness, start, gates, updates, finish, paramsByRun } = setup()
    await start('planned', {
      run: { id: 'planned', sessionId: 'opaque-parent', worktreeId: 'managed' },
      plan: true, subagents: { maxDepth: 3 }, connections: true,
      workSlice: { maxToolCalls: 1, maxSlices: 4, continue: true },
      tools: { allow: ['read', 'grep', 'edit', 'bash', 'ask_user', 'web_search', 'web_fetch', 'spawn_subagent', 'wait_subagents'] }
    })
    expect(updates.get('planned')).toContain('Plan mode may start only a named profile')
    expect(updates.get('planned')).toContain('- explorer — Finds and explains code')
    expect(updates.get('planned')).toContain('- researcher — Researches code, history and public sources')
    expect(updates.get('planned')).not.toContain('- worker —')
    expect(harness.subagents.planSpawnRefusal('planned', { brief: 'Explore' })).toContain('named')
    expect(harness.subagents.planSpawnRefusal('planned', { agent: 'worker' })).toContain('non-research tools')
    const incompatible = harness.subagents.planSpawnRefusal('planned', { agent: 'explorer', tools: ['edit', 'find'] })
    expect(incompatible).toContain('edit, find')
    expect(incompatible).toContain('Omit `tools`')
    expect(harness.subagents.planSpawnRefusal('planned', { agent: 'explorer' })).toBeNull()
    expect(await gates.get('planned')!.check('spawn_subagent', { agent: 'explorer' })).toBeNull()
    expect(await gates.get('planned')!.check('spawn_subagent', { agent: 'worker' })).toContain('Plan mode is research-only')
    expect(await gates.get('planned')!.check('spawn_subagent', {})).toContain('Plan mode is research-only')
    expect(await gates.get('planned')!.check('edit', {})).toContain('Plan mode is research-only')

    const child = await harness.subagents.spawn({ parentRunId: 'planned', brief: 'Trace the login route', agent: 'explorer' })
    const { loadRun: loadCapabilities } = await import('../capabilities/runSnapshot')
    const capabilities = loadCapabilities(harness.env.root, child.runId)!
    expect(capabilities.tools).toContain('read')
    for (const name of ['edit', 'write', 'bash', 'ask_user', 'mcp_call_tool', 'spawn_subagent', 'checkpoint_write']) expect(capabilities.tools).not.toContain(name)
    expect(capabilities.connectors).toEqual([])
    expect(loadRun(harness.env.root, child.runId)).toMatchObject({ relation: 'subagent', profile: 'explorer', worktreeId: null })
    expect(updates.get(child.runId)).toContain('read-only research subagent')
    expect(await gates.get(child.runId)!.check('write', {})).toContain('child capability snapshot')
    expect(harness.subagents.planSpawnRefusal(child.runId, { agent: 'explorer' })).toContain('not enabled')

    const params = paramsByRun.get(child.runId)!
    expect(params.slice?.maxToolCalls).toBe(1)
    const extension = params.inline?.find((candidate) => candidate.name === 'work-slice')
    expect(extension).toBeDefined()
    const handlers = new Map<string, (event: unknown) => unknown>()
    ;(extension!.factory as (pi: unknown) => void)({
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler)
    })
    handlers.get('agent_start')!({})
    const refusal = handlers.get('tool_call')!({ toolName: 'read', input: { path: 'src/login.ts' } }) as { block: boolean; reason: string }
    expect(refusal.block).toBe(true)
    expect(refusal.reason).toContain('partial research report')
    expect(refusal.reason).not.toContain('checkpoint_write')
    finish.get(child.runId)!('Partial research findings')
    await harness.runs.wait(child.runId)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(loadRun(harness.env.root, child.runId)).toMatchObject({ status: 'interrupted', terminalReason: 'slice_complete' })
    expect(readEvents(harness.env.root, child.runId).find((event) => event.type === 'checkpoint')?.payload).toMatchObject({ slice: 1, reason: 'budget', done: [] })
    expect(paramsByRun.size).toBe(2)
    await harness.runs.interrupt('planned')
  })

  it('omits research profiles with no evidence tools in the frozen parent capabilities', async () => {
    const { harness, start, updates } = setup()
    await start('no-research-tools', {
      plan: true,
      tools: { allow: ['spawn_subagent', 'wait_subagents'] },
      capabilities: { version: 1, tools: ['spawn_subagent', 'wait_subagents'], connectors: [], contributions: [] }
    })
    const prompt = updates.get('no-research-tools') ?? ''
    expect(prompt).toContain('No eligible read-only research profiles')
    expect(prompt).not.toContain('- explorer —')
    expect(harness.subagents.planSpawnRefusal('no-research-tools', { agent: 'explorer' })).toContain('no read-only research evidence tool')
    await harness.runs.interrupt('no-research-tools')
  })

  it('rejects unsafe global and project profile overrides by their effective allowlists', async () => {
    const { harness, start, root } = setup()
    mkdirSync(join(harness.env.root, 'agents'), { recursive: true })
    writeFileSync(join(harness.env.root, 'agents', 'researcher.md'), '---\ndescription: Unbounded researcher\n---\nResearch everything.\n')
    mkdirSync(join(root, '.xingular', 'agents'), { recursive: true })
    writeFileSync(join(root, '.xingular', 'agents', 'explorer.md'), '---\ndescription: Editable explorer\ntools: [read, edit]\nplugins: [web]\n---\nEdit files.\n')
    writeFileSync(join(root, '.xingular', 'agents', 'fact-checker.md'), '---\ndescription: Checks source facts\ntools: [read, grep]\nplugins: [history, variant]\n---\nReturn cited findings.\n')
    await start('plan-overrides', { plan: true, tools: { allow: ['read', 'edit', 'spawn_subagent', 'wait_subagents'] } })
    expect(harness.subagents.planSpawnRefusal('plan-overrides', { agent: 'researcher' })).toContain('explicit tools allowlist')
    expect(harness.subagents.planSpawnRefusal('plan-overrides', { agent: 'explorer' })).toContain('non-research tools')
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
    expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'todo_write']))
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
    await start('parent', { tools: { allow: ['read', 'spawn_subagent', 'wait_subagents'] }, subagents: { maxChildren: 5, maxUnprofiled: 5 } })
    const named = await harness.subagents.spawn({ parentRunId: 'parent', title: '  Map   the auth flow ', brief: 'Find the login route' })
    expect(loadRun(harness.env.root, named.runId).title).toBe('Map the auth flow')
    const unnamed = await harness.subagents.spawn({ parentRunId: 'parent', brief: 'First line of a long brief\nsecond line with more detail' })
    expect(loadRun(harness.env.root, unnamed.runId).title).toBe('First line of a long brief')
    await expect(harness.subagents.spawn({ parentRunId: 'parent', title: 'one two three four five six seven', brief: 'x' })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('continuing a stopped subagent', () => {
  const tools = { allow: ['read', 'spawn_subagent', 'wait_subagents'] }
  const owner = (runId: string) => subagentHistory([{ type: 'custom', customType: SUBAGENT_OWNER, data: { runId } }])
  const savedHistory = (root: string, childRunId: string) => {
    const folder = join(root, 'history', 'subagents', childRunId)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'child.jsonl'), `${JSON.stringify({ type: 'session', id: 'native-history' })}\n`)
  }

  it('reopens the stopped child’s own history as a new child run of the next parent', async () => {
    const { harness, start, updates, root } = setup()
    await start('original', { tools })
    const child = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Map the auth flow', title: 'Map auth' })
    await harness.runs.interrupt('original')
    expect(loadRun(harness.env.root, child.runId).status).toBe('interrupted')
    savedHistory(root, child.runId)

    // The next launch of the same conversation may carry another session id.
    await start('resumed', { tools, run: { id: 'resumed', sessionId: 'another-launch' } })
    const notice = await harness.subagents.delivery('resumed', owner('original'), false)
    expect(notice?.text).toContain(`Subagent run ${child.runId} · interrupted (Map auth)`)
    expect(notice?.text).toContain(`spawn_subagent { "continue": "${child.runId}" }`)

    const continued = await harness.subagents.spawn({ parentRunId: 'resumed', continue: child.runId })
    expect(continued.continued).toBe(child.runId)
    const record = loadRun(harness.env.root, continued.runId)
    expect(record).toMatchObject({ relation: 'subagent', parentRunId: 'resumed', resumedFromRunId: child.runId, sessionId: loadRun(harness.env.root, child.runId).sessionId, title: 'Map auth', goal: 'Map the auth flow' })
    expect(updates.get(continued.runId)).toContain(`The previous run (${child.runId}) stopped before it finished`)
    expect(harness.subagents.results({ parentRunId: 'resumed' }).map(result => result.runId)).toContain(continued.runId)

    // The stopped link is reported through its continuation, and the chain resolves to the newest link.
    const history = subagentHistory([{ type: 'custom', customType: SUBAGENT_OWNER, data: { runId: 'original' } }, { type: 'custom_message', details: { [SUBAGENT_RECEIPT]: notice!.receipt } }])
    expect(await harness.subagents.delivery('resumed', history, false)).toBeNull()
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', continue: child.runId })).rejects.toThrow('is still running')
  })

  it('refuses what it cannot continue', async () => {
    const { harness, finish, start, root } = setup()
    await start('original', { tools, subagents: { maxChildren: 5, maxUnprofiled: 5 } })
    const done = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Finish', title: 'Finish' })
    finish.get(done.runId)!('Finished')
    await harness.runs.wait(done.runId)
    const stopped = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Stop', title: 'Stop' })
    const unsaved = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Unsaved', title: 'Unsaved' })
    await expect(harness.subagents.spawn({ parentRunId: 'original', continue: stopped.runId })).rejects.toThrow('is still running')
    await harness.runs.interrupt('original')
    savedHistory(root, stopped.runId)
    await start('resumed', { tools })
    harness.subagents.restore('resumed', owner('original'))
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', continue: 'foreign' })).rejects.toThrow('Continue only a subagent that this conversation started.')
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', continue: done.runId })).rejects.toThrow('already finished')
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', continue: unsaved.runId })).rejects.toThrow('saved conversation is missing')
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', continue: stopped.runId, agent: 'worker' })).rejects.toThrow('keeps its profile and tools')
    await harness.runs.interrupt('resumed')
    // A parent that lost a tool the child had cannot widen it back.
    await start('narrower', { tools: { allow: ['spawn_subagent', 'wait_subagents'] } })
    harness.subagents.restore('narrower', owner('original'))
    await expect(harness.subagents.spawn({ parentRunId: 'narrower', continue: stopped.runId })).rejects.toThrow('needs capabilities you do not have in this run: read')
  })

  it('continues a stopped child even when its run has used every slot', async () => {
    const { harness, start, root } = setup()
    await start('original', { tools, subagents: { maxChildren: 1, maxUnprofiled: 1 } })
    const child = await harness.subagents.spawn({ parentRunId: 'original', brief: 'Map the auth flow', title: 'Map auth' })
    await harness.runs.interrupt('original')
    savedHistory(root, child.runId)
    await start('resumed', { tools, subagents: { maxChildren: 1, maxUnprofiled: 1 } })
    harness.subagents.restore('resumed', owner('original'))
    await harness.subagents.spawn({ parentRunId: 'resumed', brief: 'Fill the budget', title: 'Fill' })
    await expect(harness.subagents.spawn({ parentRunId: 'resumed', brief: 'Over budget', title: 'Over' })).rejects.toThrow('This run has used its 1 subagent slot.')
    const continued = await harness.subagents.spawn({ parentRunId: 'resumed', continue: child.runId })
    expect(continued.continued).toBe(child.runId)
  })

  it('tells a continued parent to continue its unfinished children rather than start them again', async () => {
    const { continuationBody, continuationOf } = await import('./continuation')
    const body = continuationBody({ ...continuationOf('/nowhere', 'missing'), runId: 'parent', unfinishedSubagents: ['child-1'] })
    expect(body).toContain('Subagents that did not finish: child-1.')
    expect(body).toContain('spawn_subagent { "continue": "<run ID>" }')
    expect(body).not.toContain('Start them again')
  })
})
