import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { compactionCheckpoint } from './compactionCheckpoint'

function setup(options: Parameters<typeof compactionCheckpoint>[0] = {}) {
  const handlers = new Map<string, ((event: any, context?: any) => unknown)[]>()
  const api = {
    on(event: string, handler: (event: any, context?: any) => unknown) {
      const registered = handlers.get(event) ?? []
      registered.push(handler)
      handlers.set(event, registered)
      return () => undefined
    }
  } as unknown as ExtensionAPI
  compactionCheckpoint(options)(api)
  const dispatch = async (event: string, payload: any): Promise<any> => {
    let current = payload
    let result: unknown
    for (const handler of handlers.get(event) ?? []) {
      const next = await handler(current, {})
      if (event === 'context' && next && typeof next === 'object' && 'messages' in next) current = { ...current, ...next }
      if (next !== undefined) result = next
    }
    return result
  }
  return { dispatch }
}

const user = { role: 'user', content: 'Finish the migration', timestamp: 1 }
const summary = (timestamp = 10) => ({ role: 'compactionSummary', summary: 'Earlier research.', tokensBefore: 50_000, timestamp })
const compacted = (timestamp = 10, ...after: any[]) => ({ messages: [summary(timestamp), ...after] })
const kept = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'toolResult', content: [{ type: 'text', text: `result ${i}` }], timestamp: 20 + i }))

async function startRun(dispatch: (event: string, payload: any) => Promise<any>, prompt = 'Finish the migration') {
  await dispatch('before_agent_start', { messageType: 'user', prompt })
  expect(await dispatch('context', { messages: [user] })).toBeUndefined()
}

const todoWrite = (items: { text: string; status: string }[]) => ({ toolName: 'todo_write', isError: false, input: { items } })

describe('active-run compaction checkpoints', () => {
  it('restores the request and todo as of a compaction during the run, right after the summary', async () => {
    const { dispatch } = setup()
    await startRun(dispatch)
    await dispatch('tool_result', todoWrite([{ text: 'Inspect the current flow', status: 'completed' }, { text: 'Preserve retry behavior', status: 'in_progress' }]))

    const first = await dispatch('context', compacted(10, ...kept(2)))
    expect(first.messages).toHaveLength(4)
    expect(first.messages[0].role).toBe('compactionSummary')
    expect(first.messages[1]).toMatchObject({ role: 'custom', display: false })
    expect(first.messages[1].content).toContain('Finish the migration')
    expect(first.messages[1].content).toContain('[~] Preserve retry behavior')

    // A later todo is visible in history; the checkpoint keeps the state it had at compaction.
    await dispatch('tool_result', todoWrite([{ text: 'Verify new retry handling', status: 'pending' }]))
    const next = await dispatch('context', compacted(10, ...kept(4)))
    expect(next.messages[1]).toEqual(first.messages[1])
    expect(next.messages[1].content).not.toContain('Verify new retry handling')
  })

  it('keeps each request a strict extension of the previous one', async () => {
    const { dispatch } = setup()
    await startRun(dispatch)
    await dispatch('tool_result', todoWrite([{ text: 'Preserve retry behavior', status: 'in_progress' }]))
    let previous: any[] = []
    for (const length of [0, 2, 3, 6]) {
      const { messages } = await dispatch('context', compacted(10, ...kept(length)))
      expect(messages.slice(0, previous.length)).toEqual(previous)
      previous = messages
    }
  })

  it('rebuilds the checkpoint after a second compaction in the same run', async () => {
    const { dispatch } = setup()
    await startRun(dispatch)
    await dispatch('tool_result', todoWrite([{ text: 'First step', status: 'in_progress' }]))
    expect((await dispatch('context', compacted(10))).messages[1].content).toContain('First step')
    await dispatch('tool_result', todoWrite([{ text: 'Second step', status: 'in_progress' }]))
    expect((await dispatch('context', compacted(30))).messages[1].content).toContain('Second step')
  })

  it('adds nothing to a run that starts from already-compacted history', async () => {
    const { dispatch } = setup({ planInstructions: () => 'Plan mode is research-only.' })
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Plan a migration' })
    expect(await dispatch('context', compacted(10, user))).toBeUndefined()
    await dispatch('tool_result', todoWrite([{ text: 'Read the code', status: 'in_progress' }]))
    expect(await dispatch('context', compacted(10, user, ...kept(2)))).toBeUndefined()

    // A compaction during this run still restores plan instructions.
    const result = await dispatch('context', compacted(40))
    expect(result.messages[1].content).toContain('Plan mode is research-only.')
  })

  it('restores nothing when there is no todo or plan at compaction', async () => {
    const { dispatch } = setup()
    await startRun(dispatch)
    expect(await dispatch('context', compacted())).toBeUndefined()
    await dispatch('tool_result', todoWrite([{ text: 'Written after compaction', status: 'in_progress' }]))
    expect(await dispatch('context', compacted(10, ...kept(1)))).toBeUndefined()
  })

  it('seeds a continued run from its persisted todo', async () => {
    const { dispatch } = setup({ initialTodo: [{ text: 'Resume the pending migration step', status: 'in_progress' }] })
    await startRun(dispatch, 'Continue the migration')
    expect((await dispatch('context', compacted())).messages[1].content).toContain('Resume the pending migration step')
  })

  it('clears state when the active session branch changes', async () => {
    const { dispatch } = setup()
    await startRun(dispatch, 'Inspect this task')
    await dispatch('tool_result', todoWrite([{ text: 'Keep this in the old branch', status: 'in_progress' }]))
    expect((await dispatch('context', compacted())).messages[1].content).toContain('Keep this in the old branch')

    await dispatch('session_tree', {})
    expect(await dispatch('context', compacted())).toBeUndefined()
    expect(await dispatch('context', compacted())).toBeUndefined()
  })

  it('does not expose malformed todo updates or retain state after the run settles', async () => {
    const { dispatch } = setup()
    await startRun(dispatch, 'Inspect the code')
    await dispatch('tool_result', todoWrite([{ text: 'Valid current step', status: 'in_progress' }]))
    await dispatch('tool_result', todoWrite([{ text: '', status: 'pending' }]))
    expect((await dispatch('context', compacted())).messages[1].content).toContain('Valid current step')

    await dispatch('agent_settled', {})
    expect(await dispatch('context', compacted())).toBeUndefined()
    expect(await dispatch('context', compacted(50))).toBeUndefined()
  })
})
