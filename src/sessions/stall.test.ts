// The stall guard and the heartbeat of every harness run (INV-RUN-14): a reply that produced nothing
// for too long is ended with the reason `stalled`, and a live session that stalled is not reused.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from './contracts'
import type { PiEvent, PiSessionLike, SessionFactory } from './runner'
import { loadRun } from './runStore'
import type { SessionRunInput } from './sessions'
import { REPLY_STALL_MS, STALL_CHECK_MS, TOOL_STALL_MS } from './stallWatch'

const open: Harness[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(async () => {
  vi.useRealTimers()
  for (const harness of open.splice(0)) await harness.close()
})

interface Hung extends PiSessionLike {
  disposed: boolean
  aborts: number
  emit: (event: PiEvent) => void
}

/** A Pi session whose prompt never answers by itself: it returns when aborted, or never when `stubborn`. */
function hungFactory(made: Hung[], options: { stubborn?: boolean } = {}): SessionFactory {
  return async () => {
    let listener: (event: PiEvent) => void = () => undefined
    let release: () => void = () => undefined
    const session: Hung = {
      sessionId: `native-${made.length + 1}`,
      disposed: false,
      aborts: 0,
      emit: (event) => listener(event),
      subscribe: (fn) => {
        listener = fn
        return () => { listener = () => undefined }
      },
      prompt: () => new Promise<void>((resolve) => { release = resolve }),
      sendCustomMessage: async () => undefined,
      abort: async () => {
        session.aborts += 1
        if (!options.stubborn) release()
      },
      dispose: () => { session.disposed = true },
      rebind: async () => undefined
    }
    made.push(session)
    return session
  }
}

function setup(factory: SessionFactory) {
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'stall-data-')), stateDir: mkdtempSync(join(tmpdir(), 'stall-state-')), secrets: memorySecretStore(), sessionFactory: factory })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  const sessionDir = join(harness.env.root, 'sessions', 'agent-1')
  const run = (id: string, extra: Partial<SessionRunInput> = {}) =>
    harness.sessions.run({ run: { id, sessionId: 'agent-1' }, cwd: harness.env.root, sessionDir, text: `hello ${id}`, caller: { agentId: 'agent-1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] }, live: true, ...extra })
  const record = (id: string) => loadRun(harness.env.root, id)
  return { harness, events, run, record }
}

const toolStart = (name: string): PiEvent => ({ type: 'tool_execution_start', toolCallId: `${name}-1`, toolName: name, args: {} }) as PiEvent
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('the stall guard of a harness run', () => {
  it('ends a reply that produced nothing for the whole window, and closes its live session', async () => {
    const made: Hung[] = []
    const { harness, run, record } = setup(hungFactory(made))
    await run('r1')

    await advance(REPLY_STALL_MS - STALL_CHECK_MS)
    expect(record('r1').status).toBe('running')

    await advance(2 * STALL_CHECK_MS)
    expect(record('r1')).toMatchObject({ status: 'interrupted', terminalReason: 'stalled', terminalCode: 'stalled' })
    expect(made[0].aborts).toBe(1)
    expect(made[0].disposed).toBe(true)
    expect(harness.sessions.liveSessions()).toEqual([])
  })

  it('gives a running tool the longer window', async () => {
    const made: Hung[] = []
    const { run, record } = setup(hungFactory(made))
    await run('r1')
    made[0].emit(toolStart('bash'))

    await advance(REPLY_STALL_MS + 2 * STALL_CHECK_MS)
    expect(record('r1').status).toBe('running')
    await advance(TOOL_STALL_MS - REPLY_STALL_MS)
    expect(record('r1')).toMatchObject({ status: 'interrupted', terminalCode: 'stalled' })
  })

  it('does not cut short a reply that only waits for its subagents', async () => {
    const made: Hung[] = []
    const { run, record } = setup(hungFactory(made))
    await run('r1')
    made[0].emit(toolStart('wait_subagents'))

    await advance(TOOL_STALL_MS * 2)
    expect(record('r1').status).toBe('running')
    expect(made[0].aborts).toBe(0)
  })

  it('counts any session event as progress', async () => {
    const made: Hung[] = []
    const { run, record } = setup(hungFactory(made))
    await run('r1')

    await advance(REPLY_STALL_MS - 2 * STALL_CHECK_MS)
    made[0].emit({ type: 'turn_start' } as PiEvent)
    await advance(REPLY_STALL_MS - 2 * STALL_CHECK_MS)
    expect(record('r1').status).toBe('running')
  })

  it('disposes the session of a run that is not live', async () => {
    const made: Hung[] = []
    const { run, record } = setup(hungFactory(made))
    await run('r1', { live: false })

    await advance(REPLY_STALL_MS + 2 * STALL_CHECK_MS)
    expect(record('r1')).toMatchObject({ status: 'interrupted', terminalCode: 'stalled' })
    expect(made[0].disposed).toBe(true)
  })

  it('closes the live session under a turn that does not unwind after its abort', async () => {
    const made: Hung[] = []
    const { harness, run, record } = setup(hungFactory(made, { stubborn: true }))
    await run('r1')

    await advance(REPLY_STALL_MS + 5_000)
    expect(record('r1').terminalCode).toBe('stalled')
    expect(made[0].disposed).toBe(false)
    expect(harness.sessions.liveSessions()[0]?.activeRunId).toBe('r1')

    await advance(31_000)
    expect(made[0].disposed).toBe(true)
    expect(harness.sessions.liveSessions()).toEqual([])
  })

  it('opens a new session for the next run after a stall', async () => {
    const made: Hung[] = []
    const { run, record } = setup(hungFactory(made))
    await run('r1')
    await advance(REPLY_STALL_MS + 2 * STALL_CHECK_MS)
    expect(record('r1').terminalCode).toBe('stalled')

    const second = await run('r2')
    expect(made).toHaveLength(2)
    expect(second.nativeSessionId).toBe('native-2')
  })
})

describe('the heartbeat of a harness run', () => {
  it('is emitted for a run with no work slice', async () => {
    const made: Hung[] = []
    const { run, events } = setup(hungFactory(made))
    await run('r1', { live: false })
    made[0].emit(toolStart('bash'))

    await advance(30_000 + 10)
    const beats = events.filter((event) => event.runId === 'r1' && event.type === 'heartbeat')
    expect(beats).toHaveLength(1)
    expect(beats[0].payload).toMatchObject({ steps: 0, slice: 1, activeTools: ['bash'] })
  })
})
