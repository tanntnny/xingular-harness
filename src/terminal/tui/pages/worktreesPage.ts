/**
 * The Worktrees page (`/worktree`): the managed worktrees of the repository this session works in.
 * A person makes, switches to, branches, hands off, removes, restores and prunes them; switching
 * restarts the terminal in the chosen folder as a new conversation (PROP-0016).
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { MenuCall, MenuUi } from '../../pluginMenu'
import type { TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'
import type { WorktreeRecord, WorktreeStatus } from '../../../worktrees/types'

export interface WorktreeOverview {
  repo: string | null
  current: string | null
  worktrees: WorktreeStatus[]
  removed: WorktreeRecord[]
  reason: string | null
}

export interface WorktreesPageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  /** Ends the frontend so the host restarts it in the chosen folder. */
  relaunch(): void
  changed(): void
}

type Row = { kind: 'new' | 'permanent' | 'prune' | 'trust' | 'main' } | { kind: 'worktree'; status: WorktreeStatus } | { kind: 'removed'; record: WorktreeRecord }

const TABS = [{ id: 'worktrees', title: 'Worktrees' }] as const

export const WORKTREE_ACTIONS = {
  switch: 'Switch this terminal here (new conversation)',
  branch: 'Create branch here',
  toSource: 'Hand off its changes to the main checkout',
  toWorktree: "Bring the main checkout's changes here",
  remove: 'Remove',
  removeForce: 'Remove, keeping a snapshot of unsaved work'
} as const

export class WorktreesPage implements TerminalPage {
  presentation = 'centered' as const
  private overview: WorktreeOverview | undefined
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<Row>

  constructor(private readonly options: WorktreesPageOptions) {
    this.list = new FilterList<Row>({
      theme: options.theme, search: 'always', noun: ['worktree', 'worktrees'], empty: 'No worktrees yet',
      onActivate: row => { if (row.data) void this.activateRow(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'worktrees' }
  hint(): string { return 'Enter choose · type to search · Esc close' }

  async reload(): Promise<void> {
    try {
      this.overview = await this.options.call<WorktreeOverview>('terminal.worktrees.list')
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.list.setRows(this.rows())
    this.options.changed()
  }

  rows(): ListRow<Row>[] {
    const overview = this.overview
    if (!overview?.repo) return []
    const rows: ListRow<Row>[] = [
      { id: 'new', label: 'New managed worktree', group: 'Actions', detail: 'detached, carries your changes', tone: 'accent', data: { kind: 'new' } },
      { id: 'permanent', label: 'New permanent worktree', group: 'Actions', detail: 'named, never pruned', tone: 'muted', data: { kind: 'permanent' } }
    ]
    if (overview.current) rows.push({ id: 'main', label: 'Switch back to the main checkout', group: 'Actions', tone: 'muted', data: { kind: 'main' } })
    rows.push(
      { id: 'prune', label: 'Prune older managed worktrees', group: 'Actions', tone: 'muted', data: { kind: 'prune' } },
      { id: 'trust', label: 'Trust the setup script as it is now', group: 'Actions', tone: 'muted', data: { kind: 'trust' } }
    )
    for (const status of overview.worktrees) {
      const record = status.record
      const here = record.id === overview.current ? ' · this terminal' : record.lease ? ' · in use' : ''
      const changes = status.changes ? `${status.changes} changed` : 'clean'
      rows.push({
        id: `worktree:${record.id}`, label: record.name, group: 'Worktrees',
        detail: `${record.branch ?? 'detached'} · ${changes}${status.ahead ? ` · ${status.ahead} commit(s)` : ''} · ${record.kind}${here}`,
        tone: record.id === overview.current ? 'success' : status.changes ? 'warning' : 'muted',
        searchText: `${record.name} ${record.branch ?? ''} ${record.path}`,
        data: { kind: 'worktree', status }
      })
    }
    for (const record of overview.removed) {
      rows.push({
        id: `removed:${record.id}`, label: record.name, group: 'Removed (restorable)',
        detail: record.removed?.snapshot ? 'snapshot kept' : 'clean when removed', tone: 'dim', data: { kind: 'removed', record }
      })
    }
    return rows
  }

  private async attempt(work: () => Promise<string | void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const message = await work()
      if (message) this.options.ui.notify(message, 'info')
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
    await this.reload()
  }

  async activateRow(row: Row): Promise<void> {
    const call = this.options.call
    const ui = this.options.ui
    switch (row.kind) {
      case 'new':
      case 'permanent':
        return this.attempt(async () => {
          const name = row.kind === 'permanent' ? await ui.input('Worktree name', 'lowercase-with-dashes') : undefined
          if (row.kind === 'permanent' && !name) return
          const result = await call<{ worktree: WorktreeRecord; setup: { state: string } }>('terminal.worktrees.create', { kind: row.kind === 'permanent' ? 'permanent' : 'managed', ...(name ? { name } : {}) })
          if (result.setup.state === 'untrusted') ui.notify('The repository has a setup script you have not trusted; it did not run.', 'warning')
          if (await ui.confirm(`Worktree ${result.worktree.name} is ready`, 'Switch this terminal there now? It starts a new conversation in that folder.')) {
            await call('terminal.worktrees.switch', { id: result.worktree.id })
            this.options.relaunch()
          }
        })
      case 'main':
        return this.attempt(async () => {
          await call('terminal.worktrees.switch', { main: true })
          this.options.relaunch()
        })
      case 'prune':
        return this.attempt(async () => {
          const result = await call<{ removed: unknown[] }>('terminal.worktrees.prune')
          return `Removed ${result.removed.length} older worktree(s); unsaved work was kept as snapshots.`
        })
      case 'trust':
        return this.attempt(async () => {
          if (!await ui.confirm('Trust the setup script?', 'Read .xharness/worktree-setup first. It will run in every new worktree of this repository until its text changes.')) return
          await call('terminal.worktrees.trustSetup')
          return 'Setup script trusted.'
        })
      case 'removed':
        return this.attempt(async () => {
          await call('terminal.worktrees.restore', { id: row.record.id })
          return `Restored ${row.record.name}.`
        })
      case 'worktree':
        return this.worktreeMenu(row.status)
    }
  }

  private async worktreeMenu(status: WorktreeStatus): Promise<void> {
    const record = status.record
    const current = this.overview?.current === record.id
    const choices = [
      ...(current ? [] : [WORKTREE_ACTIONS.switch]),
      ...(record.branch ? [] : [WORKTREE_ACTIONS.branch]),
      WORKTREE_ACTIONS.toSource,
      WORKTREE_ACTIONS.toWorktree,
      ...(current ? [] : [status.changes || status.ahead ? WORKTREE_ACTIONS.removeForce : WORKTREE_ACTIONS.remove])
    ]
    const choice = await this.options.ui.select(`${record.name} · ${record.path}`, choices)
    const call = this.options.call
    const id = record.id
    if (choice === WORKTREE_ACTIONS.switch) return this.attempt(async () => {
      await call('terminal.worktrees.switch', { id })
      this.options.relaunch()
    })
    if (choice === WORKTREE_ACTIONS.branch) return this.attempt(async () => {
      const name = await this.options.ui.input('Branch name', 'my-change')
      if (!name) return
      const updated = await call<WorktreeRecord>('terminal.worktrees.branch', { id, name })
      return `${record.name} is on branch ${updated.branch}.`
    })
    if (choice === WORKTREE_ACTIONS.toSource || choice === WORKTREE_ACTIONS.toWorktree) return this.attempt(async () => {
      const direction = choice === WORKTREE_ACTIONS.toSource ? 'toSource' : 'toWorktree'
      const result = await call<{ patched: boolean; copied: string[]; stash: string | null }>('terminal.worktrees.handoff', { id, direction })
      if (!result.patched && !result.copied.length) return 'Nothing to hand off.'
      return `Handed off.${result.stash ? ' The origin keeps a copy in git stash.' : ''}`
    })
    if (choice === WORKTREE_ACTIONS.remove || choice === WORKTREE_ACTIONS.removeForce) return this.attempt(async () => {
      const force = choice === WORKTREE_ACTIONS.removeForce
      if (force && !await this.options.ui.confirm(`Remove ${record.name}?`, 'Its unsaved changes and commits are kept as a snapshot you can restore from this page.')) return
      await call('terminal.worktrees.remove', { id, force })
      return `Removed ${record.name}.`
    })
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.error) return [theme.fg('error', `Could not read worktrees: ${this.error}`)]
    if (!this.overview) return [theme.fg('dim', 'Reading worktrees…')]
    if (!this.overview.repo) {
      return wrapTextWithAnsi(`Worktrees need a git repository. ${this.overview.reason ?? ''}`.trim(), width).slice(0, rows).map(line => theme.fg('dim', line))
    }
    const header = truncateToWidth(theme.fg('dim', `Repository ${this.overview.repo}`), width, '')
    return [header, '', ...this.list.render(width, Math.max(1, rows - 2))].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
