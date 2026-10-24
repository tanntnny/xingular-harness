import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { AgentProfile } from '../../../agents/profiles'
import { createHarnessTheme } from '../theme'
import { AGENT_ACTIONS, AGENT_SCOPES, AgentsPage, type AgentsOverview } from './agentsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function profile(name: string, extra: Partial<AgentProfile> = {}): AgentProfile {
  return { name, description: `${name} description`, color: 'green', instructions: `Be ${name}.`, tools: null, plugins: null, variant: null, model: null, effort: null, source: 'builtin', path: null, ...extra }
}

const overview: AgentsOverview = {
  profiles: [
    profile('explorer', { color: 'cyan', tools: ['read', 'grep'] }),
    profile('reviewer', { source: 'project', path: '/repo/.xingular/agents/reviewer.md', variant: { scope: 'review', version: null }, effort: 'high' })
  ],
  problems: [{ name: 'broken', source: 'global', path: '/data/agents/broken.md', error: 'The profile needs a description.' }],
  dirs: { global: '/data/agents', project: '/repo/.xingular/agents' }
}

function setup(answers: { select?: string[]; confirm?: boolean; input?: string } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const selects = [...(answers.select ?? [])]
  const options = {
    theme: () => theme,
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'terminal.agents.list') return overview
      if (method === 'terminal.agents.create') return profile(String(params?.name), { source: params?.scope as 'global', path: `/made/${String(params?.name)}.md` })
      return {}
    }) as never,
    ui: {
      select: vi.fn(async () => selects.shift()),
      confirm: vi.fn(async () => answers.confirm ?? true),
      notify: vi.fn(),
      input: vi.fn(async () => answers.input)
    },
    edit: vi.fn(async () => {}),
    changed: vi.fn()
  }
  const page = new AgentsPage(options)
  page.focused = true
  return { page, options, calls }
}

const plain = (page: AgentsPage) => page.render(110, 40).map(stripTerminalSequences).join('\n')

describe('AgentsPage', () => {
  it('lists profiles by source with the selected one\'s details and unreadable files', async () => {
    const { page } = setup()
    await page.reload()
    expect(page.rows().map(row => [row.group, row.label])).toEqual([
      ['Actions', 'New profile'], ['Built-in', 'explorer'], ['Project', 'reviewer'], ['Cannot be read', 'broken']
    ])
    expect(plain(page)).toContain('A project profile wins over a global one')
    page.handleInput('\u001b[B')
    const detail = plain(page)
    expect(detail).toContain('explorer · cyan')
    expect(detail).toContain('Tools: read, grep')
    expect(detail).toContain('Variant: the parent\'s')
    expect(detail).toContain('File: built in')
    expect(detail).toContain('Be explorer.')
  })

  it('creates a profile in the chosen place and opens it in the editor', async () => {
    const { page, calls, options } = setup({ input: 'scout', select: [AGENT_SCOPES.project] })
    await page.reload()
    await page.activateRow({ kind: 'new' })
    expect(calls).toContainEqual({ method: 'terminal.agents.create', params: { name: 'scout', scope: 'project' } })
    expect(options.edit).toHaveBeenCalledWith('/made/scout.md')
  })

  it('offers only a copy for a built-in, and edit, copy and delete for a person\'s own profile', async () => {
    const { page, calls, options } = setup({ select: [AGENT_ACTIONS.copy, AGENT_SCOPES.global, AGENT_ACTIONS.remove], input: 'my-explorer' })
    await page.reload()
    await page.activateRow({ kind: 'profile', profile: overview.profiles[0]! })
    expect(options.ui.select).toHaveBeenNthCalledWith(1, 'explorer · Built-in', [AGENT_ACTIONS.copy])
    expect(calls).toContainEqual({ method: 'terminal.agents.create', params: { name: 'my-explorer', scope: 'global', from: 'explorer' } })
    await page.activateRow({ kind: 'profile', profile: overview.profiles[1]! })
    expect(options.ui.select).toHaveBeenLastCalledWith('reviewer · Project', [AGENT_ACTIONS.edit, AGENT_ACTIONS.copy, AGENT_ACTIONS.remove])
    expect(options.ui.confirm).toHaveBeenCalled()
    expect(calls).toContainEqual({ method: 'terminal.agents.remove', params: { name: 'reviewer', scope: 'project' } })
  })

  it('opens an unreadable file for fixing', async () => {
    const { page, options } = setup({ select: [AGENT_ACTIONS.edit] })
    await page.reload()
    await page.activateRow({ kind: 'problem', problem: overview.problems[0]! })
    expect(options.edit).toHaveBeenCalledWith('/data/agents/broken.md')
  })
})
