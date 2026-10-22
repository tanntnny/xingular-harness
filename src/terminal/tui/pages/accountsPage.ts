/**
 * The Accounts page: one row per account with its health, the selected account's details beneath,
 * and Pools as a second section. Enter on an account opens its actions; the actions themselves are
 * the ones the `/accounts` menu of a native `pi` session uses.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

import type { AccountView, AccountsOverview } from '../../../accounts/store'
import {
  HEALTH, accountActions, accountDetails, addAccount, editPool, runAccountAction,
  type AccountsCall, type AccountsUi, type SessionAccount
} from '../../accountsMenu'
import { safeText } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow, type RowTone } from '../list'
import type { TerminalMouseInput } from '../mouse'

export interface AccountsPageOptions {
  theme: () => Theme
  call: AccountsCall
  /** The account this session runs on. */
  session: () => SessionAccount | null
  ui: AccountsUi
  /** The session is switching accounts: the host ends it so the launcher can start it again. */
  relaunch(): void
  changed(): void
}

const SECTIONS = [{ id: 'accounts', title: 'Accounts' }, { id: 'pools', title: 'Pools' }] as const
const ADD = 'action:add'
const CHECK_ALL = 'action:check-all'
const NEW_POOL = 'action:new-pool'
const BACK = 'Back'

const HEALTH_TONE: Record<string, RowTone> = { ok: 'success', limited: 'warning', auth_expired: 'error', signed_out: 'error', error: 'error', unknown: 'dim' }

export class AccountsPage implements TerminalPage {
  private overview: AccountsOverview | undefined
  private error: string | undefined
  private section: typeof SECTIONS[number]['id'] = 'accounts'
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>

  constructor(private readonly options: AccountsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['row', 'rows'], empty: 'Nothing here yet',
      searchContext: () => 'accounts and pools',
      onActivate: row => { void this.activateRow(row) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs() { return SECTIONS }
  activeTab(): string { return this.section }
  hint(): string { return this.list.query ? 'Enter open · Esc clear' : 'Enter actions · type to search' }

  private async reload(): Promise<void> {
    try {
      this.overview = await this.options.call<AccountsOverview>('accounts.list')
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.fill()
    this.options.changed()
  }

  /** Searching looks through accounts and pools together; otherwise the page shows the current section. */
  private fill(): void {
    this.list.setRows(this.list.query ? [...this.accountRows(), ...this.poolRows()] : this.section === 'accounts' ? this.accountRows() : this.poolRows())
  }

  private accountRows(): ListRow<string>[] {
    const overview = this.overview
    if (!overview) return []
    const session = this.options.session()
    const accounts: ListRow<string>[] = overview.accounts.map(account => ({
      id: `account:${account.id}`, group: 'Accounts',
      label: `${account.isDefault ? '●' : '○'} ${safeText(account.label)}`,
      detail: `${HEALTH[account.state.health] ?? HEALTH.unknown}${session?.accountId === account.id ? ' · this session' : ''}`,
      tone: HEALTH_TONE[account.state.health] ?? 'dim',
      searchText: `${account.label} ${account.state.identity ?? ''} ${HEALTH[account.state.health] ?? ''}`
    }))
    return [
      ...accounts,
      { id: ADD, label: '+ Add account', group: 'Actions', tone: 'accent' },
      { id: CHECK_ALL, label: '⟳ Check all accounts', group: 'Actions', tone: 'accent' }
    ]
  }

  private poolRows(): ListRow<string>[] {
    const overview = this.overview
    if (!overview) return []
    const names = new Map(overview.accounts.map(account => [account.id, account.label]))
    return [
      ...overview.pools.map(pool => ({
        id: `pool:${pool.id}`, group: 'Pools', label: safeText(pool.label),
        detail: pool.accountIds.map(id => names.get(id) ?? 'removed account').join(' → '), tone: 'muted' as const
      })),
      { id: NEW_POOL, label: '+ New pool', group: 'Actions', tone: 'accent' }
    ]
  }

  private account(id: string): AccountView | undefined { return this.overview?.accounts.find(account => `account:${account.id}` === id) }

  /** Runs one thing at a time and always reads the accounts again afterwards. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await work() } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally { this.busy = false }
    await this.reload()
  }

  private activateRow(row: ListRow<string>): Promise<void> {
    return this.guarded(async () => {
      const { ui, call } = this.options
      const overview = this.overview
      if (!overview) return
      if (row.id === ADD) { await addAccount(ui, call); return }
      if (row.id === CHECK_ALL) { try { await call('accounts.refresh') } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') } return }
      if (row.id === NEW_POOL) { await editPool(ui, call, overview, null); return }
      const pool = overview.pools.find(candidate => `pool:${candidate.id}` === row.id)
      if (pool) {
        const action = await ui.select(pool.label, ['Edit', 'Delete', BACK])
        if (action === 'Edit') await editPool(ui, call, overview, pool)
        else if (action === 'Delete' && await ui.confirm(`Delete ${pool.label}?`, 'The accounts stay. Only the pool is removed.')) {
          try { await call('accounts.removePool', { poolId: pool.id }) } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') }
        }
        return
      }
      const account = this.account(row.id)
      if (!account) return
      const isSession = this.options.session()?.accountId === account.id
      const action = await ui.select(`${account.label} · ${HEALTH[account.state.health] ?? HEALTH.unknown}`, [...accountActions(account, isSession, false), BACK])
      if (!action || action === BACK) return
      const outcome = await runAccountAction(ui, call, overview, account, action)
      if (outcome === 'relaunch') this.options.relaunch()
    })
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) { this.section = this.section === 'accounts' ? 'pools' : 'accounts'; this.fill() }
      return true
    }
    const before = this.list.query
    const used = this.list.handleInput(data)
    if (this.list.query !== before) this.fill()
    return used
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.overview) return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read accounts: ${this.error}` : 'Reading accounts…')]
    const selected = this.section === 'accounts' ? this.account(this.list.selected?.id ?? '') : undefined
    const details = selected ? accountDetails(selected).split('\n').slice(1) : []
    // The list gets the rows it needs first; the details take what is left.
    const detailRows = Math.min(details.length, 9, Math.max(0, rows - 2 - this.list.height))
    const lines = this.list.render(width, Math.max(2, rows - 1 - (detailRows ? detailRows + 1 : 0)))
    if (detailRows) lines.push('', ...details.slice(0, detailRows).map(line => theme.fg('muted', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
