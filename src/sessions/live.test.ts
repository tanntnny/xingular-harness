// Live sessions (ADR-0083): one Pi session kept open across the runs of a conversation.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { resolveWorkspaceRoot } from '../core/workspace'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from './contracts'
import { piSessionFactory, type PiEvent, type PiSessionLike, type SessionFactory, type SessionFactoryInput, type TurnParams } from './runner'
import { loadRun } from './runStore'
import type { SessionRunInput } from './sessions'

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
/** Waits for a condition, so a slow machine does not fail a test that only waits a fixed time. */
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await tick(10)
}
const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

interface Fake extends PiSessionLike {
  disposed: boolean
  rebinds: SessionFactoryInput[]
  /** Holds the next prompt until `finish` is called. */
  hold: boolean
  finish?: () => void
}

/** A fake Pi session that can be reused, as `piSessionFactory` builds one. */
function reusableFactory(made: Fake[], options: { failPrompt?: () => boolean } = {}): SessionFactory {
  return async () => {
    let listener: (event: PiEvent) => void = () => undefined
    const session: Fake = {
      sessionId: `native-${made.length + 1}`,
      disposed: false,
      rebinds: [],
      hold: false,
      subscribe: (fn) => {
        listener = fn
        return () => { listener = () => undefined }
      },
      prompt: async (text) => {
        if (session.hold) await new Promise<void>((resolve) => { session.finish = resolve })
        if (options.failPrompt?.()) throw new Error('provider down')
        listener({ type: 'message_start', message: { role: 'assistant' } })
        listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] } })
      },
      sendCustomMessage: async () => undefined,
      abort: async () => { session.finish?.() },
      dispose: () => { session.disposed = true },
      rebind: async (input) => { session.rebinds.push(input) }
    }
    made.push(session)
    return session
  }
}

function setup(factory: SessionFactory) {
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'live-data-')), stateDir: mkdtempSync(join(tmpdir(), 'live-state-')), secrets: memorySecretStore(), sessionFactory: factory })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  const sessionDir = join(harness.env.root, 'sessions', 'agent-1')
  const run = (id: string, extra: Partial<SessionRunInput> = {}) =>
    harness.sessions.run({ run: { id, sessionId: 'agent-1' }, cwd: harness.env.root, sessionDir, text: `hello ${id}`, caller: { agentId: 'agent-1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] }, live: true, ...extra })
  return { harness, events, run }
}

describe('live sessions', () => {
  it('serves two runs of a conversation with one Pi session, each run with its own gate and events', async () => {
    const made: Fake[] = []
    const { harness, events, run } = setup(reusableFactory(made))
    const first = await run('r1')
    await tick()
    const second = await run('r2')
    await tick()

    expect(made).toHaveLength(1)
    expect(first.nativeSessionId).toBe('native-1')
    expect(second.nativeSessionId).toBe('native-1')
    expect(made[0].disposed).toBe(false)
    expect(made[0].rebinds).toHaveLength(1)
    expect(made[0].rebinds[0].params.runId).toBe('r2')
    expect(loadRun(harness.env.root, 'r1').status).toBe('completed')
    expect(loadRun(harness.env.root, 'r2').status).toBe('completed')
    const replies = events.filter((event) => event.type === 'message.completed').map((event) => [event.runId, (event.payload as { text: string }).text])
    expect(replies).toEqual([['r1', 'reply to hello r1'], ['r2', 'reply to hello r2']])
    expect(harness.sessions.liveSessions()).toMatchObject([{ sessionId: 'agent-1', nativeSessionId: 'native-1', activeRunId: null, lastRunId: 'r2', runs: 2 }])
  })

  it('opens a new session when a pin changes, and closes the old one at the turn boundary', async () => {
    const made: Fake[] = []
    const { run } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    await run('r2', { model: 'other/model' })
    await tick()
    expect(made).toHaveLength(2)
    expect(made[0].disposed).toBe(true)
    expect(made[1].disposed).toBe(false)
    expect(made[0].rebinds).toHaveLength(0)
  })

  it('disposes the session after the run when the caller does not ask for a live one', async () => {
    const made: Fake[] = []
    const { harness, run } = setup(reusableFactory(made))
    await run('r1', { live: false })
    await tick()
    await run('r2', { live: false })
    await tick()
    expect(made.map((session) => session.disposed)).toEqual([true, true])
    expect(harness.sessions.liveSessions()).toEqual([])
  })

  it('refuses a second run while the live session is replying, and queues a follow-up for after it', async () => {
    const made: Fake[] = []
    const { harness, run, events } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    made[0].hold = true
    await run('r2')
    await tick()
    await expect(run('r3')).rejects.toMatchObject({ code: 'session_busy' })
    expect(await harness.sessions.followUp('agent-1', 'and then this')).toEqual({ queued: 1 })
    made[0].hold = false
    made[0].finish?.()
    const replies = () => events.filter((event) => event.type === 'message.completed').map((event) => (event.payload as { text: string }).text)
    await until(() => replies().length === 3 && harness.sessions.liveSessions()[0]?.activeRunId === null)
    const followed = replies()
    expect(followed).toEqual(['reply to hello r1', 'reply to hello r2', 'reply to and then this'])
    expect(made).toHaveLength(1)
    expect(harness.sessions.liveSessions()[0]).toMatchObject({ runs: 3, followUps: [] })
  })

  it('starts a follow-up at once when the session is idle', async () => {
    const made: Fake[] = []
    const { harness, run } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    const result = await harness.sessions.followUp('agent-1', 'next one')
    expect(result).toHaveProperty('runId')
    await tick()
    expect(loadRun(harness.env.root, (result as { runId: string }).runId)).toMatchObject({ status: 'completed', goal: 'next one' })
  })

  it('parks a follow-up when the reply fails, and sends it after the next reply completes', async () => {
    const made: Fake[] = []
    let fail = true
    const { harness, run, events } = setup(reusableFactory(made, { failPrompt: () => fail }))
    await run('r1', { text: 'warm up' })
    await tick()
    made[0].hold = true
    fail = true
    await run('r2')
    await tick()
    await harness.sessions.followUp('agent-1', 'parked')
    made[0].hold = false
    made[0].finish?.()
    await until(() => loadRun(harness.env.root, 'r2').status === 'failed' && harness.sessions.liveSessions()[0]?.activeRunId === null)
    expect(loadRun(harness.env.root, 'r2').status).toBe('failed')
    expect(harness.sessions.liveSessions()[0].followUps).toEqual(['parked'])
    fail = false
    await run('r3')
    await until(() => events.filter((event) => event.type === 'message.completed').length === 2)
    expect(events.filter((event) => event.type === 'message.completed').map((event) => (event.payload as { text: string }).text)).toEqual(['reply to hello r3', 'reply to parked'])
  })

  it('closes an idle session on request and every session when the harness closes', async () => {
    const made: Fake[] = []
    const { harness, run } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    expect(harness.sessions.closeLive('agent-1')).toEqual({ closed: true, afterRun: null })
    expect(made[0].disposed).toBe(true)
    await run('r2')
    await tick()
    expect(made).toHaveLength(2)
    await harness.close()
    open.splice(open.indexOf(harness), 1)
    expect(made[1].disposed).toBe(true)
  })

  it('yields to a run that opens its own session on the same history, and refuses one while replying', async () => {
    const made: Fake[] = []
    const { harness, run } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    made[0].hold = true
    await run('r2')
    await tick()
    await expect(run('r3', { live: false })).rejects.toMatchObject({ code: 'session_busy' })
    made[0].hold = false
    made[0].finish?.()
    await tick()
    await run('r4', { live: false })
    await tick()
    expect(made[0].disposed).toBe(true)
    expect(harness.sessions.liveSessions()).toEqual([])
  })

  it('closes an idle live session before a saved-history edit through the server', async () => {
    const made: Fake[] = []
    const { harness, run } = setup(reusableFactory(made))
    await run('r1')
    await tick()
    const sessionDir = join(harness.env.root, 'sessions', 'agent-1')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'history.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'native-1', timestamp: new Date().toISOString(), cwd: harness.env.root })}\n`)
    const { methods } = await import('../server/methods')
    const table = methods(harness) as Record<string, (params: Record<string, unknown>) => unknown>
    await table['sessions.rename']({ sessionDir, name: 'Renamed' })
    expect(made[0].disposed).toBe(true)
    expect(harness.sessions.liveSessions()).toEqual([])
  })

  it('is only for a person\'s attended top-level runs', async () => {
    const { run } = setup(reusableFactory([]))
    await expect(run('r1', { automatic: true })).rejects.toThrow(/attended top-level/)
    await expect(run('r2', { run: { id: 'r2', sessionId: 'agent-1', trigger: 'probe' } })).rejects.toThrow(/attended top-level/)
  })
})

it('rebinds a real Pi session: the next run\'s extension and tools replace the last run\'s', async () => {
  const base = mkdtempSync(join(tmpdir(), 'live-pi-'))
  const harness = createHarness({ dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const account = harness.accounts.context(harness.accounts.resolve(null, null))
  const seen: string[] = []
  const runExtension = (label: string) => ({
    name: 'run-scoped',
    factory: (pi: ExtensionAPI) => {
      pi.on('input', () => {
        seen.push(label)
        return { action: 'handled' as const }
      })
    }
  })
  const tool = (label: string) => ({
    name: 'probe_tool',
    label: 'Probe',
    description: 'Says which run it belongs to.',
    parameters: (Type: typeof import('typebox').Type) => Type.Object({}),
    execute: async () => label
  })
  const params = (runId: string, label: string): TurnParams => ({
    runId,
    cwd: base,
    workspaceRoot: resolveWorkspaceRoot(base),
    sessionDir: join(base, 'sessions'),
    historyFile: null,
    model: null,
    text: '',
    account,
    system: '',
    update: null,
    inline: [runExtension(label)]
  })
  const input = (runId: string, label: string): SessionFactoryInput => ({
    params: params(runId, label),
    allow: ['read', 'probe_tool'],
    gate: { check: async () => null },
    tools: [tool(label) as never],
    runtime: () => harness.accounts.runtime(account)
  })
  const session = await piSessionFactory(input('r1', 'first'))
  try {
    expect(session.rebind).toBeTypeOf('function')
    await session.prompt('one')
    await session.rebind!(input('r2', 'second'))
    await session.prompt('two')
    expect(seen).toEqual(['first', 'second'])
    const definition = (session as unknown as { getToolDefinition(name: string): { execute(id: string, input: unknown): Promise<{ content: Array<{ text: string }> }> } }).getToolDefinition('probe_tool')
    expect((await definition.execute('call-1', {})).content[0].text).toBe('second')
    await expect(session.rebind!({ ...input('r3', 'third'), params: { ...params('r3', 'third'), inline: [] } })).rejects.toMatchObject({ code: 'session_pin_mismatch' })
  } finally {
    session.dispose()
  }
})
