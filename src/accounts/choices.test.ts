import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { latestChoice, readChoices, resolveChoice, saveChoice, startChoice, startModels } from './choices'

const temp = () => mkdtempSync(join(tmpdir(), 'choices-'))

describe('model and effort choices per account and mode', () => {
  it('keeps each mode and each account apart', () => {
    const dir = temp()
    saveChoice(dir, 'acct-1', 'normal', { model: 'anthropic/a', effort: 'high' })
    saveChoice(dir, 'acct-1', 'plan', { model: 'anthropic/b' })
    saveChoice(dir, 'acct-2', 'normal', { effort: 'low' })
    expect(readChoices(dir, 'acct-1')).toMatchObject({ normal: { model: 'anthropic/a', effort: 'high' }, plan: { model: 'anthropic/b' } })
    expect(readChoices(dir, 'acct-1').plan.effort).toBeUndefined()
    expect(readChoices(dir, 'acct-2')).toMatchObject({ normal: { effort: 'low' } })
    expect(readChoices(dir, 'acct-2').normal.model).toBeUndefined()
  })

  it('merges one field and keeps the other', () => {
    const dir = temp()
    saveChoice(dir, 'acct', 'normal', { model: 'anthropic/a', effort: 'high' })
    saveChoice(dir, 'acct', 'normal', { effort: 'xhigh' })
    saveChoice(dir, 'acct', 'normal', { model: 'openai/c' })
    expect(readChoices(dir, 'acct').normal).toMatchObject({ model: 'openai/c', effort: 'xhigh' })
  })

  it('refuses an invalid mode, model, effort, or an empty patch', () => {
    const dir = temp()
    expect(() => saveChoice(dir, 'acct', 'Plan Mode', { effort: 'low' })).toThrow('A mode is')
    expect(() => saveChoice(dir, 'acct', 'plan', { model: 'no-slash' })).toThrow('provider/id')
    expect(() => saveChoice(dir, 'acct', 'plan', { model: 'has space/x' })).toThrow('provider/id')
    expect(() => saveChoice(dir, 'acct', 'plan', { effort: 'extreme' as never })).toThrow('An effort is one of')
    expect(() => saveChoice(dir, 'acct', 'plan', {})).toThrow('Choose a model or an effort.')
    expect(readChoices(dir, 'acct')).toEqual({})
  })

  it('reads a corrupt file or an invalid entry as nothing, and keeps the valid ones', () => {
    const dir = temp()
    saveChoice(dir, 'acct', 'normal', { effort: 'medium' })
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({ modes: { normal: { effort: 'warp' }, 'Bad Mode': { effort: 'low' }, plan: { model: 'anthropic/p' } } }))
    expect(readChoices(dir, 'acct')).toMatchObject({ plan: { model: 'anthropic/p' } })
    expect(readChoices(dir, 'acct')).not.toHaveProperty('normal')
    writeFileSync(join(dir, 'acct', 'choices.json'), '{broken')
    expect(readChoices(dir, 'acct')).toEqual({})
  })

  it('starts a plan from normal field by field until the plan picks its own', () => {
    const dir = temp()
    saveChoice(dir, 'acct', 'normal', { model: 'anthropic/a', effort: 'high' })
    saveChoice(dir, 'acct', 'plan', { effort: 'low' })
    expect(resolveChoice(readChoices(dir, 'acct'), 'plan')).toEqual({ model: 'anthropic/a', effort: 'low' })
    expect(resolveChoice(readChoices(dir, 'acct'), 'normal')).toEqual({ model: 'anthropic/a', effort: 'high' })
    expect(resolveChoice({}, 'plan')).toEqual({ model: undefined, effort: undefined })
  })

  it('starts a conversation this account cannot continue on the newest selection in any mode', () => {
    const dir = temp()
    mkdirSync(join(dir, 'acct'), { recursive: true })
    // Explicit timestamps: two saves inside one millisecond would otherwise tie.
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({ modes: {
      plan: { model: 'anthropic/p', effort: 'low', updatedAt: '2026-01-02T00:00:00.000Z' },
      normal: { model: 'anthropic/n', effort: 'high', updatedAt: '2026-01-01T00:00:00.000Z' },
      research: { effort: 'max', updatedAt: '2026-01-03T00:00:00.000Z' }
    } }))
    const modes = readChoices(dir, 'acct')
    // The newest mode may name only an effort; it never contributes a missing model.
    expect(latestChoice(modes)).toEqual({ mode: 'research', effort: 'max' })
    expect(startChoice(modes, 'normal')).toEqual({ model: 'anthropic/n', effort: 'high' })
    expect(startChoice(modes, 'plan')).toEqual({ model: 'anthropic/p', effort: 'low' })
    // Every model to try, most specific first and without repeats.
    expect(startModels(modes, 'plan')).toEqual(['anthropic/p', 'anthropic/n'])
    expect(startModels(modes, 'normal')).toEqual(['anthropic/n'])
    expect(startChoice({}, 'normal')).toEqual({ model: undefined, effort: undefined })
    expect(startModels({}, 'plan')).toEqual([])
  })
})
