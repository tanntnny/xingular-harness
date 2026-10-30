import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, test } from 'vitest'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { Bus, type Notice } from '../core/bus'
import { Accounts, classifyMessage } from './accounts'
import { assertIsolated, configDir, ensureHome, ensureSharedDir, launchEnv, nativeConfig, sharedDir } from './env'
import { fileSecretStore, memorySecretStore, secretKey, withCredentialLock } from './secrets'
import { addAccount, audit, deriveHealth, emptyState, loadRegistry, loadState, resolve, saveRegistry, updateState, type Issue } from './store'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-accounts-'))
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
const HOUR = 3_600_000

function service(dir = temp()) {
  const secrets = memorySecretStore()
  const notices: Notice[] = []
  const bus = new Bus()
  bus.on((notice) => void notices.push(notice))
  return { dir, secrets, notices, accounts: new Accounts({ dir, secrets, bus }) }
}

function loginService(login: (interaction: {
  signal: AbortSignal
  notify: (notification: Record<string, unknown>) => void
  prompt: (prompt: { type: string; message: string; placeholder?: string; options?: unknown; signal?: AbortSignal }) => Promise<string>
}) => Promise<void>) {
  const dir = temp()
  const secrets = memorySecretStore()
  const notices: Notice[] = []
  const bus = new Bus()
  bus.on((notice) => void notices.push(notice))
  let loginOptions: { getDeviceId?: () => string } | undefined
  let loginCalls = 0
  const runtime = {
    login: (_provider: string, _method: string, interaction: Parameters<typeof login>[0], options?: { getDeviceId?: () => string }) => {
      loginCalls += 1
      loginOptions = options
      return login(interaction)
    }
  }
  class LoginAccounts extends Accounts {
    override runtime(account: Parameters<Accounts['runtime']>[0]): Promise<ModelRuntime> {
      void account
      return Promise.resolve(runtime as unknown as ModelRuntime)
    }
  }
  const accounts = new LoginAccounts({ dir, secrets, bus })
  const account = accounts.create('Login test', 'subscription').accounts[0]
  return { accounts, account, notices, loginOptions: () => loginOptions, loginCalls: () => loginCalls }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for the account operation.')
}

async function waitForLong(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for child processes.')
}

function runChild(source: string, env: NodeJS.ProcessEnv): { child: ReturnType<typeof spawn>; done: Promise<void> } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Credential-lock child failed (${signal ?? code}): ${stderr}`))
    })
  })
  return { child, done }
}

test('OpenAI login uses one persisted Harness installation device ID across accounts', async () => {
  const { accounts, account, loginOptions, loginCalls } = loginService(async () => {})
  const deviceId = await accounts.installationDeviceId()
  const second = accounts.create('Second account', 'subscription').accounts.find((item) => item.id !== account.id)!

  await accounts.loginStart(account.id, 'openai', 'oauth')
  await waitFor(() => loginCalls() === 1)
  expect(loginOptions()?.getDeviceId?.()).toBe(deviceId)

  await accounts.loginStart(second.id, 'openai', 'oauth')
  await waitFor(() => loginCalls() === 2)
  expect(loginOptions()?.getDeviceId?.()).toBe(deviceId)
  expect(JSON.parse(readFileSync(join(sharedDir(accounts.dir), 'settings.json'), 'utf8')).deviceId).toBe(deviceId)
  expect(deviceId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
})

test('device-code sign-in progress survives listener detachment and is available from status', async () => {
  const { accounts, account, notices } = loginService((interaction) => new Promise<void>((_resolve, reject) => {
    interaction.notify({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://example.test/device' })
    interaction.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))

  const { loginId } = await accounts.loginStart(account.id, 'openai-codex', 'oauth')
  await waitFor(() => (accounts.loginStatus(account.id)?.events.length ?? 0) > 0)
  const detached = accounts.loginStatus(account.id)
  expect(detached).toMatchObject({ loginId, status: 'running', events: [{ type: 'device_code', userCode: 'ABCD-EFGH' }] })
  expect(notices.find((notice) => notice.type === 'accounts.loginEvent')).toMatchObject({ revision: 1, loginId })

  // Asking again models a renderer returning to Accounts while the Harness stays alive.
  expect(accounts.loginStatus(account.id)).toEqual(detached)
  accounts.loginCancel(account.id, loginId)
  await waitFor(() => accounts.loginStatus(account.id)?.status === 'cancelled')
  const ended = accounts.loginStatus(account.id)
  expect(ended).toMatchObject({ loginId, status: 'cancelled', events: [], prompt: null, success: false })
  expect(JSON.stringify(ended)).not.toContain('ABCD-EFGH')
})

test('login status exposes the active prompt but never retains its response after completion', async () => {
  const { accounts, account, notices } = loginService(async (interaction) => {
    const value = await interaction.prompt({ type: 'secret', message: 'Enter the one-time value' })
    expect(value).toBe('private-response')
  })

  const { loginId } = await accounts.loginStart(account.id, 'provider-with-prompt', 'oauth')
  await waitFor(() => accounts.loginStatus(account.id)?.prompt !== null)
  const waiting = accounts.loginStatus(account.id)
  expect(waiting).toMatchObject({ loginId, status: 'running', prompt: { type: 'prompt', prompt: { type: 'secret' } } })
  const promptId = String(waiting?.prompt?.promptId)
  accounts.loginRespond(loginId, promptId, 'private-response')
  await waitFor(() => accounts.loginStatus(account.id)?.status === 'completed')
  const ended = accounts.loginStatus(account.id)
  expect(ended).toMatchObject({ loginId, status: 'completed', success: true, events: [], prompt: null })
  expect(JSON.stringify(ended)).not.toContain('private-response')
  expect(notices.filter((notice) => notice.type === 'accounts.loginEvent' || notice.type === 'accounts.login').map((notice) => notice.revision)).toEqual([1, 2, 3])
})

test('health reflects sign-in, errors and limits', () => {
  const state = { ...emptyState(), signedIn: true }
  expect(deriveHealth(state)).toBe('ok')
  state.limits.push({ id: '5h', label: '', usedPercent: 100, resetsAt: ago(-HOUR) })
  expect(deriveHealth(state)).toBe('limited')
  state.limits[0].resetsAt = ago(HOUR)
  expect(deriveHealth(state)).toBe('ok')
  state.lastError = { category: 'auth_expired', message: '', at: '', resetsAt: null }
  expect(deriveHealth(state)).toBe('auth_expired')
  state.lastError = null
  state.signedIn = false
  expect(deriveHealth(state)).toBe('signed_out')
})

test('a limit error without a reset time expires', () => {
  const issue = (at: number, resetsAt: number | null): Issue => ({ category: 'quota', message: 'usage limit', at: ago(at), resetsAt: resetsAt === null ? null : ago(-resetsAt) })
  const state = { ...emptyState(), signedIn: true }
  expect(deriveHealth({ ...state, lastError: issue(5 * 60_000, null) })).toBe('limited')
  expect(deriveHealth({ ...state, lastError: issue(96 * HOUR, null) })).toBe('ok')
  expect(deriveHealth({ ...state, lastError: issue(96 * HOUR, HOUR) })).toBe('limited')
})

test('resolve prefers explicit, then pool, then default, and never skips silently', () => {
  const dir = temp()
  expect(() => resolve(dir)).toThrow('Add a Pi account first.')
  const first = addAccount(dir, 'A', 'subscription')
  const second = addAccount(dir, 'B', 'subscription')
  expect(resolve(dir).id).toBe(first.id)
  expect(resolve(dir, second.id).id).toBe(second.id)
  // An account of a provider the harness no longer runs is kept in the file and never chosen.
  const registry = loadRegistry(dir)
  registry.accounts.push({ id: 'legacy', provider: 'codex', label: 'Old', authKind: 'subscription', createdAt: '' })
  registry.pools.push({ id: 'p', provider: 'pi', label: 'Work', accountIds: [first.id, second.id] })
  saveRegistry(dir, registry)
  expect(() => resolve(dir, 'legacy')).toThrow('another provider')
  expect(loadRegistry(dir).accounts).toHaveLength(3)

  updateState(dir, first.id, (state) => void (state.signedIn = false))
  expect(resolve(dir, null, 'p').id).toBe(second.id)
  updateState(dir, second.id, (state) => void (state.lastError = { category: 'auth_expired', message: '', at: '', resetsAt: null }))
  expect(() => resolve(dir, null, 'p')).toThrow('Every account in Work is unavailable.')
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]))
}

test('audit and state never hold secrets', async () => {
  const { dir, accounts } = service()
  audit(dir, 'a', 'login.failed', 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rejected')
  const text = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
  expect(text).not.toContain('abcdefghijklmnop')
  expect(text).toContain('[redacted]')

  const account = addAccount(dir, 'A', 'apiKey')
  await accounts.writeCredential(account.id, 'anthropic', { type: 'api_key', key: 'sk-secret-value' })
  expect((await accounts.readCredential(account.id, 'anthropic'))?.key).toBe('sk-secret-value')
  for (const file of walk(dir)) expect(readFileSync(file, 'utf8')).not.toContain('sk-secret-value')
  expect((await accounts.listCredentials(account.id))[0].type).toBe('api_key')
  await expect(accounts.writeCredential(account.id, '../x', null)).rejects.toThrow('Invalid provider name.')
})

test('a failed terminal credential launch can retry without a stale reference count', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'api_key', key: 'probe' })
  const auth = join(configDir(dir, account), 'auth.json')
  mkdirSync(auth)
  await expect(accounts.terminalBegin(account)).rejects.toThrow('not readable')
  expect(accounts.terminalCount(account.id)).toBe(0)
  rmdirSync(auth)
  await accounts.terminalBegin(account)
  expect(accounts.terminalCount(account.id)).toBe(1)
  await accounts.terminalEnd(account)
  expect(accounts.terminalCount(account.id)).toBe(0)
})

test('a terminal keeps no auth.json and leaves the stored credentials as they are', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'api_key', key: 'k1' })
  await accounts.terminalBegin(account)
  const auth = join(configDir(dir, account), 'auth.json')
  expect(existsSync(auth)).toBe(false)
  await accounts.writeCredential(account.id, 'deepseek', { type: 'api_key', key: 'k-late' })
  await accounts.terminalEnd(account)
  expect(existsSync(auth)).toBe(false)
  expect(loadState(dir, account.id).piProviders).toEqual(['deepseek', 'openai'])
  expect((await accounts.readCredential(account.id, 'openai'))?.key).toBe('k1')
})

test('an auth.json an older terminal left is folded in without replacing a newer token', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'oauth', access: 'a5', refresh: 'r5', expires: 5 })
  await accounts.writeCredential(account.id, 'deepseek', { type: 'api_key', key: 'stored' })
  const auth = join(configDir(dir, account), 'auth.json')
  writeFileSync(auth, JSON.stringify({
    openai: { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2 },
    deepseek: { type: 'api_key', key: 'file' },
    anthropic: { type: 'oauth', access: 'n', refresh: 'rn', expires: 9 }
  }))
  await accounts.terminalBegin(account)
  expect(existsSync(auth)).toBe(false)
  expect((await accounts.readCredential(account.id, 'openai'))?.refresh).toBe('r5')
  expect((await accounts.readCredential(account.id, 'deepseek'))?.key).toBe('stored')
  expect((await accounts.readCredential(account.id, 'anthropic'))?.refresh).toBe('rn')
  await accounts.terminalEnd(account)
})

test('a newer token in an auth.json an older terminal left is saved, and the file stays while another process uses it', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 })
  const auth = join(configDir(dir, account), 'auth.json')
  const leases = join(dir, account.id, 'terminal-leases')
  mkdirSync(leases, { recursive: true })
  // The parent process stands in for an older Harness whose terminal still reads auth.json.
  const other = join(leases, String(process.ppid))
  writeFileSync(other, '{}')
  await accounts.terminalBegin(account)
  writeFileSync(auth, JSON.stringify({ openai: { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2 } }))
  await accounts.terminalEnd(account)
  expect((await accounts.readCredential(account.id, 'openai'))?.refresh).toBe('r2')
  expect(existsSync(auth)).toBe(true)
  rmSync(other)
  await accounts.terminalBegin(account)
  expect(existsSync(auth)).toBe(false)
  await accounts.terminalEnd(account)
})

test('a lease left by a process that has ended is removed and does not keep the account busy', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  const leases = join(dir, account.id, 'terminal-leases')
  mkdirSync(leases, { recursive: true })
  writeFileSync(join(leases, '2147483646'), '{}')
  writeFileSync(join(configDir(dir, account), 'auth.json'), '{}')
  await accounts.terminalBegin(account)
  expect(existsSync(join(leases, '2147483646'))).toBe(false)
  expect(existsSync(join(configDir(dir, account), 'auth.json'))).toBe(false)
  await accounts.terminalEnd(account)
})

/** The terminal side of `accounts.credentials.*`, as the host's socket handlers answer it. */
function terminalCalls(accounts: Accounts, accountId: string) {
  return async (call: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    switch (call) {
      case 'accounts.credentials.read': return { credential: (await accounts.readCredential(accountId, params.provider as string)) ?? null }
      case 'accounts.credentials.list': return { credentials: await accounts.listCredentials(accountId) }
      case 'accounts.credentials.lease': {
        const lease = await accounts.leaseCredential(accountId, params.provider as string)
        return { leaseId: lease.leaseId, current: lease.current ?? null }
      }
      case 'accounts.credentials.commit': return { credential: (await accounts.commitCredentialLease(accountId, params.leaseId as string, params.credential as never)) ?? null }
      case 'accounts.credentials.delete': await accounts.writeCredential(accountId, params.provider as string, null); return {}
      default: throw new Error(`Unexpected call ${call}`)
    }
  }
}

test('terminals and the host refresh one OAuth token once, under one lock', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'subscription')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'oauth', access: 'a1', refresh: 'r1', expires: Date.now() - 1 })
  // Like OpenAI: a refresh token works once. Like Pi: the expiry is checked again under the lock.
  const spent = new Set<string>()
  let refreshes = 0
  const refresh = async (current: Record<string, unknown> | undefined) => {
    if (!current || (current.expires as number) > Date.now()) return undefined
    if (spent.has(current.refresh as string)) throw new Error('OpenAI OAuth token request failed (400): {"error": "invalid_grant"}')
    spent.add(current.refresh as string)
    refreshes += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { type: 'oauth' as const, access: `a${refreshes + 1}`, refresh: `r${refreshes + 1}`, expires: Date.now() + HOUR }
  }
  const { terminalCredentialStore } = await import('../terminal/credentialStore')
  const first = terminalCredentialStore(terminalCalls(accounts, account.id) as never)
  const second = terminalCredentialStore(terminalCalls(accounts, account.id) as never)
  const results = await Promise.all([
    first.modify('openai', refresh as never),
    accounts.modifyCredential(account.id, 'openai', refresh as never),
    second.modify('openai', refresh as never)
  ])
  expect(refreshes).toBe(1)
  expect(results.map((credential) => (credential as { refresh?: string } | undefined)?.refresh)).toEqual(['r2', 'r2', 'r2'])
  expect(((await first.read('openai')) as { refresh?: string } | undefined)?.refresh).toBe('r2')
  expect((await first.list()).map((item) => item.providerId)).toEqual(['openai'])
})

test('a terminal sign-in, sign-out and failed refresh go through the store', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'subscription')
  ensureHome(dir, account)
  const { terminalCredentialStore } = await import('../terminal/credentialStore')
  const terminal = terminalCredentialStore(terminalCalls(accounts, account.id) as never)
  await terminal.modify('openai', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }) as never)
  expect((await accounts.readCredential(account.id, 'openai'))?.refresh).toBe('r')
  await expect(terminal.modify('openai', async () => { throw new Error('refresh failed') })).rejects.toThrow('refresh failed')
  expect((await accounts.readCredential(account.id, 'openai'))?.refresh).toBe('r')
  await terminal.delete('openai')
  expect(await accounts.readCredential(account.id, 'openai')).toBeNull()
})

test('an abandoned credential lease releases the lock and changes nothing', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'api_key', key: 'k1' })
  const lease = await accounts.leaseCredential(account.id, 'openai', 30)
  expect(lease.current?.key).toBe('k1')
  const other = addAccount(dir, 'B', 'apiKey')
  await expect(accounts.commitCredentialLease(other.id, lease.leaseId, { type: 'api_key', key: 'stolen' })).rejects.toThrow('lease has ended')
  // Waits for the abandoned lease to time out, then runs.
  await accounts.modifyCredential(account.id, 'openai', async () => ({ type: 'api_key', key: 'k2' }))
  expect((await accounts.readCredential(account.id, 'openai'))?.key).toBe('k2')
  await expect(accounts.commitCredentialLease(account.id, lease.leaseId, { type: 'api_key', key: 'late' })).rejects.toThrow('lease has ended')
  expect((await accounts.readCredential(account.id, 'openai'))?.key).toBe('k2')
})

test('creating, renaming and removing an account is audited and announced', async () => {
  const { dir, accounts, secrets, notices } = service()
  const created = accounts.create('  Work  ', 'apiKey').accounts[0]
  expect([created.label, created.isDefault, created.state.health]).toEqual(['Work', true, 'unknown'])
  expect(lstatSync(join(configDir(dir, created), 'skills')).isSymbolicLink()).toBe(true)
  await accounts.writeCredential(created.id, 'openai', { type: 'api_key', key: 'k' })
  expect(() => accounts.create('', 'apiKey')).toThrow()
  expect(() => accounts.create('x', 'password')).toThrow('Unknown sign-in type.')
  accounts.rename(created.id, 'Home')
  await accounts.remove(created.id)
  expect(accounts.overview().accounts).toEqual([])
  expect(existsSync(join(dir, created.id))).toBe(false)
  expect(secrets.values.size).toBe(0)
  expect(notices.filter((notice) => notice.type === 'accounts.changed').length).toBeGreaterThanOrEqual(3)
  expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toContain('account.deleted')
})

test('run events move an account between healthy and limited', () => {
  const { dir, accounts, notices } = service()
  const account = addAccount(dir, 'A', 'subscription')
  const event = (type: string, payload: unknown) => ({ id: 'e', runId: 'r', sessionId: 's', sequence: 0, timestamp: '', type: type as never, payload })
  accounts.onRunEvent(event('account.status', { accountId: account.id, category: 'quota', message: 'usage limit reached for sk-abcdefghijklmnopqrstuvwxyz012345' }), null)
  const limited = loadState(dir, account.id)
  expect(limited.health).toBe('limited')
  expect(limited.lastError?.message).toContain('[redacted]')
  expect(notices.at(-1)).toMatchObject({ type: 'accounts.changed', health: 'limited', previous: 'unknown' })
  // A finished run proves the sign-in works, but a limit error stays until it resets.
  accounts.onRunEvent(event('completed', {}), { accountId: account.id } as never)
  expect(loadState(dir, account.id)).toMatchObject({ signedIn: true, health: 'limited' })
  accounts.onRunEvent(event('account.status', { accountId: account.id, category: 'auth_expired', message: '401' }), null)
  expect(loadState(dir, account.id)).toMatchObject({ signedIn: false, health: 'auth_expired' })
  accounts.onRunEvent(event('completed', {}), { accountId: account.id } as never)
  expect(loadState(dir, account.id).health).toBe('ok')
})

test('provider errors are classified', () => {
  expect(classifyMessage('401 Unauthorized')).toBe('auth_expired')
  expect(classifyMessage('You have hit your usage limit')).toBe('quota')
  expect(classifyMessage('429 Too Many Requests')).toBe('rate_limited')
  expect(classifyMessage('fetch failed')).toBe('network')
  expect(classifyMessage('the model said no')).toBeNull()
})

test('a rejected OAuth refresh requests reauthentication and keeps the credential', async () => {
  const { dir, accounts } = service()
  const account = accounts.create('OpenAI', 'subscription').accounts[0]
  await accounts.writeCredential(account.id, 'openai', { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 0 })
  accounts.runtime = async () => ({
    listCredentials: async () => [{ providerId: 'openai', type: 'oauth' }],
    getAvailable: async () => { throw new Error('OAuth refresh failed for openai: OpenAI OAuth token request failed (400): {"error":"invalid_grant"}') }
  } as unknown as ModelRuntime)

  await accounts.refreshOne(account)

  expect(loadState(dir, account.id)).toMatchObject({ health: 'auth_expired', lastError: { category: 'auth_expired' } })
  expect(await accounts.readCredential(account.id, 'openai')).toMatchObject({ refresh: 'old-refresh' })
})

test('native config lists what is shared and what exists', () => {
  const dir = temp()
  const before = nativeConfig(dir)
  expect(before.entries.some((entry) => entry.name === 'extensions' && entry.directory)).toBe(true)
  expect(before.entries.every((entry) => !entry.present)).toBe(true)
  expect(existsSync(before.path)).toBe(false)
  writeFileSync(join(ensureSharedDir(dir), 'AGENTS.md'), 'x')
  expect(nativeConfig(dir).entries.find((entry) => entry.name === 'AGENTS.md')?.present).toBe(true)
})

test('launch env isolates and strips inherited credentials', () => {
  const dir = temp()
  const env = launchEnv(dir, { id: 'acc1' }, { SOMEVENDOR_API_KEY: 'leak', PATH: '/bin' })
  expect(env.PI_CODING_AGENT_DIR?.startsWith(dir)).toBe(true)
  expect(env).toMatchObject({ SOMEVENDOR_API_KEY: null, CLAUDE_CONFIG_DIR: null, CODEX_HOME: null })
  expect('PATH' in env).toBe(false)
})

test('accounts share config but not credentials', () => {
  const dir = temp()
  const first = ensureHome(dir, { id: 'acc1' })
  const second = ensureHome(dir, { id: 'acc2' })
  writeFileSync(join(first, 'settings.json'), '{"theme":"dark"}\n')
  mkdirSync(join(first, 'skills/review'), { recursive: true })
  writeFileSync(join(first, 'auth.json'), '{}')
  expect(readFileSync(join(second, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n')
  expect(statSync(join(second, 'skills/review')).isDirectory()).toBe(true)
  expect(existsSync(join(second, 'auth.json'))).toBe(false)
  expect(lstatSync(join(first, 'auth.json')).isSymbolicLink()).toBe(false)
  expect(readlinkSync(join(first, 'skills'))).toBe(join(sharedDir(dir), 'skills'))
})

test('existing account config moves into the shared folder, newest wins', async () => {
  const dir = temp()
  for (const id of ['acc1', 'acc2']) {
    mkdirSync(configDir(dir, { id }), { recursive: true })
    writeFileSync(join(configDir(dir, { id }), 'settings.json'), `{"from":"${id}"}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  ensureHome(dir, { id: 'acc1' })
  // acc2's settings are newer than the shared copy acc1 just moved in, so they win.
  const second = ensureHome(dir, { id: 'acc2' })
  expect(readFileSync(join(sharedDir(dir), 'settings.json'), 'utf8')).toBe('{"from":"acc2"}')
  expect(readdirSync(sharedDir(dir)).some((name) => name.startsWith('settings.json.xagent-backup-'))).toBe(true)
  expect(lstatSync(join(second, 'settings.json')).isSymbolicLink()).toBe(true)
})

test('refuses default tool directories', () => {
  const dir = temp()
  for (const name of ['.codex', '.claude', '.pi/agent']) expect(() => assertIsolated(dir, join(homedir(), name))).toThrow()
  expect(() => assertIsolated(dir, '/tmp/elsewhere')).toThrow()
  expect(() => assertIsolated(dir, join(dir, 'a/home/pi'))).not.toThrow()
})

test('a file secret store keeps secrets owner-only', async () => {
  const path = join(temp(), 'nested/secrets.json')
  const secrets = fileSecretStore(path)
  expect(await secrets.get('a/b')).toBeNull()
  await secrets.set('a/b', 'value')
  expect(await secrets.get('a/b')).toBe('value')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  await secrets.delete('a/b')
  expect(await secrets.get('a/b')).toBeNull()
})

test('provider credential modifications serialize across Harness processes', async () => {
  const dir = temp()
  const account = addAccount(dir, 'Cross-process test', 'apiKey')
  const secretPath = join(dir, 'test-secrets.json')
  const secrets = fileSecretStore(secretPath)
  await secrets.set(secretKey(account.id, 'pi-auth/test-provider'), JSON.stringify({ type: 'oauth', history: [], count: 0 }))

  const bundlePath = join(dir, 'accounts-lock-test.mjs')
  const bundled = await build({
    stdin: {
      contents: "export { Accounts } from './src/accounts/accounts.ts'\nexport { fileSecretStore } from './src/accounts/secrets.ts'",
      resolveDir: process.cwd(),
      sourcefile: 'accounts-lock-test.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    outfile: bundlePath
  })
  writeFileSync(bundlePath, bundled.outputFiles[0]!.contents, { mode: 0o600 })

  const syncDir = join(dir, 'sync')
  mkdirSync(syncDir)
  const source = `
    import { existsSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { setTimeout as delay } from 'node:timers/promises'
    import { pathToFileURL } from 'node:url'
    const { Accounts, fileSecretStore } = await import(pathToFileURL(process.env.TEST_BUNDLE).href)
    const accounts = new Accounts({
      dir: process.env.TEST_ACCOUNTS_DIR,
      secrets: fileSecretStore(process.env.TEST_SECRET_PATH),
      bus: { emit() {} },
      credentialLock: { timeoutMs: 5000, pollMs: 2 }
    })
    const tag = process.env.TEST_TAG
    const sync = process.env.TEST_SYNC_DIR
    const wait = async path => { while (!existsSync(path)) await delay(5) }
    writeFileSync(join(sync, tag + '.ready'), 'ready')
    await wait(join(sync, 'start'))
    writeFileSync(join(sync, tag + '.attempt'), 'attempt')
    await accounts.modifyCredential(process.env.TEST_ACCOUNT_ID, 'test-provider', async current => {
      writeFileSync(join(sync, tag + '.entered'), 'entered')
      await wait(join(sync, 'release'))
      const history = Array.isArray(current?.history) ? current.history : []
      return { type: 'oauth', history: [...history, tag], count: Number(current?.count ?? 0) + 1 }
    })
  `
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TEST_BUNDLE: bundlePath,
    TEST_ACCOUNTS_DIR: dir,
    TEST_SECRET_PATH: secretPath,
    TEST_ACCOUNT_ID: account.id,
    TEST_SYNC_DIR: syncDir
  }
  const tags = ['left', 'right']
  const workers = tags.map(tag => runChild(source, { ...baseEnv, TEST_TAG: tag }))

  try {
    await waitForLong(() => tags.every(tag => existsSync(join(syncDir, `${tag}.ready`))))
    writeFileSync(join(syncDir, 'start'), 'go')
    await waitForLong(() => tags.every(tag => existsSync(join(syncDir, `${tag}.attempt`))))
    await waitForLong(() => tags.some(tag => existsSync(join(syncDir, `${tag}.entered`))))
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    if (!existsSync(join(syncDir, 'start'))) writeFileSync(join(syncDir, 'start'), 'go')
    if (!existsSync(join(syncDir, 'release'))) writeFileSync(join(syncDir, 'release'), 'go')
    await Promise.allSettled(workers.map(worker => worker.done))
  }
  await Promise.all(workers.map(worker => worker.done))

  const saved = JSON.parse((await secrets.get(secretKey(account.id, 'pi-auth/test-provider'))) ?? 'null')
  expect(saved).toMatchObject({ type: 'oauth', count: 2 })
  expect(saved.history.sort()).toEqual(tags)
  expect(loadState(dir, account.id).piProviders).toEqual(['test-provider'])
})

test('credential locks recover dead participants and bound waiting without writing', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'Lock test', 'apiKey')
  const lockKey = `provider/${account.id}/test-provider`
  const lockFolder = join(dir, '.credential-locks', createHash('sha256').update(lockKey).digest('hex'))
  const stale = join(lockFolder, `2147483646-${randomUUID()}`)
  mkdirSync(stale, { recursive: true })

  await accounts.writeCredential(account.id, 'test-provider', { type: 'api_key', key: 'fake-test-key' })
  expect(existsSync(stale)).toBe(false)

  const heldKey = `provider/${account.id}/blocked-provider`
  let release!: () => void
  let entered!: () => void
  const acquired = new Promise<void>(resolve => { entered = resolve })
  const holder = withCredentialLock(join(dir, '.credential-locks'), heldKey, () => new Promise<void>(resolve => {
    release = resolve
    entered()
  }), { timeoutMs: 1000, pollMs: 1 })
  await acquired

  const blocked = new Accounts({ dir, secrets: memorySecretStore(), bus: new Bus(), credentialLock: { timeoutMs: 20, pollMs: 1 } })
  await expect(blocked.writeCredential(account.id, 'blocked-provider', { type: 'api_key', key: 'must-not-write' })).rejects.toThrow('Timed out waiting for credential modification')
  expect(await blocked.readCredential(account.id, 'blocked-provider')).toBeNull()
  release()
  await holder
})
