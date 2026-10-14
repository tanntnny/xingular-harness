import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { Bus, type Notice } from '../core/bus'
import { Accounts, classifyMessage } from './accounts'
import { assertIsolated, configDir, ensureHome, ensureSharedDir, launchEnv, nativeConfig, sharedDir } from './env'
import { fileSecretStore, memorySecretStore } from './secrets'
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
  await expect(accounts.terminalBegin(account)).rejects.toThrow()
  rmdirSync(auth)
  await accounts.terminalBegin(account)
  expect(statSync(auth).isFile()).toBe(true)
  expect(statSync(auth).mode & 0o777).toBe(0o600)
  await accounts.terminalEnd(account)
  expect(existsSync(auth)).toBe(false)
})

test('a terminal round-trips credentials through auth.json', async () => {
  const { dir, accounts } = service()
  const account = addAccount(dir, 'A', 'apiKey')
  ensureHome(dir, account)
  await accounts.writeCredential(account.id, 'openai', { type: 'api_key', key: 'k1' })
  await accounts.terminalBegin(account)
  const auth = join(configDir(dir, account), 'auth.json')
  expect(readFileSync(auth, 'utf8')).toContain('k1')
  writeFileSync(auth, JSON.stringify({ anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }))
  await accounts.terminalEnd(account)
  expect(existsSync(auth)).toBe(false)
  expect(loadState(dir, account.id).piProviders).toEqual(['anthropic'])
  expect((await accounts.readCredential(account.id, 'anthropic'))?.refresh).toBe('r')
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
