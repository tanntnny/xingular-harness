import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readSelection, saveSelection } from './selection'

const temp = () => mkdtempSync(join(tmpdir(), 'selection-'))

describe('the account selection', () => {
  it('keeps one model and effort, and each account apart', () => {
    const dir = temp()
    saveSelection(dir, 'acct-1', { model: 'anthropic/a', effort: 'high' })
    saveSelection(dir, 'acct-2', { effort: 'low' })
    expect(readSelection(dir, 'acct-1')).toMatchObject({ model: 'anthropic/a', effort: 'high' })
    expect(readSelection(dir, 'acct-2')).toMatchObject({ effort: 'low' })
    expect(readSelection(dir, 'acct-2')?.model).toBeUndefined()
    expect(readSelection(dir, 'missing')).toBeNull()
  })

  it('merges one field and keeps the other', () => {
    const dir = temp()
    saveSelection(dir, 'acct', { model: 'anthropic/a', effort: 'high' })
    saveSelection(dir, 'acct', { effort: 'xhigh' })
    saveSelection(dir, 'acct', { model: 'openai/c' })
    expect(readSelection(dir, 'acct')).toMatchObject({ model: 'openai/c', effort: 'xhigh' })
  })

  it('refuses an invalid model, effort or an empty patch', () => {
    const dir = temp()
    expect(() => saveSelection(dir, 'acct', { model: 'no-slash' })).toThrow('provider/id')
    expect(() => saveSelection(dir, 'acct', { model: 'has space/x' })).toThrow('provider/id')
    expect(() => saveSelection(dir, 'acct', { effort: 'extreme' as never })).toThrow('An effort is one of')
    expect(() => saveSelection(dir, 'acct', {})).toThrow('Choose a model or an effort.')
    expect(readSelection(dir, 'acct')).toBeNull()
  })

  it('reads a corrupt file or an invalid entry as nothing', () => {
    const dir = temp()
    mkdirSync(join(dir, 'acct'), { recursive: true })
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({ model: 'no-slash', effort: 'warp' }))
    expect(readSelection(dir, 'acct')).toBeNull()
    writeFileSync(join(dir, 'acct', 'choices.json'), '{broken')
    expect(readSelection(dir, 'acct')).toBeNull()
  })

  it('takes the newest legacy mode entry as the one selection', () => {
    const dir = temp()
    mkdirSync(join(dir, 'acct'), { recursive: true })
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({ modes: {
      plan: { model: 'anthropic/p', effort: 'low', updatedAt: '2026-01-02T00:00:00.000Z' },
      normal: { model: 'anthropic/n', effort: 'high', updatedAt: '2026-01-01T00:00:00.000Z' },
      research: { effort: 'max', updatedAt: '2026-01-03T00:00:00.000Z' }
    } }))
    expect(readSelection(dir, 'acct')).toEqual({ effort: 'max', updatedAt: '2026-01-03T00:00:00.000Z' })
  })

  it('prefers normal on a legacy tie and ignores an invalid legacy entry', () => {
    const dir = temp()
    mkdirSync(join(dir, 'acct'), { recursive: true })
    const at = '2026-01-01T00:00:00.000Z'
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({ modes: {
      plan: { model: 'anthropic/p', updatedAt: at },
      normal: { model: 'anthropic/n', updatedAt: at },
      broken: { model: 'no-slash', updatedAt: '2026-01-04T00:00:00.000Z' }
    } }))
    expect(readSelection(dir, 'acct')).toMatchObject({ model: 'anthropic/n' })
  })

  it('reads a flat selection in preference to a legacy modes object, and saves flat', () => {
    const dir = temp()
    mkdirSync(join(dir, 'acct'), { recursive: true })
    writeFileSync(join(dir, 'acct', 'choices.json'), JSON.stringify({
      model: 'anthropic/flat', effort: 'medium', updatedAt: '2026-01-01T00:00:00.000Z',
      modes: { normal: { model: 'anthropic/legacy', updatedAt: '2026-02-01T00:00:00.000Z' } }
    }))
    expect(readSelection(dir, 'acct')).toMatchObject({ model: 'anthropic/flat', effort: 'medium' })
    saveSelection(dir, 'acct', { effort: 'low' })
    expect(readSelection(dir, 'acct')).toMatchObject({ model: 'anthropic/flat', effort: 'low' })
  })
})
