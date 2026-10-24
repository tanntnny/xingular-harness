import { describe, expect, it } from 'vitest'

import { matchPalette, paletteCommandColumnWidth, type PaletteItem } from './palette'

const commands: PaletteItem[] = [
  { name: 'session', aliases: ['resume'], description: 'Choose a saved session in this account and folder' },
  { name: 'accounts', description: 'Sign in, switch, check and remove Pi accounts' },
  { name: 'model', description: 'Choose the model' }
]

const names = (items: PaletteItem[]) => items.map(item => item.name)

describe('the command palette', () => {
  it('offers the command named by the filter before a description that mentions it', () => {
    expect(names(matchPalette(commands, 'account'))).toEqual(['accounts', 'session'])
    expect(matchPalette(commands, 'account')[1]).toEqual(commands[0])
  })

  it('matches aliases without adding a duplicate command row', () => {
    expect(names(matchPalette(commands, 'resume'))).toEqual(['session'])
    expect(names(matchPalette(commands, 'res'))).toEqual(['session'])
    expect(matchPalette(commands, 'resume')[0]).toEqual(commands[0])
  })

  it('puts an exact name first and keeps commands whose name starts with the filter above later matches', () => {
    const items: PaletteItem[] = [
      { name: 'reload', description: 'Reload trusted resources' },
      { name: 'load', description: 'Load a session' },
      { name: 'model', description: 'Choose the model' }
    ]
    expect(names(matchPalette(items, 'load'))).toEqual(['load', 'reload'])
    expect(names(matchPalette(commands, 'accounts'))).toEqual(['accounts'])
  })

  it('keeps the declared order without a filter and drops everything when nothing matches', () => {
    expect(names(matchPalette(commands, ''))).toEqual(['session', 'accounts', 'model'])
    expect(matchPalette(commands, 'nothing')).toEqual([])
  })

  it('does not let a description beat a name that merely contains the filter', () => {
    const items: PaletteItem[] = [
      { name: 'other', description: 'mentions model' },
      { name: 'remodel', description: 'unrelated' }
    ]
    expect(names(matchPalette(items, 'model'))).toEqual(['remodel', 'other'])
  })

  it('includes the one-row alias label when sizing the command column', () => {
    expect(paletteCommandColumnWidth([{ name: 'session', aliases: ['resume'] }], 80)).toBe(17)
  })

  it('aligns descriptions to the widest visible command while reserving room for both columns', () => {
    expect(paletteCommandColumnWidth([{ name: 'short' }, { name: 'settings' }], 80)).toBe(9)
    expect(paletteCommandColumnWidth([{ name: 'a-command-name-that-is-much-longer-than-the-column' }], 40)).toBe(16)
    expect(paletteCommandColumnWidth([{ name: 'a-command-name-that-is-much-longer-than-the-column' }], 80)).toBe(36)
    expect(paletteCommandColumnWidth([], 40)).toBe(1)
  })
})
