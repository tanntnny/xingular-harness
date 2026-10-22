import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AccountsOverview, AccountView } from '../accounts/store'
import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'
import { accountDetails, accountRows, resetIn, runAccountsMenu, type AccountsCall, type AccountsUi, type SessionAccount } from './accountsMenu'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

/**
 * A person at the terminal. Each answer picks the first option that contains it (select), or
 * is the typed text (input), or is the yes/no (confirm). A select with no matching option fails
 * the test, so a changed menu label shows up here.
 */
function person(answers: (string | boolean | undefined)[]) {
  const shown: string[] = []
  const said: { message: string; level?: string }[] = []
  const next = () => answers.shift()
  const ui: AccountsUi = {
    select: async (title, options) => {
      shown.push(title)
      const answer = next()
      if (answer === undefined) return undefined
      const found = options.find((option) => option.includes(String(answer)))
      if (!found) throw new Error(`No option containing "${answer}" in: ${options.join(' | ')}`)
      return found
    },
    confirm: async (title) => {
      shown.push(title)
      return next() === true
    },
    input: async (title) => {
      shown.push(title)
      const answer = next()
      return typeof answer === 'string' ? answer : undefined
    },
    notify: (message, level) => void said.push({ message, level })
  }
  return { ui, shown, said, remaining: () => answers.length }
}

function view(id: string, label: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    provider: 'pi',
    label,
    authKind: 'subscription',
    createdAt: '2026-10-01T00:00:00.000Z',
    isDefault: false,
    state: { health: 'unknown', signedIn: null, authMethod: null, plan: null, identity: null, limits: [], lastError: null, lastCheckedAt: null, cliVersion: null, capabilities: [], piProviders: [] },
    ...overrides
  }
}

describe('the accounts menu, without a terminal', () => {
  it('numbers each account, marks the default and this session, and shows its health', () => {
    const overview: AccountsOverview = {
      accounts: [view('a1', 'Main', { isDefault: true, state: { ...view('a1', 'Main').state, health: 'limited' } }), view('a2', 'Spare')],
      pools: [],
      defaults: { pi: 'a1' }
    }
    const rows = accountRows(overview, { accountId: 'a2', label: 'Spare' } satisfies SessionAccount)
    expect(rows.map((row) => row.label)).toEqual(['1. ● Main · Limit reached', '2. ○ Spare · Not checked · this session'])
    expect(rows[1].account.id).toBe('a2')
  })

  it('says what the account can do and that providers do not report usage when none is reported', () => {
    const text = accountDetails(view('a1', 'Main', { state: { ...view('a1', 'Main').state, health: 'auth_expired', piProviders: ['anthropic'], lastError: { category: 'rate_limited', message: 'Slow down.', at: '2026-10-01T00:00:00.000Z', resetsAt: null } } }))
    expect(text).toContain('Health: Sign in again')
    expect(text).toContain('Providers: anthropic')
    expect(text).toContain('Last error: Slow down.')
    expect(text).toContain('Pi providers do not report them.')
  })

  it('formats a reset time as a short countdown', () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z')
    expect(resetIn('2026-10-01T00:05:00.000Z', now)).toBe('in 5m')
    expect(resetIn('2026-10-01T02:30:00.000Z', now)).toBe('in 2h 30m')
    expect(resetIn('2026-10-03T00:00:00.000Z', now)).toBe('in 2d')
    expect(resetIn('2026-09-30T00:00:00.000Z', now)).toBe('now')
  })
})

async function session() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'accounts-menu-'))
  writeFile(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\ndescription: Always test.\n---\nAlways run the tests.\n')
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore(), assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js', openTui: '/opt/harness/terminal-opentui.js' } })
  open.push(harness)
  const main = harness.accounts.create('Main', 'apiKey').accounts[0]
  const spare = harness.accounts.create('Spare', 'apiKey').accounts.find((account) => account.label === 'Spare')!
  const launch = await harness.terminals.prepare({ sessionId: 'term-1', accountId: main.id, cwd: base, sessionFolder: join(root, 'sessions', 'term-1') })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  // The extension claims the key before the model runs; the menu uses it for every change.
  const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
  const call: AccountsCall = (method, params) => socketCall(connection, method, params ?? {}, 5_000, key)
  return { harness, main, spare, connection, key, call }
}

describe('the accounts menu, over the session socket', () => {
  it('refuses account calls from the shell token, and serves them to the extension with its key', async () => {
    const { connection, key, main, harness } = await session()
    await expect(socketCall(connection, 'accounts.list')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(socketCall(connection, 'accounts.list', {}, 5_000, 'guessed')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(socketCall(connection, 'accounts.deviceId')).rejects.toMatchObject({ code: 'unauthorized' })
    const listed = await socketCall<AccountsOverview>(connection, 'accounts.list', {}, 5_000, key)
    expect(listed.accounts.map((account) => account.id)).toContain(main.id)
    expect(await socketCall<{ accountId: string; label: string }>(connection, 'accounts.session', {}, 5_000, key)).toEqual({ accountId: main.id, label: 'Main' })
    expect(await socketCall(connection, 'accounts.deviceId', {}, 5_000, key)).toBe(await harness.accounts.installationDeviceId())
  })

  it('keeps each mode choice on the session account, and refuses it without the control key', async () => {
    const { connection, key, call, main, spare, harness } = await session()
    await expect(socketCall(connection, 'accounts.choices.get')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(socketCall(connection, 'accounts.choices.set', { mode: 'plan', effort: 'low' })).rejects.toMatchObject({ code: 'unauthorized' })
    await call('accounts.choices.set', { mode: 'normal', model: 'anthropic/fast', effort: 'high' })
    // A caller names no account: the call always lands on this terminal's own account.
    await call('accounts.choices.set', { mode: 'plan', effort: 'low', accountId: spare.id })
    expect(await socketCall(connection, 'accounts.choices.get', {}, 5_000, key)).toMatchObject({ normal: { model: 'anthropic/fast', effort: 'high' }, plan: { effort: 'low' } })
    expect(harness.accounts.choices(spare.id)).toEqual({})
    expect(harness.accounts.choices(main.id)).toMatchObject({ plan: { effort: 'low' } })
  })

  it('will not remove an account a running terminal is using, this session included', async () => {
    const { call, main, spare, harness } = await session()
    await expect(call('accounts.remove', { accountId: main.id })).rejects.toMatchObject({ code: 'account_in_use' })
    expect(harness.accounts.find(main.id).id).toBe(main.id)
    // An account with no terminal on it is removed as usual.
    await call('accounts.remove', { accountId: spare.id })
    expect(() => harness.accounts.find(spare.id)).toThrow()
  })

  it('makes an account the default from the menu', async () => {
    const { call, harness, spare, main } = await session()
    const { ui, said } = person(['Spare', 'Make default', 'Back', 'Done'])
    expect(await runAccountsMenu(ui, call, { accountId: main.id, label: 'Main' })).toBeUndefined()
    expect(harness.accounts.overview().defaults.pi).toBe(spare.id)
    expect(said.map((entry) => entry.message)).toContain('Spare is the default for new sessions.')
  })

  it('switches this session to another account by ending Pi, and leaves the choice for the launcher', async () => {
    const { call, harness, spare, main } = await session()
    const { ui } = person(['Spare', 'Use for this session', true])
    const outcome = await runAccountsMenu(ui, call, { accountId: main.id, label: 'Main' })
    expect(outcome).toBe('relaunch')
    expect(harness.terminals.takeRelaunch('term-1')).toEqual({ accountId: spare.id, nativeSessionId: null })
    // Taken once: a second read finds nothing.
    expect(harness.terminals.takeRelaunch('term-1')).toBeNull()
  })

  it('does not switch when the person declines the confirmation', async () => {
    const { call, harness, spare, main } = await session()
    const { ui } = person(['Spare', 'Use for this session', false, 'Back', 'Done'])
    expect(await runAccountsMenu(ui, call, { accountId: main.id, label: 'Main' })).toBeUndefined()
    expect(harness.terminals.takeRelaunch('term-1')).toBeNull()
    expect(harness.accounts.find(spare.id).id).toBe(spare.id)
  })
})

describe('signing in from the accounts menu', () => {
  it('shows structured OAuth choices and returns the selected provider choice ID', async () => {
    const overview: AccountsOverview = { accounts: [view('a1', 'Main')], pools: [], defaults: { pi: 'a1' } }
    const answered: Record<string, unknown>[] = []
    const statuses = [
      { loginId: 'L2', revision: 1, status: 'running', events: [], prompt: { type: 'prompt', promptId: 'P2', prompt: { type: 'select', message: 'Select OpenAI Codex login method:', options: [{ id: 'device_code', label: 'Device code login' }, { id: 'browser', label: 'Browser login' }] } }, success: null, error: null, accountId: 'a1', provider: 'openai-codex', method: 'oauth' },
      { loginId: 'L2', revision: 2, status: 'completed', events: [], prompt: null, success: true, error: null, accountId: 'a1', provider: 'openai-codex', method: 'oauth' }
    ]
    const call = (async (method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case 'accounts.list':
          return overview
        case 'accounts.providers':
          return [{ id: 'openai-codex', name: 'OpenAI Codex', oauth: true, oauthLabel: 'Sign in with ChatGPT', apiKey: false }]
        case 'accounts.loginStart':
          return { loginId: 'L2' }
        case 'accounts.loginStatus':
          return statuses.shift()
        case 'accounts.loginRespond':
          answered.push(params!)
          return {}
        default:
          throw new Error(`unexpected ${method}`)
      }
    }) as unknown as AccountsCall
    const script = person(['Main', 'Sign in', 'OpenAI Codex', 'Device code login', 'Back', 'Done'])

    expect(await runAccountsMenu(script.ui, call, { accountId: 'a1', label: 'Main' })).toBeUndefined()

    expect(answered).toEqual([{ loginId: 'L2', promptId: 'P2', value: 'device_code' }])
    expect(script.shown).toContain('Select OpenAI Codex login method:')
  })

  it('follows a browser sign-in, answers its prompt, and reports the result', async () => {
    const overview: AccountsOverview = { accounts: [view('a1', 'Main')], pools: [], defaults: { pi: 'a1' } }
    const answered: Record<string, unknown>[] = []
    const statuses = [
      { loginId: 'L1', revision: 1, status: 'running', events: [{ type: 'auth_url', url: 'https://auth.example/start' }], prompt: null, success: null, error: null, accountId: 'a1', provider: 'anthropic', method: 'oauth' },
      { loginId: 'L1', revision: 2, status: 'running', events: [], prompt: { type: 'prompt', promptId: 'P1', prompt: { type: 'secret', message: 'Paste the code', placeholder: null, options: null } }, success: null, error: null, accountId: 'a1', provider: 'anthropic', method: 'oauth' },
      { loginId: 'L1', revision: 3, status: 'completed', events: [], prompt: null, success: true, error: null, accountId: 'a1', provider: 'anthropic', method: 'oauth' }
    ]
    const call = (async (method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case 'accounts.list':
          return overview
        case 'accounts.session':
          return { accountId: 'a1', label: 'Main' }
        case 'accounts.providers':
          return [{ id: 'anthropic', name: 'Anthropic', oauth: true, oauthLabel: 'Claude', apiKey: false }]
        case 'accounts.loginStart':
          expect(params).toEqual({ accountId: 'a1', provider: 'anthropic' })
          return { loginId: 'L1' }
        case 'accounts.loginStatus':
          return statuses.shift()
        case 'accounts.loginRespond':
          answered.push(params!)
          return {}
        default:
          throw new Error(`unexpected ${method}`)
      }
    }) as unknown as AccountsCall
    // Account, then Sign in, then the provider; one sign-in method means no second pick. The
    // browser step is answered with "Check status", and the prompt is typed as '123'.
    const script = person(['Main', 'Sign in', 'Anthropic', 'Check status', '123', 'Back', 'Done'])
    expect(await runAccountsMenu(script.ui, call, { accountId: 'a1', label: 'Main' })).toBeUndefined()
    expect(answered).toEqual([{ loginId: 'L1', promptId: 'P1', value: '123' }])
    expect(script.said.map((entry) => entry.message)).toContain('Signed in.')
    expect(script.remaining()).toBe(0)
  })
})
