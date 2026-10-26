import { describe, expect, it } from 'vitest'

import { listCommands } from './list'
import { CORE_COMMANDS, coreCommand } from './registry'

describe('command registry', () => {
  it('names each command and alias once', () => {
    const names = CORE_COMMANDS.flatMap((command) => [command.name, ...('aliases' in command ? command.aliases : [])])
    expect(new Set(names).size).toBe(names.length)
  })

  it('resolves aliases', () => {
    expect(coreCommand('side')?.name).toBe('btw')
    expect(coreCommand('tree')?.name).toBe('history')
    expect(coreCommand('nope')).toBeUndefined()
  })

  it('lists core and built-in plugin commands, prompts and skills from one source', () => {
    const listed = listCommands([{
      id: 'pkg', source: 'yours', path: null, contributions: [
        { kind: 'command', name: 'review', description: 'Review', state: 'on', path: '/prompts/review.md' },
        { kind: 'command', name: 'fork', description: 'Shadowed', state: 'on' },
        { kind: 'skill', name: 'deploy', description: 'Deploy', state: 'on' },
        { kind: 'skill', name: 'off', description: 'Off', state: 'off' }
      ]
    } as never])
    const names = listed.map((command) => command.name)
    expect(names).toEqual(expect.arrayContaining(['help', 'fork', 'annotate:annotate', 'annotate:', 'review', 'skill:deploy']))
    expect(names).not.toContain('skill:off')
    expect(listed.find((command) => command.name === 'fork')?.source).toBe('core')
  })
})
