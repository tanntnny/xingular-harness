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

const compacted = (timestamp = 10) => ({
  messages: [{ role: 'compactionSummary', summary: 'Earlier research.', tokensBefore: 50_000, timestamp }]
})

describe('active-run compaction checkpoints', () => {
  it('reinjects the latest validated checklist on each request after a new compaction', async () => {
    const { dispatch } = setup()
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Finish the migration' })
    expect(await dispatch('context', { messages: [{ role: 'user', content: 'Finish the migration', timestamp: 1 }] })).toBeUndefined()

    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: 'Inspect the current flow', status: 'completed' }, { text: 'Preserve retry behavior', status: 'in_progress' }] }
    })
    const first = await dispatch('context', compacted())
    expect(first.messages.at(-1)).toMatchObject({ role: 'custom', display: false })
    expect(first.messages.at(-1).content).toContain('Finish the migration')
    expect(first.messages.at(-1).content).toContain('[~] Preserve retry behavior')

    const nextRequest = await dispatch('context', compacted())
    expect(nextRequest.messages.at(-1).content).toContain('[~] Preserve retry behavior')

    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: 'Verify new retry handling', status: 'pending' }] }
    })
    const updated = await dispatch('context', compacted())
    expect(updated.messages.at(-1).content).toContain('[ ] Verify new retry handling')
    expect(updated.messages.at(-1).content).not.toContain('Preserve retry behavior')
  })

  it('restores plan instructions if a run starts from already-compacted history', async () => {
    const { dispatch } = setup({ planInstructions: () => 'Plan mode is research-only.' })
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Plan a migration' })
    const result = await dispatch('context', compacted())
    expect(result.messages.at(-1).content).toContain('Plan mode is research-only.')
  })

  it('includes a checklist written after an earlier compaction', async () => {
    const { dispatch } = setup()
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Finish the migration' })
    expect(await dispatch('context', compacted())).toBeUndefined()

    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: 'Continue from the open retry question', status: 'in_progress' }] }
    })
    expect((await dispatch('context', compacted())).messages.at(-1).content).toContain('Continue from the open retry question')
  })

  it('seeds a continued run from its persisted checklist', async () => {
    const { dispatch } = setup({ initialChecklist: [{ text: 'Resume the pending migration step', status: 'in_progress' }] })
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Continue the migration' })
    expect((await dispatch('context', compacted())).messages.at(-1).content).toContain('Resume the pending migration step')
  })

  it('clears state when the active session branch changes', async () => {
    const { dispatch } = setup()
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Inspect this task' })
    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: 'Keep this in the old branch', status: 'in_progress' }] }
    })
    expect((await dispatch('context', compacted())).messages.at(-1).content).toContain('Keep this in the old branch')

    await dispatch('session_tree', {})
    expect(await dispatch('context', compacted())).toBeUndefined()
  })

  it('does not expose malformed checklist updates or retain state after the run settles', async () => {
    const { dispatch } = setup()
    await dispatch('before_agent_start', { messageType: 'user', prompt: 'Inspect the code' })
    await dispatch('context', { messages: [] })
    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: 'Valid current step', status: 'in_progress' }] }
    })
    await dispatch('tool_result', {
      toolName: 'checklist_write', isError: false,
      input: { items: [{ text: '', status: 'pending' }] }
    })
    expect((await dispatch('context', compacted())).messages.at(-1).content).toContain('Valid current step')

    await dispatch('agent_settled', {})
    expect(await dispatch('context', compacted())).toBeUndefined()
  })
})
