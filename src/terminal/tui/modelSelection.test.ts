import { describe, expect, it } from 'vitest'

import type { AccountSelection, SelectionPatch } from '../../accounts/selection'
import { ModelSelection, type ChoiceModel, type SelectionSession } from './modelSelection'

function fixture(saved: AccountSelection | null = null, options: { failWrites?: boolean; failRead?: boolean } = {}) {
  const written: SelectionPatch[] = []
  const store = {
    read: async () => {
      if (options.failRead) throw new Error('The harness did not answer accounts.selection.get.')
      return saved
    },
    write: async (patch: SelectionPatch) => {
      if (options.failWrites) throw new Error('The harness did not answer accounts.selection.set.')
      written.push(patch)
    }
  }
  const calls: string[] = []
  const session: SelectionSession & { model?: ChoiceModel } = {
    model: { provider: 'anthropic', id: 'current' } as ChoiceModel,
    async setModel(model, { persist }) {
      calls.push(`setModel ${model.provider}/${model.id} persist=${persist}`)
      session.model = model
    },
    setThinkingLevel(level, { persist }) {
      calls.push(`setThinkingLevel ${level} persist=${persist}`)
    }
  }
  const models: Record<string, ChoiceModel> = {
    'anthropic/fast': { provider: 'anthropic', id: 'fast' } as ChoiceModel
  }
  return { selection: new ModelSelection(store), written, session, calls, modelFor: (reference: string) => models[reference] }
}

describe('the account model selection', () => {
  it('loads one model and effort', async () => {
    const { selection } = fixture({ model: 'anthropic/fast', effort: 'high', updatedAt: 'a' })
    await selection.load()
    expect(selection.get()).toEqual({ model: 'anthropic/fast', effort: 'high' })
  })

  it('records a selection the person makes and keeps the other field', async () => {
    const { selection, written } = fixture({ model: 'anthropic/fast', effort: 'high', updatedAt: 'a' })
    await selection.load()
    await selection.record({ effort: 'xhigh' })
    await selection.record({ model: 'openai/c' })
    expect(written).toEqual([{ effort: 'xhigh' }, { model: 'openai/c' }])
    expect(selection.get()).toEqual({ model: 'openai/c', effort: 'xhigh' })
  })

  it('does not record what the terminal changes itself, even when the change is awaited', async () => {
    const { selection, written, session, modelFor } = fixture({ model: 'anthropic/fast', effort: 'high', updatedAt: 'a' })
    await selection.load()
    await selection.quietly(async () => {
      await selection.record({ effort: 'low' })
    })
    expect(written).toEqual([])
    const model = modelFor('anthropic/fast')
    expect(model).toBeDefined()
    await selection.useFallback(session, async () => model, 'medium')
    expect(written).toEqual([])
  })

  it('starts a conversation the account cannot continue on the saved model and effort', async () => {
    const { selection, session, calls, modelFor } = fixture({ model: 'anthropic/fast', effort: 'high', updatedAt: 'a' })
    await selection.load()
    const model = modelFor('anthropic/fast')
    expect(model).toBeDefined()
    await expect(selection.useFallback(session, async () => model, 'medium')).resolves.toEqual({ reference: 'anthropic/fast', effort: 'high' })
    expect(calls).toEqual(['setModel anthropic/fast persist=false', 'setThinkingLevel high persist=false'])
  })

  it('skips a saved model the account cannot use and keeps the session', async () => {
    const { selection, session, calls } = fixture({ model: 'anthropic/gone', effort: 'low', updatedAt: 'a' })
    await selection.load()
    await expect(selection.useFallback(session, async () => undefined, 'medium')).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('keeps the selection for this session when the save fails', async () => {
    const { selection, written } = fixture(null, { failWrites: true })
    await selection.load()
    await expect(selection.record({ effort: 'low' })).resolves.toBeUndefined()
    expect(selection.get()).toEqual({ model: undefined, effort: 'low' })
    expect(written).toEqual([])
  })

  it('starts with nothing known when the read fails', async () => {
    const { selection } = fixture(null, { failRead: true })
    await selection.load()
    expect(selection.get()).toEqual({ model: undefined, effort: undefined })
  })
})
