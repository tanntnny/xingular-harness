import { describe, expect, it } from 'vitest'

import { commandHelpColumnWidth } from './commandHelpLayout'
import { formatTerminalCommandLabel, type TerminalCommandHelpGroup } from '../commandHelp'

const groups: TerminalCommandHelpGroup[] = [
  { name: 'Core', commands: [{ name: 'help' }, { name: 'hotkeys' }] },
  { name: 'Extensions', commands: [{ name: 'a-command-name-that-needs-wrapping' }] }
]

describe('command help layout', () => {
  it('aligns descriptions to the widest command when space permits', () => {
    expect(commandHelpColumnWidth(groups.slice(0, 1), 80)).toBe(8)
  })

  it('formats and sizes a command and its alias as one displayed label', () => {
    expect(formatTerminalCommandLabel('session', ['resume'])).toBe('session (resume)')
    expect(commandHelpColumnWidth([{ name: 'Session', commands: [{ name: 'session', aliases: ['resume'] }] }], 80)).toBe(17)
  })

  it('caps the command column to keep room for wrapped descriptions', () => {
    expect(commandHelpColumnWidth(groups, 40)).toBe(19)
    expect(commandHelpColumnWidth(groups, 16)).toBe(7)
    expect(commandHelpColumnWidth(groups, 4)).toBe(1)
  })
})
