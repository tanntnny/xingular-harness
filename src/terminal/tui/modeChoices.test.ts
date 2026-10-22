import { describe, expect, it } from 'vitest'

import type { ModeChoice } from '../../accounts/choices'
import { ModeChoices, type ChoiceModel, type ChoiceSession, type ComposerMode } from './modeChoices'

type Written = { mode: ComposerMode; patch: Record<string, unknown> }

function fixture(saved: Record<string, ModeChoice> = {}, options: { failWrites?: boolean; failRead?: boolean } = {}) {
  const written: Written[] = []
  const store = {
    read: async () => {
      if (options.failRead) throw new Error('The harness did not answer accounts.choices.get.')
      return saved
    },
    write: async (mode: ComposerMode, patch: Record<string, unknown>) => {
      if (options.failWrites) throw new Error('The harness did not answer accounts.choices.set.')
      written.push({ mode, patch })
    }
  }
  const calls: string[] = []
  const session: ChoiceSession & { model?: ChoiceModel } = {
    model: { provider: 'anthropic', id: 'current' } as ChoiceModel,
    async setModel(model, { persist }) {
      calls.push(`setModel ${model.provider}/${model.id} persist=${persist}`)
      if (model.id === 'no-key') throw new Error('No API key for anthropic/no-key')
      session.model = model
    },
    setThinkingLevel(level, { persist }) {
      calls.push(`setThinkingLevel ${level} persist=${persist}`)
    }
  }
  const models: Record<string, ChoiceModel> = {
    'anthropic/fast': { provider: 'anthropic', id: 'fast' } as ChoiceModel,
    'anthropic/no-key': { provider: 'anthropic', id: 'no-key' } as ChoiceModel
  }
  return { choices: new ModeChoices(store), written, session, calls, modelFor: (reference: string) => models[reference] }
}

describe('mode choices', () => {
  it('applies a mode from its saved choice, not as a selection the person made', async () => {
    const { choices, written, session, calls, modelFor } = fixture({ normal: { model: 'anthropic/fast', effort: 'high', updatedAt: 'a' } })
    await choices.load()
    await choices.apply(session, 'normal', modelFor)
    expect(calls).toEqual(['setModel anthropic/fast persist=false', 'setThinkingLevel high persist=false'])
    expect(written).toEqual([])
  })

  it('starts plan from normal field by field until plan picks its own', async () => {
    const { choices, session, calls, modelFor } = fixture({ normal: { model: 'anthropic/fast', effort: 'high', updatedAt: 'a' }, plan: { effort: 'low', updatedAt: 'b' } })
    await choices.load()
    await choices.apply(session, 'plan', modelFor)
    expect(calls).toEqual(['setModel anthropic/fast persist=false', 'setThinkingLevel low persist=false'])
  })

  it('skips a saved model the account cannot use and still applies the effort', async () => {
    const { choices, session, calls, modelFor } = fixture({ normal: { model: 'anthropic/no-key', effort: 'medium', updatedAt: 'a' } })
    await choices.load()
    await choices.apply(session, 'normal', modelFor)
    expect(calls).toEqual(['setModel anthropic/no-key persist=false', 'setThinkingLevel medium persist=false'])
    expect(session.model).toEqual({ provider: 'anthropic', id: 'current' })
  })

  it('does not apply a model the session already has', async () => {
    const { choices, session, calls } = fixture({ normal: { model: 'anthropic/current', effort: 'low', updatedAt: 'a' } })
    await choices.load()
    await choices.apply(session, 'normal', (reference) => (reference === 'anthropic/current' ? ({ provider: 'anthropic', id: 'current' } as ChoiceModel) : undefined))
    expect(calls).toEqual(['setThinkingLevel low persist=false'])
  })

  it('records a selection the person makes, under the mode it was made in', async () => {
    const { choices, written } = fixture()
    await choices.load()
    await choices.record('plan', { effort: 'xhigh' })
    await choices.record('normal', { model: 'anthropic/fast' })
    expect(written).toEqual([{ mode: 'plan', patch: { effort: 'xhigh' } }, { mode: 'normal', patch: { model: 'anthropic/fast' } }])
    // Plan has its own effort and takes normal's model until it picks one.
    expect(choices.resolve('plan')).toEqual({ model: 'anthropic/fast', effort: 'xhigh' })
  })

  it('does not record what the terminal changes itself, even when the change is awaited', async () => {
    const { choices, written, session, modelFor } = fixture({ normal: { model: 'anthropic/fast', effort: 'high', updatedAt: 'a' } })
    await choices.load()
    await choices.quietly(async () => {
      await choices.record('normal', { effort: 'low' })
    })
    expect(written).toEqual([])
    await choices.apply(session, 'normal', modelFor)
    expect(written).toEqual([])
  })

  it('keeps the selection for this session when the save fails', async () => {
    const { choices, written } = fixture({}, { failWrites: true })
    await choices.load()
    await expect(choices.record('normal', { effort: 'low' })).resolves.toBeUndefined()
    expect(choices.resolve('normal')).toEqual({ model: undefined, effort: 'low' })
    expect(written).toEqual([])
  })

  it('starts with nothing known when the read fails', async () => {
    const { choices, session, calls, modelFor } = fixture({}, { failRead: true })
    await choices.load()
    await choices.apply(session, 'normal', modelFor)
    expect(calls).toEqual([])
  })
})
