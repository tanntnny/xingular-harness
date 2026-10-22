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
  const ui = { select: vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined), confirm: vi.fn(async () => true), input: vi.fn(async () => undefined as string | undefined), notify: vi.fn() }
  const relaunch = vi.fn()
  const changed = vi.fn()
  const page = new AccountsPage({ theme: () => theme, call, session: () => sessionId ? { accountId: sessionId, label: 'Work' } : null, ui, relaunch, changed })
  page.focused = true
  return { page, call, calls, ui, relaunch, changed }
}
const plain = (page: AccountsPage, rows = 24, width = 90) => page.render(width, rows).map(stripTerminalSequences)
async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args)
  made.page.activate()
  await vi.waitFor(() => expect(plain(made.page).join('\n')).toContain('Work'))
  return made
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the Accounts page', () => {
  it('says it is reading, then lists each account with its health and the session marked, and the details beneath', async () => {
    const { page } = setup()
    expect(plain(page).join('\n')).toContain('Reading accounts…')
    page.activate()
    await vi.waitFor(() => expect(plain(page).some(row => row.includes('Type to search'))).toBe(true))
    const rows = plain(page)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Accounts', 'Pools'])
    expect(rows).toContain('Accounts')
    expect(rows.some(row => row.startsWith('❯ ● Work') && row.endsWith('Ready · this session'))).toBe(true)
    expect(rows.some(row => row.startsWith('  ○ Personal') && row.endsWith('Sign in again'))).toBe(true)
    expect(rows.some(row => row.includes('+ Add account'))).toBe(true)
    expect(rows.some(row => row.includes('Check all accounts'))).toBe(true)
    expect(rows.join('\n')).toContain('Health: Ready')
    expect(rows.join('\n')).toContain('Plan: pro')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('moves to Pools with Tab and lists each pool with its order, plus a way to make one', async () => {
    const { page } = await ready()
    expect(page.handleInput('\t')).toBe(true)
    const rows = plain(page)
    expect(rows.some(row => row.startsWith('❯ Daily') && row.endsWith('Work → Personal'))).toBe(true)
    expect(rows.join('\n')).toContain('+ New pool')
    page.handleInput('\x1b[Z')
    expect(plain(page).join('\n')).toContain('● Work')
  })

  it('offers the actions that apply, leaving out switching to the account already in use and the Details the page shows', async () => {
    const { page, ui } = await ready()
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalled())
    const [title, options] = ui.select.mock.calls[0]!
    expect(title).toBe('Work · Ready')
    expect(options).toEqual(['Rename', 'Check', 'Activity', 'Sign in', 'Remove a provider', 'Sign out', 'Back'])
  })

  it('makes an account the default, then reads the accounts again', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\x1b[B')
    ui.select.mockResolvedValueOnce('Make default for new sessions')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'accounts.setDefault')).toBe(true))
    expect(calls.find(([method]) => method === 'accounts.setDefault')![1]).toEqual({ accountId: 'a2' })
    await vi.waitFor(() => expect(calls.filter(([method]) => method === 'accounts.list').length).toBeGreaterThan(1))
  })

  it('switches this session to another account only after asking, and tells the host to restart it', async () => {
    const { page, ui, relaunch, calls } = await ready()
    page.handleInput('\x1b[B')
    ui.select.mockResolvedValueOnce('Use for this session (restarts it)')
    page.handleInput('\r')
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce())
    expect(ui.confirm).toHaveBeenCalledWith('Switch this session?', expect.stringContaining('Personal'))
    expect(calls.find(([method]) => method === 'accounts.relaunch')![1]).toEqual({ accountId: 'a2' })

    const declined = await ready()
    declined.page.handleInput('\x1b[B')
    declined.ui.select.mockResolvedValueOnce('Use for this session (restarts it)')
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
