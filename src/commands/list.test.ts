import { describe, expect, it } from 'vitest'
import type { Plugin } from '../plugins/types'
import { listCommands } from './list'

function plugin(paths: Array<{ path: string; commands: string[] }>, extra: unknown[] = [], source = 'shared', path: string | null = null): Plugin {
  return { id: path ?? 'shared', source, path, contributions: [
    ...paths.map(item => ({ kind: 'code', path: item.path, state: 'on', registered: { commands: item.commands } })),
    ...extra
  ] } as Plugin
}
const names = (plugins: Plugin[]) => listCommands(plugins).map(command => command.name)

describe('command listing routes', () => {
  it('rejects a whole owner prefix even when command names do not overlap', () => {
    const commands = names([plugin([
      { path: '/one/my-tools.ts', commands: ['one'] },
      { path: '/two/my_tools.ts', commands: ['two'] }
    ])])
    expect(commands).not.toContain('my-tools:one')
    expect(commands).not.toContain('my-tools:two')
  })

  it('rejects colliding loose project extensions as separate owners', () => {
    const commands = names([plugin([
      { path: '/project/.pi/extensions/my-tools.ts', commands: ['one'] },
      { path: '/project/.pi/extensions/my_tools.ts', commands: ['two'] }
    ], [], 'project', '/project')])
    expect(commands).not.toContain('my-tools:one')
    expect(commands).not.toContain('my-tools:two')
  })

  it('rejects duplicate registrations within an owner, but permits distinct routes', () => {
    const commands = names([plugin([
      { path: '/extensions/tools.ts', commands: ['same', 'same', 'other'] }
    ])])
    expect(commands).not.toContain('tools:same')
    expect(commands).toContain('tools:other')
  })

  it('keeps built-in namespaces and core aliases reserved', () => {
    const commands = listCommands([plugin([{ path: '/extensions/annotate.ts', commands: ['steal', 'notes'] }], [
      { kind: 'command', name: 'side', path: '/prompts/side.md', state: 'on' },
      { kind: 'command', name: 'annotate:steal', path: '/prompts/steal.md', state: 'on' },
      { kind: 'command', name: 'skill:steal', path: '/prompts/skill.md', state: 'on' }
    ])])
    expect(commands.find(command => command.name === 'annotate:notes')?.source).toBe('plugin')
    expect(commands.map(command => command.name)).not.toEqual(expect.arrayContaining(['annotate:steal', 'side', 'skill:steal']))
  })

  it('does not expose catalogue-observed extension commands as bare prompt templates', () => {
    const commands = names([plugin([{ path: '/extensions/tools.ts', commands: ['review'] }], [
      { kind: 'command', name: 'review', path: null, state: 'on' },
      { kind: 'command', name: 'real', path: '/prompts/real.md', state: 'on' },
      { kind: 'command', name: 'off', path: '/prompts/off.md', state: 'off' }
    ])])
    expect(commands).toContain('tools:review')
    expect(commands).toContain('real')
    expect(commands).not.toContain('review')
    expect(commands).not.toContain('off')
  })

  it('does not list a prompt under the bare name of a registered extension command', () => {
    const commands = names([plugin([{ path: '/extensions/review.ts', commands: ['review'] }], [
      { kind: 'command', name: 'review', path: '/prompts/review.md', state: 'on' }
    ])])
    expect(commands).toContain('review:review')
    expect(commands).not.toContain('review')
  })

  it('does not offer off or untrusted extension registrations', () => {
    const p = plugin([{ path: '/extensions/tools.ts', commands: ['run'] }])
    for (const state of ['off', 'untrusted'] as const) {
      p.contributions[0]!.state = state
      expect(names([p])).not.toContain('tools:run')
    }
  })
})
