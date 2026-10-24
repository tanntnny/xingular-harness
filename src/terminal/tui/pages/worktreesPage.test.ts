import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { WorktreeRecord } from '../../../worktrees/types'
import { createHarnessTheme } from '../theme'
import { WORKTREE_ACTIONS, WorktreesPage, type WorktreeOverview } from './worktreesPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function record(id: string, extra: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id, repoRoot: '/repo', path: `/state/worktrees/repo/${id}`, name: id, branch: null, baseRef: 'HEAD', baseCommit: 'abc',
    kind: 'managed', origin: 'created', createdAt: '2026-10-23T00:00:00Z', lastUsedAt: '2026-10-23T00:00:00Z', lease: null, removed: null, ...extra
  }
}

function setup(overview: WorktreeOverview, answers: { select?: string; confirm?: boolean; input?: string } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const options = {
    theme: () => theme,
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'terminal.worktrees.list') return overview
      if (method === 'terminal.worktrees.create') return { worktree: record('wt-new'), setup: { state: 'none' } }
      if (method === 'terminal.worktrees.handoff') return { patched: true, copied: [], stash: 'abc' }
      return {}
    }) as never,
    ui: {
      select: vi.fn(async (_title: string, _options: string[]) => answers.select),
      confirm: vi.fn(async () => answers.confirm ?? true),
      notify: vi.fn(),
      input: vi.fn(async () => answers.input)
    },
    relaunch: vi.fn(),
    changed: vi.fn()
  }
  const page = new WorktreesPage(options)
  page.focused = true
  return { page, options, calls }
}
const plain = (page: WorktreesPage) => page.render(100, 30).map(stripTerminalSequences).join('\n')

const overview: WorktreeOverview = {
  repo: '/repo', current: 'wt-a', reason: null,
  worktrees: [
    { record: record('wt-a', { lease: { holder: 's', pid: 1, at: '' } }), exists: true, head: 'abc', changes: 0, ahead: 0 },
    { record: record('wt-b', { branch: 'wt/feature' }), exists: true, head: 'def', changes: 2, ahead: 1 }
  ],
  removed: [record('wt-old', { removed: { at: '', head: 'abc', snapshot: 'refs/xharness/snapshots/wt-old' } })]
}

describe('the Worktrees page', () => {
  it('lists actions, worktrees with their state, and restorable ones', async () => {
    const { page } = setup(overview)
    page.activate()
    await vi.waitFor(() => expect(plain(page)).toContain('wt-b'))
    const text = plain(page)
    expect(text).toContain('Repository /repo')
    expect(text).toContain('New managed worktree')
    expect(text).toContain('Switch back to the main checkout')
    expect(text).toContain('this terminal')
    expect(text).toContain('wt/feature · 2 changed · 1 commit(s)')
    expect(text).toContain('snapshot kept')
  })

  it('says a folder outside a repository has no worktrees', async () => {
    const { page } = setup({ repo: null, current: null, worktrees: [], removed: [], reason: 'not a repository' })
    page.activate()
    await vi.waitFor(() => expect(plain(page)).toContain('Worktrees need a git repository'))
  })

  it('creates a managed worktree and switches the terminal to it', async () => {
    const { page, calls, options } = setup(overview, { confirm: true })
    page.activate()
    await vi.waitFor(() => expect(page.rows().length).toBeGreaterThan(0))
    await page.activateRow({ kind: 'new' })
    expect(calls.map(call => call.method)).toContain('terminal.worktrees.create')
    expect(calls.find(call => call.method === 'terminal.worktrees.switch')?.params).toEqual({ id: 'wt-new' })
    expect(options.relaunch).toHaveBeenCalledOnce()
  })

  it('offers removal with a snapshot for a worktree with work, and never removes this terminal’s worktree', async () => {
    const { page, calls, options } = setup(overview, { select: WORKTREE_ACTIONS.removeForce, confirm: true })
    page.activate()
    await vi.waitFor(() => expect(page.rows().length).toBeGreaterThan(0))
    await page.activateRow({ kind: 'worktree', status: overview.worktrees[1] })
    expect(calls.find(call => call.method === 'terminal.worktrees.remove')?.params).toEqual({ id: 'wt-b', force: true })

    options.ui.select.mockClear()
    await page.activateRow({ kind: 'worktree', status: overview.worktrees[0] })
    const offered = options.ui.select.mock.calls[0]?.[1] ?? []
    expect(offered).not.toContain(WORKTREE_ACTIONS.remove)
    expect(offered).not.toContain(WORKTREE_ACTIONS.removeForce)
    expect(offered).not.toContain(WORKTREE_ACTIONS.switch)
  })

  it('hands changes off and restores a removed worktree', async () => {
    const { page, calls } = setup(overview, { select: WORKTREE_ACTIONS.toSource })
    page.activate()
    await vi.waitFor(() => expect(page.rows().length).toBeGreaterThan(0))
    await page.activateRow({ kind: 'worktree', status: overview.worktrees[1] })
    expect(calls.find(call => call.method === 'terminal.worktrees.handoff')?.params).toEqual({ id: 'wt-b', direction: 'toSource' })
    await page.activateRow({ kind: 'removed', record: overview.removed[0] })
    expect(calls.find(call => call.method === 'terminal.worktrees.restore')?.params).toEqual({ id: 'wt-old' })
  })
})
