import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { AccountView, AccountsOverview } from '../../../accounts/store'
import { createHarnessTheme } from '../theme'
import { AccountsPage } from './accountsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const state = (health: string, extra: Record<string, unknown> = {}) => ({ health, signedIn: health === 'ok', authMethod: null, plan: 'pro', identity: 'work@example.com', limits: [{ id: '5h', label: '5h', usedPercent: 42, resetsAt: null }], lastError: null, lastCheckedAt: null, cliVersion: null, capabilities: [], piProviders: ['anthropic'], ...extra })
const account = (id: string, label: string, health: string, isDefault = false): AccountView => ({ id, label, isDefault, state: state(health) } as unknown as AccountView)

function setup(overview: AccountsOverview = {
  accounts: [account('a1', 'Work', 'ok', true), account('a2', 'Personal', 'auth_expired')],
  pools: [{ id: 'p1', provider: 'pi', label: 'Daily', accountIds: ['a1', 'a2'] }],
  defaults: {}
}, sessionId: string | null = 'a1') {
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    return method === 'accounts.list' ? structuredClone(overview) : undefined
  }) as unknown as ConstructorParameters<typeof AccountsPage>[0]['call']
  const ui = { select: vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined), confirm: vi.fn(async () => true), input: vi.fn(async () => undefined as string | undefined), notify: vi.fn(), selectGrouped: undefined as ((title: string, options: readonly { label: string; group?: string }[]) => Promise<string | undefined>) | undefined }
  const relaunch = vi.fn()
  const changed = vi.fn()
  const page = new AccountsPage({ theme: () => theme, call, session: () => sessionId ? { accountId: sessionId, label: 'Work' } : null, ui, relaunch, changed })
  page.focused = true
  return { page, call, calls, ui, relaunch, changed }
}
const plain = (page: AccountsPage, rows = 24, width = 80) => page.render(width, rows).map(stripTerminalSequences)
async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args)
  made.page.activate()
  await vi.waitFor(() => expect(plain(made.page).join('\n')).toContain('Work'))
  return made
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the Accounts page', () => {
  it('opens full screen, lists each account with its health and the session marked, and stacks details on compact layouts', async () => {
    const { page } = setup()
    expect(page.presentation).toBe('fullscreen')
    expect(plain(page).join('\n')).toContain('Reading accounts…')
    page.activate()
    await vi.waitFor(() => expect(plain(page).some(row => row.includes('Type to search'))).toBe(true))
    const rows = plain(page)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Accounts', 'Pools'])
    expect(rows).toContain('Accounts')
    expect(rows.some(row => row.startsWith('❯ ● Work') && row.endsWith('Ready · current'))).toBe(true)
    expect(rows.some(row => row.startsWith('  ○ Personal') && row.endsWith('Sign in again'))).toBe(true)
    expect(rows.some(row => row.includes('+ Add account'))).toBe(true)
    expect(rows.some(row => row.includes('Check all accounts'))).toBe(true)
    expect(rows.join('\n')).toContain('Health: Ready')
    expect(rows.join('\n')).toContain('Plan: pro')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('shortens the current-session status so account names stay visible on narrow terminals', async () => {
    const { page } = setup({ accounts: [account('a1', 'Verifier First', 'ok', true)], pools: [], defaults: {} })
    page.activate()
    await vi.waitFor(() => expect(plain(page, 16, 36).join('\n')).toContain('Verifier First'))
    expect(plain(page, 16, 36).some(row => row.endsWith('Ready · current'))).toBe(true)
  })

  it('shows account details beside the list on wide layouts', async () => {
    const { page } = await ready()
    const rows = plain(page, 36, 116)
    expect(rows.some(row => row.includes('❯ ● Work'))).toBe(true)
    expect(rows.join('\n')).toContain('Health: Ready')
    expect(rows.every(row => visibleWidth(row) <= 116)).toBe(true)
  })

  it('opens grouped account actions in the responsive inspector instead of a selector', async () => {
    const { page, ui } = await ready()
    const compactRows = plain(page)
    expect(compactRows.join('\n')).toContain('Health: Ready')
    page.handleInput('\r')
    const rows = plain(page).join('\n')
    expect(rows).toContain('Account')
    expect(rows).toContain('Rename')
    expect(rows).toContain('Sign-in')
    expect(rows).toContain('Remove a provider')
    expect(ui.select).not.toHaveBeenCalled()
  })

  it('enters a compact account detail subpage and returns to the same list selection', async () => {
    const { page, ui } = await ready()
    page.handleInput('\r')
    const detail = plain(page).join('\n')
    expect(detail).toContain('Health: Ready')
    expect(detail).toContain('Providers: anthropic')
    expect(detail).toContain('Account')
    expect(page.tabs().map(tab => tab.title)).toEqual(['Accounts', 'Pools'])
    expect(ui.select).not.toHaveBeenCalled()
    expect(page.handleInput('\x1b')).toBe(true)
    expect(plain(page).join('\n')).toContain('❯ ● Work')
  })

  it('opens the account inspector from mouse selection and runs an action in that panel', async () => {
    const { page, calls, ui } = await ready()
    const listRows = plain(page, 36, 116)
    const accountY = listRows.findIndex(row => row.includes('❯ ● Work'))
    page.handleMouse({ type: 'click', button: 'left', x: 5, y: accountY, screenX: 5, screenY: accountY, width: 116, height: 36, shift: false, alt: false, ctrl: false })
    const inspectorRows = plain(page, 36, 116)
    expect(inspectorRows.join('\n')).toContain('Sign-in')
    const checkY = inspectorRows.findIndex(row => row.slice(row.indexOf('│') + 1).trim() === 'Check')
    expect(checkY).toBeGreaterThanOrEqual(0)
    page.handleMouse({ type: 'click', button: 'left', x: 55, y: checkY, screenX: 55, screenY: checkY, width: 116, height: 36, shift: false, alt: false, ctrl: false })
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'accounts.refresh' && (params as { accountId?: string })?.accountId === 'a1')).toBe(true))
    expect(ui.select).not.toHaveBeenCalled()
  })

  it('opens compact account details by mouse and preserves the query when returning', async () => {
    const { page } = await ready()
    page.handleInput('work')
    const rows = plain(page, 24, 80)
    const accountY = rows.findIndex(row => row.includes('❯ ● Work'))
    page.handleMouse({ type: 'click', button: 'left', x: 5, y: accountY, screenX: 5, screenY: accountY, width: 80, height: 24, shift: false, alt: false, ctrl: false })
    expect(plain(page, 24, 80).join('\n')).toContain('Providers: anthropic')
    page.handleInput('\x1b')
    expect(plain(page, 24, 80).join('\n')).toContain('work')
    expect(plain(page, 24, 80).join('\n')).toContain('❯ ● Work')
  })

  it('preserves the account, search and section selection when the open detail view is resized', async () => {
    const { page } = await ready()
    page.handleInput('pers')
    page.handleInput('\r')
    expect(plain(page, 24, 80).join('\n')).toContain('Personal')
    expect(plain(page, 36, 116).join('\n')).toContain('Personal')
    expect(page.activeTab()).toBe('accounts')
    page.handleInput('\x1b')
    const rows = plain(page, 36, 116).join('\n')
    expect(rows).toContain('2 of 6')
    expect(rows).toContain('❯ ○ Personal')
  })

  it('moves to Pools from the focused tab strip and lists each pool with its order', async () => {
    const { page } = await ready()
    expect(page.handleInput('\t')).toBe(true)
    expect(page.handleInput('\x1b[C')).toBe(true)
    const rows = plain(page)
    expect(page.activeTab()).toBe('pools')
    expect(rows.some(row => row.startsWith('❯ Daily') && row.endsWith('Work → Personal'))).toBe(true)
    expect(rows.join('\n')).toContain('+ New pool')
    page.handleInput('\t')
    page.handleInput('\x1b[D')
    expect(plain(page).join('\n')).toContain('● Work')
  })

  it('shows only applicable actions and omits switching to the account already in use', async () => {
    const { page } = await ready()
    page.handleInput('\r')
    const rows = plain(page).join('\n')
    expect(rows).toContain('Rename')
    expect(rows).toContain('Activity')
    expect(rows).not.toContain('Use for this session')
    expect(rows).not.toContain('Make default for new sessions')
    expect(rows).not.toContain('Remove account')
  })

  it('makes an account the default, then reads the accounts again', async () => {
    const { page, calls } = await ready()
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'accounts.setDefault')).toBe(true))
    expect(calls.find(([method]) => method === 'accounts.setDefault')![1]).toEqual({ accountId: 'a2' })
    await vi.waitFor(() => expect(calls.filter(([method]) => method === 'accounts.list').length).toBeGreaterThan(1))
  })

  it('switches this session to another account only after asking, and tells the host to restart it', async () => {
    const { page, ui, relaunch, calls } = await ready()
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    page.handleInput('\r')
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce())
    expect(ui.confirm).toHaveBeenCalledWith('Switch this session?', expect.stringContaining('Personal'))
    expect(calls.find(([method]) => method === 'accounts.relaunch')![1]).toEqual({ accountId: 'a2' })

    const declined = await ready()
    declined.page.handleInput('\x1b[B')
    declined.page.handleInput('\r')
    declined.ui.confirm.mockResolvedValueOnce(false)
    declined.page.handleInput('\r')
    await settle(); await settle()
    expect(declined.relaunch).not.toHaveBeenCalled()
  })

  it('adds an account by name and checks every account', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\x1b[B'); page.handleInput('\x1b[B')
    ui.input.mockResolvedValueOnce('Spare')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'accounts.create')).toBe(true))
    expect(calls.find(([method]) => method === 'accounts.create')![1]).toEqual({ label: 'Spare', authKind: 'subscription' })
    await vi.waitFor(() => expect(plain(page).join('\n')).toContain('Work'))
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'accounts.refresh')).toBe(true))
  })

  it('opens a pool for editing or deleting, with a confirmation before it is removed', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    ui.select.mockResolvedValueOnce('Delete')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Delete Daily?', expect.any(String)))
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'accounts.removePool')).toBe(true))
    expect(calls.find(([method]) => method === 'accounts.removePool')![1]).toEqual({ poolId: 'p1' })
  })

  it('searches both sections, clears with Escape first, and reports a failed read or action', async () => {
    const { page, ui } = await ready()
    page.handleInput('pers')
    expect(plain(page).some(row => row.includes('of 6'))).toBe(true)
    expect(plain(page).join('\n')).toContain('Daily')
    expect(plain(page).some(row => row.includes('accounts and pools'))).toBe(true)
    expect(plain(page)).not.toContain('Searching accounts and pools')
    expect(page.handleInput('\x1b')).toBe(true)
    expect(page.handleInput('\x1b')).toBe(false)
    ui.select.mockRejectedValueOnce(new Error('Menu closed'))
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Menu closed', 'error'))
    const broken = setup()
    ;(broken.call as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket closed'))
    broken.page.activate()
    await vi.waitFor(() => expect(plain(broken.page).join('\n')).toContain('Could not read accounts: socket closed'))
  })

  it('never writes past the width, with wide labels and every size', async () => {
    const { page } = setup({ accounts: [account('a1', '日本語のアカウント 🧠', 'limited', true)], pools: [], defaults: {} })
    page.activate()
    await vi.waitFor(() => expect(plain(page).join('\n')).toContain('日本語のアカウント'))
    for (const rows of [0, 1, 4, 9, 30]) for (let width = 0; width <= 100; width++) {
      const lines = page.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })
})
