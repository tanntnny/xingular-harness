import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHarness, type Harness } from '../../harness'
import { memorySecretStore } from '../../accounts/secrets'
import { connectionFromEnv, socketCall, terminalCall } from '../client'
import type { TerminalPrepareInput } from '../terminals'
import { controlCall } from '../control'
import { readAllRuns } from '../../sessions/runIndex'
import { createTerminalRuntime, type TerminalRuntime } from './runtime'

const opened: Array<{ harness: Harness; runtime?: TerminalRuntime; root: string }> = []
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.runtime?.dispose()
    await entry.harness.close()
    rmSync(entry.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function setup(input: Partial<TerminalPrepareInput> = {}, packagePrompts = false) {
  const root = mkdtempSync(join(tmpdir(), 'harness-sdk-socket-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const pkg = join(root, 'package')
  const prompts = join(pkg, 'prompts')
  if (packagePrompts) {
    mkdirSync(prompts, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'devkit', harness: { commandPrefix: 'xdiag', defaultPrompt: 'diagnose' } }))
    writeFileSync(join(prompts, 'diagnose.md'), 'Diagnose ${1:-current-session}')
    writeFileSync(join(prompts, 'sweep.md'), 'Sweep $1')
  }
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), resolver: async () => packagePrompts ? [{ kind: 'prompt', path: prompts, origin: 'package', packageRoot: pkg, project: false, source: pkg, enabled: true }] : [], assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
  const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
  opened.push(entry)
  await harness.ready
  const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
  const launch = await harness.terminals.prepare({ sessionId: 'offline-sdk', cwd, accountId: account.id, sessionFolder: join(root, 'history'), ...input })
  for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
  const notify = vi.fn()
  // Bun consumes its flags and the frontend script before the runtime sees process.argv.
  const runtime = await createTerminalRuntime(launch.args.slice(2), { ui, notify, changed: vi.fn(), shutdown: vi.fn() })
  entry.runtime = runtime
  return { harness, runtime, ui, account, notify }
}

describe('a native SDK runtime on the actual Harness terminal socket', () => {
  it('resolves model-tool current against each active run and not after settlement', async () => {
    const { harness } = await setup()
    const connection = connectionFromEnv()
    await socketCall(connection, 'tools.list')
    const readCurrent = () => socketCall<{ text: string }>(connection, 'tools.call', { name: 'trajectory_read', input: { run: 'current' } })
    expect((await readCurrent()).text).toContain('no current run')
    const ids: string[] = []
    for (const text of ['First run', 'Second run']) {
      await terminalCall('begin', { text })
      const id = harness.runs.activeForSession('offline-sdk')!.runId
      ids.push(id)
      expect(JSON.parse((await readCurrent()).text).run.id).toBe(id)
      await terminalCall('settled', { aborted: false })
      expect((await readCurrent()).text).toContain('no current run')
    }
    expect(ids[0]).not.toBe(ids[1])
  })

  it('exposes selected package prompts only under the declared owner prefix after reload', async () => {
    const { runtime } = await setup({}, true)
    const names = () => runtime.session.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)
    expect(names()).toEqual(expect.arrayContaining(['xdiag:', 'xdiag:sweep']))
    expect(names()).not.toEqual(expect.arrayContaining(['diagnose', 'sweep']))
    await expect(runtime.session.prompt('/diagnose item')).rejects.toThrow('requires its owner prefix')
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    faux.setResponses([ai.fauxAssistantMessage('Done'), ai.fauxAssistantMessage('Done')])
    await runtime.session.prompt('/xdiag:')
    await runtime.session.prompt('/xdiag: item')
    const branch = JSON.stringify(runtime.session.sessionManager.getBranch())
    expect(branch).toContain('Diagnose current-session')
    expect(branch).toContain('Diagnose item')
    await runtime.reload()
    expect(names()).toEqual(expect.arrayContaining(['xdiag:', 'xdiag:sweep']))
  })
  it('reads and changes shared terminal permissions only through the claimed private control key', async () => {
    const { runtime } = await setup()
    await expect(socketCall(connectionFromEnv(), 'terminal.permissions.get')).rejects.toThrow('Only a person')
    expect(await runtime.permissions()).toEqual({ full: false, globalTools: [] })
    await runtime.setGlobalTool('bash', true)
    await runtime.setFullPermission(true)
    expect(await runtime.permissions()).toEqual({ full: true, globalTools: ['bash'] })
    await runtime.setGlobalTool('bash', false)
    await runtime.setFullPermission(false)
    expect(await runtime.permissions()).toEqual({ full: false, globalTools: [] })
  })

  it('lists the workspace edit and write tools in the prompt and sends them to the model', async () => {
    const { runtime } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    let sent: string[] = []
    faux.setResponses([(context) => {
      sent = ai.getCurrentTools(context.messages.filter(message => message.role === 'system')).map(tool => tool.name)
      return ai.fauxAssistantMessage('Done')
    }])
    await runtime.submit('Rename a variable')
    const prompt = runtime.session.systemPrompt
    expect(prompt).toMatch(/^- edit: /m)
    expect(prompt).toMatch(/^- write: /m)
    expect(sent).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']))
  })

  it('reads and refreshes credentials through the host store, with no auth.json', async () => {
    const { harness, runtime, account } = await setup()
    await harness.accounts.writeCredential(account.id, 'openai', { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 })
    expect((await runtime.services.modelRuntime.listCredentials()).map(item => item.providerId)).toContain('openai')
    const { terminalCredentialStore } = await import('../credentialStore')
    const store = terminalCredentialStore()
    const refreshed = await store.modify('openai', async current => ({ ...current!, access: 'a2', refresh: 'r2', expires: 2 }) as never)
    expect((refreshed as { refresh?: string } | undefined)?.refresh).toBe('r2')
    expect((await harness.accounts.readCredential(account.id, 'openai'))?.refresh).toBe('r2')
    const agentDir = process.env.PI_CODING_AGENT_DIR
    expect(agentDir).toBeTruthy()
    expect(existsSync(join(agentDir!, 'auth.json'))).toBe(false)
  })

  it('hides question tools in normal mode and activates them only during plan requests', async () => {
    const { runtime } = await setup()
    const session = runtime.session
    expect(session.getActiveToolNames()).not.toContain('ask_user')
    let planTools: string[] = []
    let failPlan = false
    const prompt = vi.spyOn(session, 'prompt').mockImplementation(async () => {
      planTools = session.getActiveToolNames()
      if (failPlan) throw new Error('Plan failed')
    })

    await runtime.submitPlan('Decide which option to choose')

    expect(planTools).toContain('ask_user')
    expect(planTools).toContain('spawn_subagent')
    expect(planTools).toContain('wait_subagents')
    expect(session.getActiveToolNames()).toContain('spawn_subagent')
    expect(session.getActiveToolNames()).not.toContain('ask_user')

    failPlan = true
    await expect(runtime.submitPlan('Try again and fail')).rejects.toThrow('Plan failed')
    expect(session.getActiveToolNames()).not.toContain('ask_user')

    let rejectPlan!: (error: Error) => void
    prompt.mockImplementation(() => new Promise((_, reject) => { rejectPlan = reject }))
    const interrupted = runtime.submitPlan('Interrupt this plan')
    const settled = expect(interrupted).rejects.toThrow('Interrupted')
    await vi.waitFor(() => expect(session.getActiveToolNames()).toContain('ask_user'))
    await runtime.interrupt()
    rejectPlan(new Error('Interrupted'))
    await settled
    expect(session.getActiveToolNames()).not.toContain('ask_user')
  })

  it('repairs an unstructured clarification within the same terminal run', async () => {
    const { harness, runtime } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    faux.setResponses([
      ai.fauxAssistantMessage('Which option?'),
      ai.fauxAssistantMessage([ai.fauxToolCall('ask_user', { questions: [{ summary: 'Choice', question: 'Which option?', options: [{ label: 'A', description: 'Choose A', recommended: true }] }] })], { stopReason: 'toolUse' }),
      ai.fauxAssistantMessage('<proposed_plan># Choose A\nUse A.</proposed_plan>')
    ])
    const planning = runtime.submitPlan('Choose an option')
    let questions: Array<{ requestId: string; batchId: string; type: string }> = []
    await vi.waitFor(async () => {
      const pending = await runtime.pending()
      const approval = pending.find(item => item.type === 'approval')
      if (approval) await runtime.approve(approval.requestId, 'approved', false)
      questions = pending.filter(item => item.type === 'question') as typeof questions
      expect(questions).toHaveLength(1)
    })
    await runtime.answerBatch(questions[0].batchId, [{ questionId: questions[0].requestId, answer: { selected: ['A'] } }])
    await planning
    expect(runtime.session.getLastAssistantText()).toContain('<proposed_plan># Choose A')
    const runs = readAllRuns(harness.env.root).filter(run => run.goal === 'Choose an option')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('completed')
    expect(runtime.session.getActiveToolNames()).not.toContain('ask_user')
  })

  it('does not activate research delegation when the terminal disables subagents', async () => {
    const { runtime } = await setup({ subagents: null })
    const session = runtime.session
    let planTools: string[] = []
    vi.spyOn(session, 'prompt').mockImplementation(async () => { planTools = session.getActiveToolNames() })
    await runtime.submitPlan('Inspect this without delegation')
    expect(planTools).not.toContain('spawn_subagent')
    expect(planTools).not.toContain('wait_subagents')
    expect(session.getActiveToolNames()).not.toContain('spawn_subagent')
  })

  it('keeps normal-mode tools when the session is rebuilt from its transcript after a plan', async () => {
    const { runtime } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    const sent: string[][] = []
    const reply = (text: string): Parameters<typeof faux.setResponses>[0][number] => (context) => {
      sent.push(ai.getCurrentTools(context.messages.filter(message => message.role === 'system')).map(tool => tool.name))
      return ai.fauxAssistantMessage(text)
    }
    const normal = [...runtime.session.getActiveToolNames()].sort()
    expect(normal).toEqual(expect.arrayContaining(['edit', 'write']))
    const rebuild = async () => {
      await runtime.switchSession(runtime.session.sessionFile!)
      await runtime.session.setModel(faux.getModel())
    }
    const implement = async (text: string) => {
      faux.setResponses([reply('Done')])
      await runtime.submit(text)
      expect(sent.at(-1)).toEqual(expect.arrayContaining(['edit', 'write']))
      expect(sent.at(-1)).not.toContain('ask_user')
    }

    // Back and forth: a plan, a rebuild before any normal request, then normal work.
    for (const cycle of [1, 2, 3]) {
      faux.setResponses([reply(`<proposed_plan># Plan ${cycle}\nDo it.</proposed_plan>`)])
      await runtime.submitPlan(`Plan ${cycle}`)
      expect(sent.at(-1)).toContain('ask_user')
      expect(sent.at(-1)).not.toContain('edit')
      await rebuild()
      expect([...runtime.session.getActiveToolNames()].sort()).toEqual(normal)
      await implement(`Implement ${cycle}`)
    }

    // The recorded failure: a plan aborted, planned again (which declares nothing new), then rebuilt.
    const prompt = runtime.session.prompt.bind(runtime.session)
    const aborted = vi.spyOn(runtime.session, 'prompt').mockImplementationOnce(async (text, options) => {
      faux.setResponses([reply('<proposed_plan># Partial\nStart.</proposed_plan>')])
      await prompt(text, options)
      throw new Error('Request aborted')
    })
    await expect(runtime.submitPlan('Plan again')).rejects.toThrow('Request aborted')
    aborted.mockRestore()
    faux.setResponses([reply('<proposed_plan># Again\nDo it.</proposed_plan>')])
    await runtime.submitPlan('Plan again')
    await rebuild()
    expect([...runtime.session.getActiveToolNames()].sort()).toEqual(normal)
    await implement('Implement the plan: Again')
  })

  it('keeps normal-mode tools, including a disabled one, when tree navigation lands inside a plan', async () => {
    const { runtime } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    const normal = runtime.session.getActiveToolNames().filter(name => name !== 'web_fetch')
    runtime.session.setActiveToolsByName(normal)
    faux.setResponses([ai.fauxAssistantMessage('<proposed_plan># Plan\nDo it.</proposed_plan>')])
    await runtime.submitPlan('Plan inside the tree')
    const reply = runtime.session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').at(-1)!
    const result = await runtime.navigateTree(reply.id, { summarize: false })
    expect(result.cancelled).toBe(false)
    expect([...runtime.session.getActiveToolNames()].sort()).toEqual([...normal].sort())
    expect(runtime.session.getActiveToolNames()).not.toContain('web_fetch')
  })

  it('freezes actual callable tools even when delegation is disabled, without Pi CLI builtins', async () => {
    const { harness, runtime } = await setup({ subagents: null, connections: false })
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    await runtime.session.setModel(faux.getModel())
    faux.setResponses([ai.fauxAssistantMessage('Offline normal'), ai.fauxAssistantMessage('Offline plan')])
    const { loadRun } = await import('../../capabilities/runSnapshot')
    expect(runtime.session.extensionRunner.getExtensionPaths().some(path => /inline:(llama.cpp|codemode|tool-search|mcp)>/.test(path))).toBe(false)
    await runtime.submit('Normal without delegation')
    const normal = readAllRuns(harness.env.root).find(run => run.goal === 'Normal without delegation')!
    expect(loadRun(harness.env.root, normal.id)?.tools).toEqual(runtime.session.getActiveToolNames())
    expect(loadRun(harness.env.root, normal.id)?.tools).not.toContain('ask_user')
    await runtime.submitPlan('Plan without delegation')
    const plan = readAllRuns(harness.env.root).find(run => run.goal === 'Plan without delegation')!
    expect(loadRun(harness.env.root, plan.id)?.tools).toContain('ask_user')
    expect(loadRun(harness.env.root, plan.id)?.tools).not.toContain('spawn_subagent')
    expect(runtime.session.getActiveToolNames()).not.toContain('ask_user')
  })

  it('runs asynchronous children through the protected bridge and joins their results before settling', async () => {
    const { harness, runtime } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const faux = ai.fauxProvider()
    runtime.services.modelRuntime.registerNativeProvider(faux.provider)
    harness.accounts.runtime = async () => runtime.services.modelRuntime
    await runtime.session.setModel(faux.getModel())
    const route = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const users = context.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : (message.content as Array<{ text?: string }>).map(part => part.text ?? '').join(''))
      if (users.includes('terminal-native-child')) return ai.fauxAssistantMessage('TERMINAL_CHILD_EVIDENCE')
      if (JSON.stringify(context.messages).includes('TERMINAL_CHILD_EVIDENCE')) return ai.fauxAssistantMessage('Final with TERMINAL_CHILD_EVIDENCE')
      if (!context.messages.some(message => message.role === 'toolResult')) return ai.fauxAssistantMessage([ai.fauxToolCall('spawn_subagent', { title: 'Run terminal child', brief: 'terminal-native-child' })], { stopReason: 'toolUse' })
      return ai.fauxAssistantMessage('Draft before joining')
    }
    faux.setResponses(Array(8).fill(route) as never)
    await expect(socketCall(connectionFromEnv(), 'terminal.subagents.tools')).rejects.toThrow('Only a person')
    await runtime.session.prompt('Terminal parent')
    const runs = readAllRuns(harness.env.root)
    const parent = runs.find(run => run.sessionId === 'offline-sdk')!
    const child = runs.find(run => run.relation === 'subagent')!
    expect(parent.status).toBe('completed')
    expect(child).toMatchObject({ parentRunId: parent.id, accountId: parent.accountId, status: 'completed' })
    expect(harness.runs.activeRunIds()).toEqual([])
    const entries = readFileSync(runtime.session.sessionFile!, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const receipts = entries.filter(entry => entry.customType === 'xingular-subagent-results')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].content).toContain('TERMINAL_CHILD_EVIDENCE')
    expect(harness.terminals.state('offline-sdk').active).toBe(false)
  })

  it('retains the latest parent’s flat child activity until the next run', async () => {
    const { harness } = await setup()
    await terminalCall('begin', { text: 'Observe child work', model: 'test/model-1', effort: 'high' })
    const parentId = harness.runs.activeForSession('offline-sdk')!.runId
    const { loadRun, recordSubagent, saveRun } = await import('../../sessions/runStore')
    const parent = loadRun(harness.env.root, parentId)!
    saveRun(harness.env.root, {
      ...parent, id: 'observed-child', sessionId: 'opaque-child', parentRunId: parentId, relation: 'subagent',
      nativeSessionId: null, status: 'queued', endedAt: null, goal: 'Inspect auth flow'
    })
    saveRun(harness.env.root, {
      ...parent, id: 'observed-nested', sessionId: 'opaque-nested', parentRunId: 'observed-child', relation: 'subagent',
      nativeSessionId: null, status: 'queued', endedAt: null, goal: 'Check token handling'
    })
    saveRun(harness.env.root, {
      ...parent, id: 'unrelated-child', sessionId: 'other-child', parentRunId: 'other-parent', relation: 'subagent',
      nativeSessionId: null, status: 'queued', endedAt: null, goal: 'Unrelated task'
    })
    recordSubagent(harness.env.root, parentId, 'observed-child')
    recordSubagent(harness.env.root, 'observed-child', 'observed-nested')

    const child = harness.runs.start('opaque-child', 'observed-child')
    child.emit('tool.started', { toolCallId: 'read-1', name: 'read', summary: 'src/auth.ts', input: '{"token":"hidden"}' })
    const nested = harness.runs.start('opaque-nested', 'observed-nested')
    nested.emit('tool.started', { toolCallId: 'grep-1', name: 'grep', summary: 'token validation' })
    const unrelated = harness.runs.start('other-child', 'unrelated-child')
    unrelated.emit('tool.started', { toolCallId: 'write-1', name: 'write', summary: 'outside parent' })

    const { children } = await controlCall<{ children: Array<{ id: string; goal: string; activity: string }> }>('terminal.subagents.monitor')
    expect(children.map(item => item.id)).toEqual([parentId, 'observed-child', 'observed-nested'])
    expect(children[0]).toEqual(expect.objectContaining({ relation: 'main', profile: { name: 'main', color: 'main' }, goal: 'Observe child work', model: 'test/model-1', effort: 'high' }))
    expect(children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'observed-child', goal: 'Inspect auth flow', activity: 'read' }),
      expect.objectContaining({ id: 'observed-nested', goal: 'Check token handling', activity: 'grep' })
    ]))
    const activity = JSON.stringify(children)
    expect(activity).not.toContain('src/auth.ts')
    expect(activity).not.toContain('token validation')
    expect(activity).not.toContain('hidden')

    child.finish('completed')
    nested.finish('completed')
    unrelated.finish('completed')
    await terminalCall('settled', { aborted: false })

    const settled = await controlCall<{ children: Array<{ id: string; status: string; activity: string }> }>('terminal.subagents.monitor')
    expect(settled.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'observed-child', status: 'completed', activity: 'Completed' }),
      expect.objectContaining({ id: 'observed-nested', status: 'completed', activity: 'Completed' })
    ]))
    expect(settled.children.map(item => item.id)).not.toContain('unrelated-child')
    expect(settled.children[0]).toEqual(expect.objectContaining({ id: parentId, relation: 'main', status: 'completed' }))

    const native = loadRun(harness.env.root, parentId).nativeSessionId
    await terminalCall('ready', { nativeSessionId: '/history/replaced-session.jsonl' })
    await expect(controlCall('terminal.subagents.monitor')).resolves.toEqual({ children: [] })

    // Reopening the conversation shows its latest parent run again, from the saved runs.
    await terminalCall('ready', { nativeSessionId: native, owners: ['missing-owner', parentId] })
    const reopened = await controlCall<{ children: Array<{ id: string; relation: string; status: string; activity: string; model?: string | null; effort?: string | null }> }>('terminal.subagents.monitor')
    expect(reopened.children.map(item => item.id)).toEqual([parentId, 'observed-child', 'observed-nested'])
    expect(reopened.children).toEqual([
      expect.objectContaining({ id: parentId, relation: 'main', status: 'completed', model: 'test/model-1', effort: 'high' }),
      expect.objectContaining({ id: 'observed-child', relation: 'subagent', status: 'completed', activity: 'Completed' }),
      expect.objectContaining({ id: 'observed-nested', relation: 'subagent', status: 'completed', activity: 'Completed' })
    ])
    expect(JSON.stringify(reopened.children)).not.toContain('hidden')

    await terminalCall('begin', { text: 'Next parent run' })
    const next = await controlCall<{ children: Array<{ relation: string; goal: string }> }>('terminal.subagents.monitor')
    expect(next.children).toEqual([expect.objectContaining({ relation: 'main', goal: 'Next parent run' })])
    await terminalCall('settled', { aborted: true })
  })

  it('routes a child approval to its original run through the terminal decision controls', async () => {
    const { harness, runtime } = await setup()
    await terminalCall('begin', { text: 'Parent fixture' })
    await controlCall('terminal.subagents.register', { tools: ['read', 'bash', 'spawn_subagent', 'wait_subagents'], history: { owners: [], receipts: [] } })
    const parentId = harness.runs.activeForSession('offline-sdk')!.runId
    const { loadRun, saveRun } = await import('../../sessions/runStore')
    const parent = loadRun(harness.env.root, parentId)
    saveRun(harness.env.root, { ...parent, id: 'approval-child', sessionId: 'opaque-child', parentRunId: parentId, relation: 'subagent', status: 'queued', endedAt: null })
    const active = harness.runs.start('opaque-child', 'approval-child')
    const answer = active.requestApproval({ target: 'bash', action: 'fixture', rememberable: false })
    let pending: Awaited<ReturnType<typeof runtime.pending>> = []
    await vi.waitFor(async () => { pending = await runtime.pending(); expect(pending).toHaveLength(1) })
    await runtime.approve(pending[0].requestId, 'denied')
    await expect(answer).resolves.toBe('denied')
    expect(await runtime.pending()).toEqual([])
    active.finish('interrupted')
  })

  it('offers native tools without connected apps and preserves a read-only child ceiling', async () => {
    const { harness, runtime } = await setup({ connections: false, readOnly: true })
    expect(runtime.session.getToolDefinition('spawn_subagent')).toBeDefined()
    await terminalCall('begin', { text: 'Read-only parent' })
    await controlCall('terminal.subagents.register', { tools: ['read', 'write', 'bash', 'spawn_subagent', 'wait_subagents'], history: { owners: [], receipts: [] } })
    const parentRunId = harness.runs.activeForSession('offline-sdk')!.runId
    await expect(harness.subagents.spawn({ parentRunId, brief: 'Cannot widen', tools: ['write'] })).rejects.toThrow('cannot have tools')
    const { loadRun } = await import('../../capabilities/runSnapshot')
    expect(loadRun(harness.env.root, parentRunId)?.tools).toEqual(['read', 'spawn_subagent', 'wait_subagents'])
    await runtime.interrupt()
  })

  it('lists only eligible research profiles to plan runs and checks terminal delegation before policy', async () => {
    const { harness, runtime } = await setup()
    const { profiles } = await controlCall<{ profiles: { normal: string; plan: string } }>('terminal.subagents.tools')
    expect(profiles.plan).toContain('- explorer —')
    expect(profiles.plan).toContain('- researcher —')
    expect(profiles.plan).not.toContain('- worker —')

    await terminalCall('begin', { text: 'Plan research' })
    const parentRunId = harness.runs.activeForSession('offline-sdk')!.runId
    const registered = await controlCall<{ subagentProfiles: { plan: string } }>('terminal.subagents.register', {
      tools: ['read', 'edit', 'bash', 'spawn_subagent', 'wait_subagents'], plan: true,
      history: { owners: [], receipts: [] }
    })
    expect(registered.subagentProfiles.plan).toContain('- explorer —')
    expect(registered.subagentProfiles.plan).toContain('- researcher —')
    expect(registered.subagentProfiles.plan).not.toContain('- worker —')
    await expect(controlCall<{ allowed: boolean }>('terminal.subagents.planSafe', { input: { agent: 'explorer', brief: 'Trace the login route' } })).resolves.toEqual({ allowed: true })
    const unsafe = await controlCall<{ allowed: boolean; reason: string }>('terminal.subagents.planSafe', { input: { agent: 'worker', brief: 'Change the login route' } })
    expect(unsafe).toMatchObject({ allowed: false, reason: expect.stringContaining('non-research tools') })
    expect(harness.runs.activeForSession('offline-sdk')!.runId).toBe(parentRunId)
    await runtime.interrupt()
  })

  it('keeps the same account and readiness after new/reload without duplicate page commands', async () => {
    const { harness, runtime } = await setup()
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: true, dirty: false, active: false })
    expect(runtime.session.extensionRunner.getExtensionPaths()).toEqual(['<inline:harness-terminal-bridge>', '<inline:harness-mode-choices>', '<inline:harness-run-capabilities>'])
    expect(runtime.services.agentDir).toContain(harness.accounts.dir)
    for (const command of ['accounts', 'plugins', 'hub']) expect(runtime.session.extensionRunner.getCommand(command)).toBeUndefined()
    await runtime.newSession()
    await runtime.reload()
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: true, dirty: false, active: false })
    await expect(controlCall('terminal.resources')).resolves.toEqual({})
    await expect(socketCall(connectionFromEnv(), 'control.claim')).rejects.toThrow('already claimed')
    const blocked = await runtime.session.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'no-active-run', input: { command: 'echo must-not-execute' } })
    expect(blocked?.block).toBe(true)
    await runtime.dispose()
    expect(harness.terminals.state('offline-sdk').ready).toBe(false)
  })

  it('starts a resumed conversation this account cannot use on the account’s latest choice', async () => {
    const { harness, runtime, account, notify } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    const chosen = ai.fauxProvider({ provider: 'faux-a', models: [{ id: 'one', reasoning: true }] })
    const other = ai.fauxProvider({ provider: 'faux-b', models: [{ id: 'two' }] })
    runtime.services.modelRuntime.registerNativeProvider(chosen.provider)
    runtime.services.modelRuntime.registerNativeProvider(other.provider)
    // Pi's own fallback default, kept apart from the account's choice so the two are distinguishable.
    writeFileSync(join(runtime.services.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'faux-b', defaultModel: 'two', defaultThinkingLevel: 'low' }))
    harness.accounts.choose(account.id, 'normal', { model: 'faux-a/one', effort: 'high' })
    // A new conversation re-reads the account's choices.
    await runtime.newSession()
    expect(await runtime.services.modelRuntime.checkAuth('faux-a')).toBeTruthy()

    const at = new Date().toISOString()
    const prior = join(runtime.sessionDirectory, '2026-01-01T00-00-00-000Z_prior.jsonl')
    writeFileSync(prior, [
      { type: 'session', version: 3, id: 'prior', timestamp: at, cwd: runtime.cwd },
      { type: 'model_change', id: 'prior-1', parentId: null, timestamp: at, provider: 'unusable', modelId: 'offline' },
      { type: 'message', id: 'prior-2', parentId: 'prior-1', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'Earlier work' }], timestamp: Date.now() } }
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const choicesFile = join(harness.accounts.dir, account.id, 'choices.json')
    const saved = readFileSync(choicesFile, 'utf8')
    notify.mockClear()

    await runtime.switchSession(prior)

    expect(runtime.session.model).toMatchObject({ provider: 'faux-a', id: 'one' })
    expect(runtime.session.thinkingLevel).toBe('high')
    // The conversation records the switch, so the next resume needs no fallback.
    expect(runtime.session.sessionManager.getBranch().filter(entry => entry.type === 'model_change').at(-1)).toMatchObject({ provider: 'faux-a', modelId: 'one' })
    // It is the terminal's own change, never the person's saved choice.
    expect(readFileSync(choicesFile, 'utf8')).toBe(saved)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('cannot use unusable/offline')
    expect(notify.mock.calls[0][0]).toContain('faux-a/one')
  })

  it('submits grouped terminal answers atomically through the protected real registry', async () => {
    const { harness, runtime } = await setup()
    const events: Array<{ type: string; payload: unknown }> = []
    harness.runs.listen(event => { events.push(event) })
    await terminalCall('begin', { text: 'Grouped terminal fixture' })
    const tool = runtime.session.getToolDefinition('ask_user')!
    const result = tool.execute('batch-tool', { questions: [
      { summary: 'First choice', question: 'Which?', options: [{ label: 'A', description: 'First option', recommended: true }] },
      { summary: 'Second answer', question: 'Why?', options: [{ label: 'A reason', description: 'Choose this or type another reason.', recommended: true }] }
    ] }, undefined, undefined, runtime.session.extensionRunner.createToolContext('batch-tool', undefined))
    let questions: Array<{ requestId: string; batchId: string }> = []
    await vi.waitFor(async () => {
      questions = await runtime.pending() as typeof questions
      expect(questions).toHaveLength(2)
    })
    expect(questions[0].batchId).toBe(questions[1].batchId)
    const answers = [{ questionId: questions[0].requestId, answer: { selected: ['A'] } }, { questionId: questions[1].requestId, answer: { selected: [], text: 'Because' } }]
    await expect(socketCall(connectionFromEnv(), 'terminal.answers', { batchId: questions[0].batchId, answers })).rejects.toThrow('Only a person')
    await expect(controlCall('terminal.answers', { batchId: questions[0].batchId, answers: answers.slice(0, 1) })).rejects.toThrow('batch')
    expect(events.filter(event => event.type === 'question.answered')).toHaveLength(0)
    await runtime.answerBatch(questions[0].batchId, answers)
    await expect(result).resolves.toMatchObject({ content: [{ text: 'First choice: The user chose: A.\nSecond answer: The user answered: Because' }] })
    expect(events.filter(event => event.type === 'question.answered')).toHaveLength(2)
    await expect(controlCall('terminal.pending')).resolves.toEqual({ requests: [] })
  })

  it('settles an actual socket-backed pending question before disposing the native session', async () => {
    const { harness, runtime } = await setup()
    await terminalCall('begin', { text: 'Offline question bridge fixture' })
    let questionReached!: () => void
    let requestPayload: unknown
    const reached = new Promise<void>((resolve) => { questionReached = resolve })
    harness.runs.listen((event) => {
      if (event.type !== 'question.requested') return
      requestPayload = event.payload
      questionReached()
    })
    const tool = runtime.session.getToolDefinition('ask_user')!
    const answer = tool.execute('offline-question', { questions: [{
      summary: 'Continue', question: 'Continue?', uiSketch: true,
      options: [{ label: 'Continue', description: 'Go on with the work.', recommended: true, sketch: '+--+\n| Y|\n+--+' }]
    }] }, undefined, undefined, runtime.session.extensionRunner.createToolContext('offline-question', undefined))
    await reached
    expect(requestPayload).toMatchObject({ uiSketch: true, options: [{ sketch: '+--+\n| Y|\n+--+' }] })
    await expect(controlCall<{ requests: unknown[] }>('terminal.pending')).resolves.toMatchObject({ requests: [{ summary: 'Continue', uiSketch: true, options: [{ sketch: '+--+\n| Y|\n+--+' }] }] })
    await runtime.dispose()
    await expect(answer).resolves.toMatchObject({ content: [{ type: 'text' }] })
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: false, dirty: false, active: false })
  })
})
