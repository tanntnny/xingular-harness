// The terminal as a client of the harness (ADR-0083, phase 2), on a real Pi session with a scripted
// model: nothing here makes a provider request.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { fauxModel } from '../../tests/faux'
import { loadRun } from '../sessions/runStore'
import { LiveTerminal } from './liveTerminal'

const open: Harness[] = []
const clients: LiveTerminal[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  for (const harness of open.splice(0)) await harness.close()
})

async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'live-terminal-'))
  const harness = createHarness({ dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const account = harness.accounts.resolve(null, null)
  const faux = await fauxModel(harness)
  const allowed: string[] = []
  const client = new LiveTerminal({
    sessionId: 'terminal-1',
    root: harness.env.root,
    accountId: account.id,
    cwd: base,
    sessionDir: join(base, 'history'),
    caller: { sessionId: 'terminal-1', actor: 'Code', surface: 'cli' },
    variant: null,
    launch: { standard: { cwd: base } },
    connections: false,
    readOnly: false,
    subagents: null,
    allowTool: (target) => void allowed.push(target)
  }, harness.sessions, harness.runs)
  clients.push(client)
  const settled = async (runId: string) => {
    for (let i = 0; i < 200; i++) {
      const status = loadRun(harness.env.root, runId).status
      if (['completed', 'failed', 'interrupted'].includes(status)) return status
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${runId} did not settle`)
  }
  return { harness, client, faux, settled, allowed }
}

it('runs terminal turns on one live Pi session and streams its native events', async () => {
  const { client, faux, settled } = await setup()
  faux.script([faux.says('first answer'), faux.says('second answer')])
  const first = await client.call('terminal.live.run', { text: 'one', model: faux.model, newHistory: true }) as { runId: string; nativeSessionId: string }
  expect(await settled(first.runId)).toBe('completed')
  const state = await client.call('terminal.live.state', {}) as { live: { sessionFile: string; nativeSessionId: string }; session: { model: { id: string } } }
  expect(state.session.model.id).toBeTruthy()
  const second = await client.call('terminal.live.run', { text: 'two', model: faux.model, resume: { sessionFile: state.live.sessionFile, nativeSessionId: state.live.nativeSessionId } }) as { runId: string; nativeSessionId: string }
  expect(await settled(second.runId)).toBe('completed')
  expect(second.nativeSessionId).toBe(first.nativeSessionId)
  expect((await client.call('terminal.live.state', {}) as { live: { runs: number } }).live.runs).toBe(2)

  const read = await client.call('terminal.live.events', { after: 0, wait: false }) as { events: Array<{ seq: number; event: { type: string; message?: { role: string; content: Array<{ text?: string }> } } }> }
  const types = read.events.map((entry) => entry.event.type)
  expect(types).toEqual(expect.arrayContaining(['agent_start', 'message_start', 'message_end', 'agent_settled']))
  const replies = read.events.filter((entry) => entry.event.type === 'message_end' && entry.event.message?.role === 'assistant')
    .map((entry) => entry.event.message!.content.map((part) => part.text ?? '').join(''))
  expect(replies).toEqual(['first answer', 'second answer'])
  const later = await client.call('terminal.live.events', { after: read.events.at(-1)!.seq, wait: false }) as { events: unknown[] }
  expect(later.events).toEqual([])
})

it('asks a plan question through the terminal decision routes and continues with the answer', async () => {
  const { client, faux, settled } = await setup()
  const question = { summary: 'Database', question: 'Which database?', options: [{ label: 'Postgres', description: 'Relational.', recommended: true }, { label: 'SQLite', description: 'One file.' }] }
  faux.script([
    faux.calls(['ask_user', { questions: [question] } as never]),
    faux.says('Planned with the chosen database.')
  ])
  const run = await client.call('terminal.live.run', { text: 'plan it', model: faux.model, newHistory: true, plan: true }) as { runId: string }
  let pending: Array<{ type: string; requestId: string; question?: string; batchId?: string }> = []
  for (let i = 0; i < 300 && !pending.length; i++) {
    pending = (await client.call('terminal.live.pending', {}) as { requests: typeof pending }).requests
    if (!pending.length) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ type: 'question', question: 'Which database?' })
  if (pending[0].batchId) await client.call('terminal.live.answers', { batchId: pending[0].batchId, answers: [{ questionId: pending[0].requestId, answer: { selected: ['Postgres'] } }] })
  else await client.call('terminal.live.answer', { requestId: pending[0].requestId, answer: { selected: ['Postgres'] } })
  expect(await settled(run.runId)).toBe('completed')
  expect(faux.lastToolResults().join(' ')).toContain('Postgres')
  expect((await client.call('terminal.live.pending', {}) as { requests: unknown[] }).requests).toEqual([])
})

it('refuses a second run while one is replying, and steers it instead', async () => {
  const { client, faux, settled } = await setup()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  faux.script([async () => { await gate; return faux.says('done') }])
  const before = Date.now()
  const run = await client.call('terminal.live.run', { text: 'long', model: faux.model, newHistory: true }) as { runId: string }
  const state = await client.call('terminal.live.state', {}) as { activeRunId: string | null; activeRunStartedAt: number | null }
  expect(state.activeRunId).toBe(run.runId)
  expect(state.activeRunStartedAt).toBeGreaterThanOrEqual(before)
  expect(state.activeRunStartedAt).toBeLessThanOrEqual(Date.now())
  await expect(client.call('terminal.live.run', { text: 'again', model: faux.model })).rejects.toMatchObject({ code: 'session_busy' })
  expect((await client.call('terminal.live.state', {}) as typeof state).activeRunStartedAt).toBe(state.activeRunStartedAt)
  release()
  expect(await settled(run.runId)).toBe('completed')
  expect((await client.call('terminal.live.state', {}) as typeof state).activeRunStartedAt).toBeNull()
})
