/**
 * The Accounts page: one row per account with its health and Pools as a second section. Opening
 * an account shows its details and grouped actions in a wide inspector or a compact detail page;
 * the actions themselves are the ones the `/accounts` menu of a native `pi` session uses.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { AccountView, AccountsOverview } from '../../../accounts/store'
import {
  HEALTH, accountActions, accountDetails, addAccount, editPool, runAccountAction,
  type AccountsCall, type AccountsUi, type SessionAccount
} from '../../accountsMenu'
import { safeText } from '../chrome'
import type { GroupedSelectOption } from '../dialogs'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow, type RowTone } from '../list'
import type { TerminalMouseInput } from '../mouse'

export interface AccountsPageOptions {
  theme: () => Theme
  call: AccountsCall
  /** The account this session runs on. */
  session: () => SessionAccount | null
  ui: AccountsUi & {
    selectGrouped?(title: string, options: readonly GroupedSelectOption[]): Promise<string | undefined>
  }
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
  readonly presentation = 'fullscreen'
  readonly ownsNavigation = true
  private overview: AccountsOverview | undefined
  private error: string | undefined
  private section: typeof SECTIONS[number]['id'] = 'accounts'
  private focus: 'tabs' | 'list' | 'actions' = 'list'
  private detailOpen = false
  private detailAccountId: string | undefined
  private busy = false
  private disposed = false
  private compact = false
  private wideListWidth = 0
  private actionRowsStart = 0
  private readonly list: FilterList<string>
  private readonly actionList: FilterList<string>

  constructor(private readonly options: AccountsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['row', 'rows'], empty: 'Nothing here yet',
      searchContext: () => 'accounts and pools',
      onActivate: row => this.activateRow(row)
    })
    this.actionList = new FilterList<string>({
      theme: options.theme, search: 'never', noun: ['action', 'actions'],
      onActivate: row => { if (row.data) void this.activateAction(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused || this.actionList.focused }
  set focused(value: boolean) { this.list.focused = value && this.focus === 'list'; this.actionList.focused = value && this.focus === 'actions' }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs() { return SECTIONS }
  activeTab(): string { return this.section }
  selectTab(id: string): void {
    if (!SECTIONS.some(tab => tab.id === id)) return
    this.section = id as typeof this.section
    this.detailOpen = false
    this.detailAccountId = undefined
    this.focus = 'list'
    this.list.focused = true
    this.actionList.focused = false
    this.fill()
    this.options.changed()
  }
  hint(): string {
    if (this.compact && this.detailOpen) return '↑/↓ actions · Enter activate'
    if (this.focus === 'actions') return '↑/↓ actions · Enter activate · Tab focus'
    return this.list.query ? 'Tab focus · Enter open · Esc clear' : 'Tab focus · ←/→ sections · Enter open'
  }

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
  private fill(compact = this.compact): void {
    this.compact = compact
    this.list.setRows(this.list.query ? [...this.accountRows(), ...this.poolRows()] : this.section === 'accounts' ? this.accountRows() : this.poolRows())
    const account = this.detailOpen ? this.detailAccount() : undefined
    if (account) this.fillActions(account)
  }

  private accountRows(): ListRow<string>[] {
    const overview = this.overview
    if (!overview) return []
    const session = this.options.session()
    const accounts: ListRow<string>[] = overview.accounts.map(account => ({
      id: `account:${account.id}`, group: 'Accounts',
      label: `${account.isDefault ? '●' : '○'} ${safeText(account.label)}`,
      detail: `${HEALTH[account.state.health] ?? HEALTH.unknown}${session?.accountId === account.id ? ` · ${this.compact ? 'current' : 'this session'}` : ''}`,
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
  private detailAccount(): AccountView | undefined { return this.detailAccountId ? this.overview?.accounts.find(account => account.id === this.detailAccountId) : undefined }

  private selectGrouped(title: string, options: readonly GroupedSelectOption[]): Promise<string | undefined> {
    return this.options.ui.selectGrouped
      ? this.options.ui.selectGrouped(title, options)
      : this.options.ui.select(title, options.map(option => option.label))
  }

  private accountActionGroup(label: string): string | undefined {
    if (label.startsWith('Use for this session') || label === 'Make default for new sessions') return 'Session'
    if (['Rename', 'Check', 'Activity'].includes(label)) return 'Account'
    if (['Sign in', 'Remove a provider', 'Sign out'].includes(label)) return 'Sign-in'
    if (label === 'Remove account') return 'Remove'
    return undefined
  }

  private fillActions(account: AccountView): void {
    const isSession = this.options.session()?.accountId === account.id
    this.actionList.setRows(accountActions(account, isSession, false).map(label => ({
      id: label, label, group: this.accountActionGroup(label), data: label
    })))
    this.actionList.focused = this.focus === 'actions'
  }

  private detailLines(width: number, summary = false): string[] {
    const theme = this.options.theme()
    const account = this.detailOpen ? this.detailAccount() : this.section === 'accounts' ? this.account(this.list.selected?.id ?? '') : undefined
    let title: string
    let lines: string[]
    if (account) {
      title = account.label
      if (summary) {
        const state = account.state
        const signedIn = state.signedIn === null ? 'not checked' : state.signedIn ? 'yes' : 'no'
        lines = [
          `Health: ${HEALTH[state.health] ?? HEALTH.unknown} · Default: ${account.isDefault ? 'yes' : 'no'} · Signed in: ${signedIn}`,
          `Providers: ${state.piProviders.length ? state.piProviders.join(', ') : 'none'}`,
          ...(state.identity ? [`Identity: ${state.identity}`] : []),
          ...(state.plan ? [`Plan: ${state.plan}`] : []),
          `Last checked: ${state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : 'never'}`,
          ...state.limits.map(limit => `${limit.label}: ${limit.usedPercent ?? '?'}% used${limit.resetsAt ? `, resets ${new Date(limit.resetsAt).toLocaleString()}` : ''}`),
          ...(state.limits.length ? [] : ['Usage limits: not reported']),
          ...(state.capabilities.length ? [`Detected: ${state.capabilities.join(', ')}`] : []),
          ...(state.lastError ? [`Last error: ${state.lastError.message}`] : [])
        ]
      } else {
        lines = accountDetails(account).split('\n').slice(1)
      }
    } else if (this.section === 'pools') {
      const pool = this.overview?.pools.find(item => `pool:${item.id}` === this.list.selected?.id)
      const names = new Map(this.overview?.accounts.map(item => [item.id, item.label]) ?? [])
      title = pool ? `Pool · ${pool.label}` : 'Pools'
      lines = pool
        ? ['New sessions use the first ready account in this order:', ...pool.accountIds.map((id, index) => `${index + 1}. ${names.get(id) ?? 'removed account'}`)]
        : ['Select a pool to see its account order.']
    } else {
      title = 'Account details'
      lines = ['Select an account to see health and usage details.']
    }
    const wrap = (text: string) => wrapTextWithAnsi(safeText(text), Math.max(1, width))
    return [theme.bold(theme.fg('accent', safeText(title))), ...lines.flatMap(wrap).map(line => theme.fg('muted', line))]
  }

  /** Runs one thing at a time and always reads the accounts again afterwards. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try { await work() } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally { this.busy = false }
    await this.reload()
  }

  private closeDetails(): void {
    this.detailOpen = false
    this.detailAccountId = undefined
    this.focus = 'list'
    this.list.focused = true
    this.actionList.focused = false
    this.options.changed()
  }

  private openDetails(): void {
    const account = this.account(this.list.selected?.id ?? '')
    if (!account) return
    this.detailOpen = true
    this.detailAccountId = account.id
    this.focus = 'actions'
    this.list.focused = false
    this.fillActions(account)
    this.options.changed()
  }

  private activateRow(row: ListRow<string>): void {
    if (this.account(row.id)) {
      this.openDetails()
      return
    }
    void this.guarded(async () => {
      const { ui, call } = this.options
      const overview = this.overview
      if (!overview) return
      if (row.id === ADD) { await addAccount(ui, call); return }
      if (row.id === CHECK_ALL) { try { await call('accounts.refresh') } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') } return }
      if (row.id === NEW_POOL) { await editPool(ui, call, overview, null); return }
      const pool = overview.pools.find(candidate => `pool:${candidate.id}` === row.id)
      if (!pool) return
      const action = await this.selectGrouped(pool.label, [
        { label: 'Edit', group: 'Manage' }, { label: 'Delete', group: 'Remove' }, { label: BACK }
      ])
      if (action === 'Edit') await editPool(ui, call, overview, pool)
      else if (action === 'Delete' && await ui.confirm(`Delete ${pool.label}?`, 'The accounts stay. Only the pool is removed.')) {
        try { await call('accounts.removePool', { poolId: pool.id }) } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') }
      }
    })
  }

  private async activateAction(action: string): Promise<void> {
    if (this.busy) return
    const account = this.detailAccount()
    const overview = this.overview
    if (!account || !overview) return
    await this.guarded(async () => {
      const outcome = await runAccountAction(this.options.ui, this.options.call, overview, account, action)
      if (outcome === 'relaunch') this.options.relaunch()
      if (outcome === 'gone') {
        this.detailOpen = false
        this.detailAccountId = undefined
        this.focus = 'list'
        this.list.focused = true
        this.actionList.focused = false
      }
    })
  }

  private moveSection(delta: number): void {
    const index = SECTIONS.findIndex(tab => tab.id === this.section)
    this.section = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]!.id
    this.detailOpen = false
    this.detailAccountId = undefined
    this.focus = 'list'
    this.list.focused = true
    this.actionList.focused = false
    this.fill()
    this.options.changed()
  }

  handleMouse(event: TerminalMouseInput) {
    if (this.compact && this.detailOpen) {
      this.focus = 'actions'
      this.actionList.focused = true
      return this.actionList.handleMouse({ ...event, y: event.y - this.actionRowsStart })
    }
    if (this.wideListWidth && event.x >= this.wideListWidth + 3) {
      if (!this.detailOpen) return undefined
      this.focus = 'actions'
      this.actionList.focused = true
      return this.actionList.handleMouse({ ...event, x: event.x - this.wideListWidth - 3, y: event.y - this.actionRowsStart })
    }
    this.focus = 'list'
    this.actionList.focused = false
    this.list.focused = true
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'escape')) {
      if (this.detailOpen) { this.closeDetails(); return true }
      if (this.focus !== 'list') { this.focus = 'list'; this.list.focused = true; this.actionList.focused = false; this.options.changed(); return true }
      return this.list.handleInput(data)
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const order: ('tabs' | 'list' | 'actions')[] = this.compact && this.detailOpen
        ? ['tabs', 'actions']
        : this.detailOpen ? ['tabs', 'list', 'actions'] : ['tabs', 'list']
      const index = order.indexOf(this.focus)
      const step = matchesKey(data, 'shift+tab') ? -1 : 1
      this.focus = order[(index + step + order.length) % order.length]!
      this.list.focused = this.focus === 'list'
      this.actionList.focused = this.focus === 'actions'
      this.options.changed()
      return true
    }
    if (this.focus === 'tabs') {
      if (matchesKey(data, 'left')) { this.moveSection(-1); return true }
      if (matchesKey(data, 'right')) { this.moveSection(1); return true }
      if (matchesKey(data, 'enter')) {
        this.focus = this.compact && this.detailOpen ? 'actions' : 'list'
        this.list.focused = this.focus === 'list'
        this.actionList.focused = this.focus === 'actions'
        this.options.changed()
        return true
      }
      return false
    }
    if (this.focus === 'actions') return this.actionList.handleInput(data)
    const before = this.list.query
    const used = this.list.handleInput(data)
    if (this.list.query !== before) this.fill()
    return used
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.overview) return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read accounts: ${this.error}` : 'Reading accounts…')]

    const compact = width < 88
    if (compact !== this.compact) this.fill(compact)
    if (compact && this.detailOpen && this.detailAccount()) {
      const details = this.detailLines(width, true)
      this.actionRowsStart = details.length + 1
      const actions = this.actionList.render(width, Math.max(1, rows - this.actionRowsStart))
      return [...details, '', ...actions].slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }

    if (!compact) {
      this.wideListWidth = Math.min(width - 36, Math.max(32, Math.floor((width - 3) * 0.42)))
      const detailWidth = Math.max(1, width - this.wideListWidth - 3)
      const list = this.list.render(this.wideListWidth, rows)
      const details = this.detailLines(detailWidth)
      let inspector = details
      const account = this.detailOpen ? this.detailAccount() : undefined
      if (this.detailOpen && account) {
        this.fillActions(account)
        this.actionRowsStart = inspector.length + 1
        inspector = [...inspector, '', ...this.actionList.render(detailWidth, Math.max(1, rows - this.actionRowsStart))]
      }
      inspector = inspector.slice(0, rows)
      return Array.from({ length: Math.min(rows, Math.max(list.length, inspector.length)) }, (_, index) => {
        const left = truncateToWidth(list[index] ?? '', this.wideListWidth, '')
        const right = truncateToWidth(inspector[index] ?? '', detailWidth, '')
        const gap = ' '.repeat(Math.max(0, this.wideListWidth - visibleWidth(left)))
        return truncateToWidth(`${left}${gap}${theme.fg('dim', ' │ ')}${right}`, width, '')
      })
    }

    this.wideListWidth = 0
    const details = this.detailLines(width).slice(1)
    const detailRows = Math.min(details.length, 9, Math.max(0, rows - 2 - this.list.height))
    const lines = this.list.render(width, Math.max(2, rows - 1 - (detailRows ? detailRows + 1 : 0)))
    if (detailRows) lines.push('', ...details.slice(0, detailRows))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
