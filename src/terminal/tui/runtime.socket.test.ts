import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

async function setup(input: Partial<TerminalPrepareInput> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-sdk-socket-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), resolver: async () => [], assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
  const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
  opened.push(entry)
  await harness.ready
  const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
  const launch = await harness.terminals.prepare({ sessionId: 'offline-sdk', cwd, accountId: account.id, sessionFolder: join(root, 'history'), ...input })
  for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
  // Bun consumes its flags and the frontend script before the runtime sees process.argv.
  const runtime = await createTerminalRuntime(launch.args.slice(2), { ui, notify: vi.fn(), changed: vi.fn(), shutdown: vi.fn() })
  entry.runtime = runtime
  return { harness, runtime, ui, account }
}

describe('a native SDK runtime on the actual Harness terminal socket', () => {
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
      if (!context.messages.some(message => message.role === 'toolResult')) return ai.fauxAssistantMessage([ai.fauxToolCall('spawn_subagent', { brief: 'terminal-native-child' })], { stopReason: 'toolUse' })
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

  it('exposes only the active parent run’s flat child activity through the private monitor call', async () => {
    const { harness, runtime } = await setup()
    await terminalCall('begin', { text: 'Observe child work' })
    const parentId = harness.runs.activeForSession('offline-sdk')!.runId
    const { loadRun, saveRun } = await import('../../sessions/runStore')
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

    const child = harness.runs.start('opaque-child', 'observed-child')
    child.emit('tool.started', { toolCallId: 'read-1', name: 'read', summary: 'src/auth.ts', input: '{"token":"hidden"}' })
    const nested = harness.runs.start('opaque-nested', 'observed-nested')
    nested.emit('tool.started', { toolCallId: 'grep-1', name: 'grep', summary: 'token validation' })
    const unrelated = harness.runs.start('other-child', 'unrelated-child')
    unrelated.emit('tool.started', { toolCallId: 'write-1', name: 'write', summary: 'outside parent' })

    const { children } = await controlCall<{ children: Array<{ id: string; goal: string; activity: string }> }>('terminal.subagents.monitor')
    expect(children.map(item => item.id)).toEqual(['observed-child', 'observed-nested'])
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
    await runtime.interrupt()
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

  it('keeps the same account, command control and readiness after new/reload with no provider request', async () => {
    const { harness, runtime, ui } = await setup()
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: true, dirty: false, active: false })
    expect(runtime.session.extensionRunner.getExtensionPaths()).toEqual(['<inline:harness-terminal-bridge>', '<inline:harness-mode-choices>'])
    expect(runtime.services.agentDir).toContain(harness.accounts.dir)
    for (const command of ['accounts', 'plugins', 'hub']) expect(runtime.session.extensionRunner.getCommand(command)).toBeDefined()
    await runtime.session.prompt('/accounts')
    expect(ui.select).toHaveBeenCalled()
    await runtime.newSession()
    await runtime.reload()
    await runtime.session.prompt('/accounts')
    expect(ui.select).toHaveBeenCalledTimes(2)
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: true, dirty: false, active: false })
    await expect(controlCall('terminal.resources')).resolves.toEqual({})
    await expect(socketCall(connectionFromEnv(), 'control.claim')).rejects.toThrow('already claimed')
    const blocked = await runtime.session.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'no-active-run', input: { command: 'echo must-not-execute' } })
    expect(blocked?.block).toBe(true)
    await runtime.dispose()
    expect(harness.terminals.state('offline-sdk').ready).toBe(false)
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

  it('requires choices and a recommendation for the single-question terminal tool', async () => {
    const { runtime } = await setup()
    try {
      const tool = runtime.session.getToolDefinition('ask_user_question')!
      const context = runtime.session.extensionRunner.createToolContext('invalid-question', undefined)
      await expect(tool.execute('invalid-question', { question: 'Choose?', options: [] }, undefined, undefined, context))
        .rejects.toThrow('Every question needs at least one choice.')
      await expect(tool.execute('invalid-question', { question: 'Choose?', options: [{ label: 'A' }] }, undefined, undefined, context))
        .rejects.toThrow('Every question needs at least one recommended choice.')
    } finally {
      await runtime.dispose()
    }
  })

  it('settles an actual socket-backed pending question before disposing the native session', async () => {
    const { harness, runtime } = await setup()
    await terminalCall('begin', { text: 'Offline question bridge fixture' })
    let questionReached!: () => void
    const reached = new Promise<void>((resolve) => { questionReached = resolve })
    harness.runs.listen((event) => { if (event.type === 'question.requested') questionReached() })
    const tool = runtime.session.getToolDefinition('ask_user_question')!
    const answer = tool.execute('offline-question', { question: 'Continue?', options: [{ label: 'Continue', recommended: true }] }, undefined, undefined, runtime.session.extensionRunner.createToolContext('offline-question', undefined))
    await reached
    await expect(controlCall<{ requests: unknown[] }>('terminal.pending')).resolves.toMatchObject({ requests: [expect.anything()] })
    await runtime.dispose()
    await expect(answer).resolves.toMatchObject({ content: [{ type: 'text', text: '{"selected":[]}' }] })
    expect(harness.terminals.state('offline-sdk')).toEqual({ ready: false, dirty: false, active: false })
  })
})
