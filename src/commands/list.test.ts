import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  it('namespaces package prompts and exposes only the declared root default', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompt-owner-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@xingular/devkit', harness: { commandPrefix: 'xdiag', defaultPrompt: 'diagnose' } }))
    const entries = [{ kind: 'command', name: 'diagnose', path: join(root, 'prompts/diagnose.md'), state: 'on' }, { kind: 'command', name: 'sweep', path: join(root, 'prompts/sweep.md'), state: 'on' }]
    const commands = names([plugin([], entries, 'package', root)])
    expect(commands).toEqual(expect.arrayContaining(['xdiag:', 'xdiag:sweep']))
    expect(commands).not.toEqual(expect.arrayContaining(['diagnose', 'sweep', 'xdiag:diagnose']))
    expect(names([plugin([{ path: join(root, 'extension.ts'), commands: ['sweep'] }], entries, 'package', root)])).not.toContain('xdiag:sweep')
  })
  it('namespaces prompts discovered by loose extensions without changing standalone prompts', () => {
    const p = plugin([{ path: '/extensions/tools.ts', commands: [] }], [
      { kind: 'command', name: 'review', path: '/discovered/review.md', state: 'on' },
      { kind: 'command', name: 'standalone', path: '/prompts/standalone.md', state: 'on' }
    ])
    p.contributions[0]!.registered!.resources = [{ kind: 'command', name: 'review', path: '/discovered/review.md', chars: 5 }]
    expect(names([p])).toEqual(expect.arrayContaining(['tools:review', 'standalone']))
    expect(names([p])).not.toContain('review')
  })

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
