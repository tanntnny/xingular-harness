// The terminal frontend as a client of the harness (ADR-0083, phase 2), over the real session
// socket: the parent runs every turn on a live Pi session with a scripted model, and the client's
// mirror draws it. Nothing here makes a provider request.
import { SessionManager, type AgentSessionEvent, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHarness, type Harness } from '../../harness'
import { memorySecretStore } from '../../accounts/secrets'
import { fauxModel, type Faux } from '../../../tests/faux'
import type { TerminalRuntime } from './runtime'
import { createHarnessTerminalRuntime } from './harnessRuntime'
import { loadRun } from '../../sessions/runStore'

const loadRunStatus = (harness: Harness, runId: string): string => loadRun(harness.env.root, runId).status

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

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function connect(harness: Harness, input: Parameters<Harness['terminals']['prepare']>[0], cwd: string, faux: Faux): Promise<{ runtime: TerminalRuntime; events: AgentSessionEvent[] }> {
  const launch = await harness.terminals.prepare(input)
  for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
  const runtime = await createHarnessTerminalRuntime(launch.args.slice(2), { ui, notify: vi.fn(), changed: vi.fn(), shutdown: vi.fn() })
  const [provider, id] = faux.model.split('/')
  await runtime.session.setModel({ provider, id, name: id, reasoning: false, contextWindow: 100_000, input: ['text'] } as never)
  const events: AgentSessionEvent[] = []
  runtime.subscribe((event) => void events.push(event))
  return { runtime, events }
}

async function setup(): Promise<{ harness: Harness; runtime: TerminalRuntime; faux: Faux; events: AgentSessionEvent[]; account: { id: string } }> {
  const root = mkdtempSync(join(tmpdir(), 'harness-client-socket-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
  const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
  opened.push(entry)
  await harness.ready
  const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
  const faux = await fauxModel(harness)
  const launch = await harness.terminals.prepare({ sessionId: 'client-sdk', cwd, accountId: account.id, sessionFolder: join(root, 'history'), subagents: null })
  for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
  const runtime = await createHarnessTerminalRuntime(launch.args.slice(2), { ui, notify: vi.fn(), changed: vi.fn(), shutdown: vi.fn() })
  entry.runtime = runtime
  // The client sends the model's reference; the parent's account runtime answers with the scripted model.
  const [provider, id] = faux.model.split('/')
  await runtime.session.setModel({ provider, id, name: id, reasoning: false, contextWindow: 100_000, input: ['text'] } as never)
  const events: AgentSessionEvent[] = []
  runtime.subscribe((event) => void events.push(event))
  return { harness, runtime, faux, events, account }
}

describe('the terminal frontend as a client of the harness', () => {
  it('sends turns to a live harness session and mirrors its transcript, one native session for both turns', async () => {
    const { harness, runtime, faux, events } = await setup()
    faux.script([faux.says('first answer'), faux.says('second answer')])
    expect(runtime.session.sessionFile).toBeUndefined()
    await runtime.submit('one')
    await until(() => events.some((event) => event.type === 'agent_settled'), 'the first reply')
    await until(() => runtime.session.isIdle && runtime.session.sessionFile !== undefined, 'idle, with its new history file')
    expect(runtime.session.sessionFile).toMatch(/\.jsonl$/)
    const firstNative = runtime.session.sessionId
    await runtime.submit('two')
    await until(() => events.filter((event) => event.type === 'agent_settled').length === 2, 'the second reply')
    await until(() => runtime.session.isIdle, 'idle again')
    const texts = runtime.session.messages.map((message) => {
      const content = (message as { content?: unknown }).content
      return `${message.role}:${typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''}`
    })
    expect(texts).toEqual(expect.arrayContaining(['user:one', 'assistant:first answer', 'user:two', 'assistant:second answer']))
    expect(runtime.session.sessionId).toBe(firstNative)
    expect(harness.sessions.liveSessions()).toMatchObject([{ sessionId: 'client-sdk', runs: 2 }])
    expect(runtime.snapshot()).toMatchObject({ idle: true, hasUserMessages: true })
    expect(runtime.session.getLastAssistantText()).toBe('second answer')
    // Side questions and /context read the live session's own instructions.
    expect(runtime.session.systemPrompt.length).toBeGreaterThan(100)
    // Terminal features find this conversation's runs by the live session's native id.
    const { controlCall } = await import('../control')
    const todo = await controlCall('terminal.todo')
    expect(todo).toBeDefined()
    const runs = await controlCall<{ runs: Array<{ id?: string; runId?: string }> }>('terminal.trajectory.list')
    expect(runs.runs.length).toBe(2)
    // The same tools the in-process terminal has: Pi's four, the harness's own, and the world's.
    const { readFileSync } = await import('node:fs')
    const runId = harness.sessions.liveSessions()[0].lastRunId
    const tools = (JSON.parse(readFileSync(join(harness.env.root, 'runs', runId, 'capabilities.json'), 'utf8')) as { tools: string[] }).tools
    expect(tools).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'todo_write', 'web_fetch', 'web_search']))
    expect(tools).not.toEqual(expect.arrayContaining(['grep']))
  })

  it('runs a plan request and Implement at the same model and effort, and saves them', async () => {
    const { harness, runtime, faux, account } = await setup()
    const [provider, id] = faux.model.split('/')
    await runtime.session.setModel({ provider, id, name: id, reasoning: true, contextWindow: 100_000, input: ['text'] } as never)
    runtime.session.setThinkingLevel('high')
    const seen: Array<{ model: string | undefined; effort: string }> = []
    const capture = (text: string) => () => {
      seen.push({ model: runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : undefined, effort: runtime.session.thinkingLevel })
      return faux.says(text)
    }
    faux.script([capture('planned'), capture('implemented')])
    await runtime.submitPlan('plan it')
    await runtime.submit('Implement the plan: Plan')
    await until(() => runtime.session.isIdle, 'the implement reply')
    expect(seen).toEqual([
      { model: faux.model, effort: 'high' },
      { model: faux.model, effort: 'high' }
    ])
    expect(harness.accounts.selection(account.id)).toMatchObject({ model: faux.model, effort: 'high' })
  })

  it('answers a plan question through the terminal decision routes', async () => {
    const { runtime, faux, events } = await setup()
    const question = { summary: 'Database', question: 'Which database?', options: [{ label: 'Postgres', description: 'Relational.', recommended: true }, { label: 'SQLite', description: 'One file.' }] }
    faux.script([faux.calls(['ask_user', { questions: [question] } as never]), faux.says('No plan needed.')])
    const planned = runtime.submitPlan('plan it')
    let pending: Awaited<ReturnType<TerminalRuntime['pending']>> = []
    await until(async () => (pending = await runtime.pending()).length > 0, 'the question')
    expect(pending[0]).toMatchObject({ type: 'question', question: 'Which database?' })
    const batch = (pending[0] as { batchId?: string }).batchId
    if (batch) await runtime.answerBatch(batch, [{ questionId: pending[0].requestId, answer: { selected: ['Postgres'] } as never }])
    else await runtime.answer(pending[0].requestId, { selected: ['Postgres'] } as never)
    await planned
    await until(() => events.some((event) => event.type === 'agent_settled'), 'the plan reply')
    expect(faux.lastToolResults().join(' ')).toContain('Postgres')
    expect(await runtime.pending()).toEqual([])
  })

  it('keeps a reply running when its window closes, and reattaches a new window to it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-client-detach-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
    const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
    opened.push(entry)
    await harness.ready
    const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
    const faux = await fauxModel(harness)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    faux.script([async () => { await held; return faux.says('finished while away') }])
    const input = { sessionId: 'client-detach', cwd, accountId: account.id, sessionFolder: join(root, 'history'), subagents: null }
    const first = await connect(harness, input, cwd, faux)
    await first.runtime.submit('long job')
    await until(() => harness.sessions.liveSessions()[0]?.activeRunId != null, 'the reply to start')
    const runId = harness.sessions.liveSessions()[0].activeRunId!

    // The window closes: the frontend goes, the reply stays.
    await first.runtime.dispose()
    expect(await harness.terminals.detach('client-detach')).toEqual({ detached: true, activeRunId: runId })
    expect(harness.terminals.detached()).toMatchObject([{ sessionId: 'client-detach', activeRunId: runId }])

    // A new window reattaches and sees the reply running, then finished.
    const second = await connect(harness, { ...input, attach: true }, cwd, faux)
    entry.runtime = second.runtime
    expect(harness.terminals.detached()).toEqual([])
    expect(second.runtime.session.isStreaming).toBe(true)
    release()
    await until(() => second.events.some((event) => event.type === 'agent_settled'), 'the reply to settle')
    await until(() => second.runtime.session.getLastAssistantText() === 'finished while away', 'the reply in the new window')
    expect(loadRunStatus(harness, runId)).toBe('completed')
  })

  it('ends a detached reply\'s session once the reply settles', async () => {
    const { harness, runtime, faux } = await setup()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    faux.script([async () => { await held; return faux.says('done') }])
    await runtime.submit('long job')
    await until(() => harness.sessions.liveSessions()[0]?.activeRunId != null, 'the reply to start')
    await runtime.dispose()
    expect((await harness.terminals.detach('client-sdk')).detached).toBe(true)
    release()
    await until(() => harness.terminals.detached().length === 0, 'the detached session to end')
    await until(() => harness.sessions.liveSessions().length === 0, 'the live session to close')
  })

  it('lists a trusted plugin\'s commands before the first turn, runs one, and shows what it reports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-client-plugin-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
    const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
    opened.push(entry)
    await harness.ready
    const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
    const { writeFileSync } = await import('node:fs')
    const extensions = join(harness.accounts.context(account).configDir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeFileSync(join(extensions, 'kit.js'), `export default function (pi) {
      pi.registerCommand('hello', { description: 'Says hello', handler: async (args, ctx) => {
        ctx.ui.setStatus('kit', 'KIT_STATUS')
        ctx.ui.notify('HELLO_NOTICE ' + args, 'info')
      } })
    }`)
    const faux = await fauxModel(harness)
    const launch = await harness.terminals.prepare({ sessionId: 'client-plugin', cwd, accountId: account.id, sessionFolder: join(root, 'history'), subagents: null })
    for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    const notify = vi.fn()
    const setStatus = vi.fn()
    const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify, setStatus, setWidget: vi.fn(), setTitle: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
    const runtime = await createHarnessTerminalRuntime(launch.args.slice(2), { ui, notify: vi.fn(), changed: vi.fn(), shutdown: vi.fn() })
    entry.runtime = runtime
    const [provider, id] = faux.model.split('/')
    await runtime.session.setModel({ provider, id, name: id, reasoning: false, contextWindow: 100_000, input: ['text'] } as never)
    expect(runtime.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain('hello')
    const command = runtime.session.extensionRunner.getCommand('hello')!
    await command.handler('there', {} as never)
    await until(() => notify.mock.calls.some(([text]) => String(text).includes('HELLO_NOTICE there')), 'the plugin notice')
    expect(setStatus).toHaveBeenCalledWith('kit', 'KIT_STATUS')
  })

  it('shows a plugin\'s input dialog with the window\'s own dialog and returns the answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-client-dialog-'))
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
    const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
    opened.push(entry)
    await harness.ready
    const account = harness.accounts.create('Offline test', 'apiKey').accounts[0]
    const { writeFileSync } = await import('node:fs')
    const extensions = join(harness.accounts.context(account).configDir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeFileSync(join(extensions, 'ask.js'), `export default function (pi) {
      pi.registerCommand('ask', { description: 'Asks for text', handler: async (_args, ctx) => {
        const value = await ctx.ui.input('Paste a value', 'the value')
        ctx.ui.notify('RESULT ' + value, 'info')
      } })
    }`)
    await fauxModel(harness)
    const launch = await harness.terminals.prepare({ sessionId: 'client-dialog', cwd, accountId: account.id, sessionFolder: join(root, 'history'), subagents: null })
    for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    const notify = vi.fn()
    const input = vi.fn(async () => 'PASTED')
    const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), input, notify, setStatus: vi.fn(), setWidget: vi.fn(), setTitle: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
    const runtime = await createHarnessTerminalRuntime(launch.args.slice(2), { ui, notify: vi.fn(), changed: vi.fn(), shutdown: vi.fn() })
    entry.runtime = runtime
    const { controlCall } = await import('../control')
    await runtime.session.extensionRunner.getCommand('ask')!.handler('', {} as never)
    await until(() => input.mock.calls.length > 0, 'the input dialog')
    expect(input.mock.calls[0].slice(0, 2)).toEqual(['Paste a value', 'the value'])
    await until(() => notify.mock.calls.some(([text]) => text === 'RESULT PASTED'), 'the plugin to receive the answer')
    // The window's own dock never showed it as a card.
    expect((await controlCall<{ requests: unknown[] }>('terminal.pending', { ownDialogs: true })).requests).toEqual([])
  })

  it('runs a /goal in the harness and shows the goal state the harness recorded', async () => {
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'off')
    const { harness, runtime, faux, events } = await setup()
    faux.script([faux.calls(['update_goal', { status: 'complete' }]), faux.says('The goal is met.')])
    const { GOAL_CUSTOM_TYPE } = await import('../../sessions/goal')
    runtime.goal.set('Make the build green', { rounds: 3 })
    await runtime.session.sendCustomMessage({ customType: GOAL_CUSTOM_TYPE, content: 'start', display: false } as never, { triggerTurn: true } as never)
    await until(() => events.some((event) => event.type === 'agent_settled') && runtime.session.isIdle, 'the goal run to settle')
    await until(() => runtime.goal.get()?.status === 'complete', 'the goal state from the harness')
    const runId = harness.sessions.liveSessions()[0].lastRunId
    expect(loadRun(harness.env.root, runId).goalMode).toMatchObject({ objective: 'Make the build green', status: 'complete', limits: { rounds: 3 } })
  })

  it('starts a new conversation when /new comes as soon as the run record settles', async () => {
    const { harness, runtime, faux } = await setup()
    faux.script([faux.says('a'), faux.says('b')])
    await runtime.submit('first conversation')
    await until(() => {
      const runId = harness.sessions.liveSessions()[0]?.lastRunId
      return !!runId && loadRunStatus(harness, runId) === 'completed'
    }, 'the first run record')
    const first = harness.sessions.liveSessions()[0].nativeSessionId
    await runtime.newSession()
    await runtime.submit('second conversation')
    await until(() => harness.sessions.liveSessions()[0]?.nativeSessionId !== undefined && harness.sessions.liveSessions()[0]?.nativeSessionId !== first && harness.sessions.liveSessions()[0]?.activeRunId === null, 'the second conversation')
    expect(harness.sessions.liveSessions()[0].nativeSessionId).not.toBe(first)
  })

  it('runs a person\'s ! command on a resumed conversation and records it in the history', async () => {
    const { runtime, faux, events } = await setup()
    faux.script([faux.says('first'), faux.says('It printed the marker.')])
    await runtime.submit('first turn')
    await until(() => runtime.session.isIdle && runtime.session.sessionFile !== undefined, 'the first reply')
    await runtime.submit('!printf USER_BASH_MARKER')
    await until(() => events.filter((event) => event.type === 'agent_settled').length === 2 && runtime.session.isIdle, 'the bash turn')
    const { readFileSync } = await import('node:fs')
    const history = readFileSync(runtime.session.sessionFile!, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { message?: { role?: string; command?: string; output?: string } })
    expect(history.some((entry) => entry.message?.role === 'bashExecution' && entry.message.command === 'printf USER_BASH_MARKER' && String(entry.message.output).includes('USER_BASH_MARKER'))).toBe(true)
  })

  it('starts a new conversation on a new history file', async () => {
    const { runtime, faux, events } = await setup()
    faux.script([faux.says('a'), faux.says('b')])
    await runtime.submit('first conversation')
    await until(() => events.some((event) => event.type === 'agent_settled') && runtime.session.isIdle, 'the first reply')
    const first = runtime.session.sessionFile
    await runtime.newSession()
    expect(runtime.session.messages).toEqual([])
    await runtime.submit('second conversation')
    await until(() => events.filter((event) => event.type === 'agent_settled').length === 2 && runtime.session.isIdle, 'the second reply')
    expect(runtime.session.sessionFile).toMatch(/\.jsonl$/)
    expect(runtime.session.sessionFile).not.toBe(first)
    // Back to the first conversation by the session id its runs record.
    const { readFileSync } = await import('node:fs')
    const firstId = (JSON.parse(readFileSync(first!, 'utf8').split('\n', 1)[0]) as { id: string }).id
    await runtime.switchSession(firstId)
    const { realpathSync } = await import('node:fs')
    expect(realpathSync(runtime.session.sessionFile!)).toBe(realpathSync(first!))
  })
})

/** Opens the client terminal on an account whose catalogue offers `acme/alpha` and `acme/beta`, with its saved selection. */
async function openOnCatalogue(options: { selection?: { model?: string; effort?: string }; recorded?: string; recordedEffort?: string } = {}): Promise<{ harness: Harness; runtime: TerminalRuntime; account: { id: string }; notify: ReturnType<typeof vi.fn> }> {
  const root = mkdtempSync(join(tmpdir(), 'harness-client-modes-'))
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const harness = createHarness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), assets: { node: process.execPath, cli: join(root, 'cli.js'), piExtension: join(root, 'terminal-pi.js'), openTui: join(root, 'terminal-opentui.js') } })
  const entry: { harness: Harness; runtime?: TerminalRuntime; root: string } = { harness, root }
  opened.push(entry)
  await harness.ready
  const account = harness.accounts.create('Modes', 'apiKey').accounts[0]
  if (options.selection) harness.accounts.select(account.id, options.selection as never)
  const launch = await harness.terminals.prepare({ sessionId: 'client-modes', cwd, accountId: account.id, sessionFolder: join(root, 'history'), subagents: null })
  for (const [name, value] of Object.entries(launch.env)) vi.stubEnv(name, value === null ? undefined : value)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const agentDir = process.env.PI_CODING_AGENT_DIR!
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { acme: {
    baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-key',
    // `beta` maps the two top levels; `alpha` stops at high.
    models: ['alpha', 'beta'].map((id) => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(id === 'beta' ? { thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } } : {}) }))
  } } }))
  const args = launch.args.slice(2)
  if (options.recorded) {
    // A conversation another account wrote: its history names `options.recorded`.
    const history = args[args.indexOf('--session-dir') + 1]
    const manager = SessionManager.create(cwd, history)
    const [provider, modelId] = options.recorded.split('/')
    manager.appendModelChange(provider, modelId)
    if (options.recordedEffort) manager.appendThinkingLevelChange(options.recordedEffort)
    manager.appendMessage({ role: 'user', content: 'earlier', timestamp: Date.now() } as never)
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], provider, model: modelId, api: 'openai-completions', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } as never)
    const file = manager.getSessionFile()!
    writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map((item) => JSON.stringify(item)).join('\n') + '\n')
    args.push('--session', file)
  }
  const notify = vi.fn()
  const ui = { select: vi.fn(async () => undefined), confirm: vi.fn(async () => false), notify: vi.fn(), getEditorText: () => '' } as unknown as ExtensionUIContext
  const runtime = await createHarnessTerminalRuntime(args, { ui, notify, changed: vi.fn(), shutdown: vi.fn() })
  entry.runtime = runtime
  return { harness, runtime, account, notify }
}

const modelOf = (runtime: TerminalRuntime): string | undefined => runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : undefined

describe('the client terminal after an account switch', () => {
  it("starts on the account's own selection when the conversation names a model it cannot use", async () => {
    const { runtime, notify } = await openOnCatalogue({ recorded: 'gone/old-model', selection: { model: 'acme/alpha', effort: 'low' } })
    expect(modelOf(runtime)).toBe('acme/alpha')
    expect(runtime.session.thinkingLevel).toBe('low')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('cannot use gone/old-model. Started on acme/alpha at low effort'))
  })

  it('names no model, rather than the old account\'s, when nothing on the new account is usable', async () => {
    const { runtime } = await openOnCatalogue({ recorded: 'gone/old-model' })
    expect(modelOf(runtime)).toBeUndefined()
  })

  it('keeps the conversation\'s own model and effort when the account can use them', async () => {
    const { runtime, notify } = await openOnCatalogue({ recorded: 'acme/beta', recordedEffort: 'high', selection: { model: 'acme/alpha', effort: 'low' } })
    expect(modelOf(runtime)).toBe('acme/beta')
    expect(runtime.session.thinkingLevel).toBe('high')
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('the client terminal keeps one model and effort across modes', () => {
  it('keeps the selected model and effort across a new conversation', async () => {
    const { harness, runtime, account } = await openOnCatalogue({ selection: { model: 'acme/alpha', effort: 'low' } })
    expect(modelOf(runtime)).toBe('acme/alpha')
    expect(runtime.session.thinkingLevel).toBe('low')
    harness.accounts.select(account.id, { model: 'acme/beta', effort: 'high' })
    await runtime.newSession()
    expect(modelOf(runtime)).toBe('acme/beta')
    expect(runtime.session.thinkingLevel).toBe('high')
  })

  it('changes and saves the model through cycleModel', async () => {
    const { harness, runtime, account } = await openOnCatalogue({ selection: { model: 'acme/alpha', effort: 'low' } })
    const next = await runtime.session.cycleModel('forward')
    expect(next?.model?.provider).toBe('acme')
    expect(modelOf(runtime)).not.toBe('acme/alpha')
    expect(harness.accounts.selection(account.id)?.model).toBe(modelOf(runtime))
  })

  it('offers the levels the model supports, up to max where it maps them, and clamps what it does not', async () => {
    const { runtime } = await openOnCatalogue({ selection: { model: 'acme/alpha', effort: 'low' } })
    expect(runtime.session.getAvailableThinkingLevels()).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    runtime.session.setThinkingLevel('max' as never)
    expect(runtime.session.thinkingLevel).toBe('high')
    await runtime.session.setModel({ provider: 'acme', id: 'beta', name: 'beta', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, contextWindow: 32768, input: ['text'] } as never)
    expect(runtime.session.getAvailableThinkingLevels()).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    runtime.session.setThinkingLevel('max' as never)
    expect(runtime.session.thinkingLevel).toBe('max')
  })
})
