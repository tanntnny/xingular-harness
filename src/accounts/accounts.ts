// The accounts service: everything that needs the secret store, the Pi runtime, or a notice.
// Credentials go to the embedding application's secret store; nothing here writes one to the
// harness's own files, except a terminal session's `auth.json` while that terminal runs.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { log, type Bus } from '../core/bus'
import { HarnessError, invalid } from '../core/errors'
import { atomicWrite, now, readJson, safeId } from '../core/fs'
import { loadPi } from '../pi/runtime'
import type { RunEvent, RunRecord } from '../sessions/contracts'
import * as choices from './choices'
import * as env from './env'
import { secretKey, withCredentialLock, type CredentialLockOptions, type SecretStore } from './secrets'
import * as store from './store'
import type { Account, AccountsOverview, Issue, Limit, ProviderLimitState } from './store'

export type IssueCategory = 'auth_expired' | 'rate_limited' | 'quota' | 'network' | 'unknown'

/** Best-effort classification of a provider error message. */
export function classifyMessage(message: string): IssueCategory | null {
  const text = message.toLowerCase()
  if (/\b401\b|unauthori[sz]ed|invalid (api )?key|invalid x-api-key|authentication|not logged in|log ?in again|expired token|token (has )?expired|refresh token|oauth/.test(text)) return 'auth_expired'
  if (/usage limit|quota|insufficient_quota|billing|credit balance|out of credits/.test(text)) return 'quota'
  if (/\b429\b|rate.?limit|too many requests/.test(text)) return 'rate_limited'
  if (/econnrefused|enotfound|etimedout|network|socket hang up|fetch failed/.test(text)) return 'network'
  return null
}

export interface ModelOption {
  id: string
  name: string
  provider: string
  supportsImages: boolean
  reasoning: boolean
}

type Credential = Record<string, unknown> & { type: 'api_key' | 'oauth' }

/** The lease files of an account: one per process that has a terminal on it. */
const leaseFolder = (dir: string, accountId: string): string => join(dir, accountId, 'terminal-leases')

/** Whether a process with this id exists. One that exists but belongs to another user still counts. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The credentials in an auth.json, or null when there is no readable file. */
function readAuth(path: string): Record<string, Credential> | null {
  try {
    const parsed = readJson<Record<string, Credential>>(path)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Compares two credentials by their fields, not their key order, which Pi may change when it rewrites the file. */
function sameCredential(a: Credential | undefined, b: Credential | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
}

function validProvider(provider: string): string {
  if (provider && provider.length <= 64 && /^[A-Za-z0-9._-]+$/.test(provider)) return provider
  throw invalid('Invalid provider name.')
}

interface PendingLogin {
  accountId: string
  provider: string
  method: 'oauth' | 'api_key'
  cancel: () => void
  prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>
  revision: number
  events: Record<string, unknown>[]
  prompt: Record<string, unknown> | null
}

export interface AccountLoginSnapshot {
  accountId: string
  loginId: string
  provider: string
  method: string
  revision: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  events: Record<string, unknown>[]
  prompt: Record<string, unknown> | null
  success: boolean | null
  error: string | null
}

interface Probe {
  signedIn: boolean | null
  authMethod: string | null
  plan: string | null
  identity: string | null
  limits?: Limit[]
  capabilities: string[]
}

export interface AccountsOptions {
  /** `<state dir>/accounts`. */
  dir: string
  secrets: SecretStore
  bus: Bus
  credentialLock?: CredentialLockOptions
}

export class Accounts {
  readonly dir: string
  private readonly secrets: SecretStore
  private readonly bus: Bus
  private readonly credentialLockOptions: CredentialLockOptions
  private readonly runtimes = new Map<string, Promise<ModelRuntime>>()
  private readonly logins = new Map<string, PendingLogin>()
  private readonly latestLogins = new Map<string, AccountLoginSnapshot>()
  /** How many of this process's terminals use each account's auth.json. */
  private readonly terminals = new Map<string, number>()
  /** The credentials this process wrote to, or found in, each account's auth.json when its first terminal began. */
  private readonly terminalSnapshots = new Map<string, Record<string, Credential>>()
  private installationDeviceIdPromise: Promise<string> | null = null
  /**
   * Lets the limits service observe each account runtime's provider responses. The Harness sets
   * it once; with none, a runtime behaves exactly as before.
   */
  observeModels: ((models: unknown, accountId: string) => void) | null = null

  constructor(options: AccountsOptions) {
    this.dir = options.dir
    this.secrets = options.secrets
    this.bus = options.bus
    this.credentialLockOptions = options.credentialLock ?? {}
  }

  private changed(payload: Record<string, unknown> = {}): void {
    this.bus.emit({ type: 'accounts.changed', ...payload })
  }

  overview(): AccountsOverview {
    return store.overview(this.dir)
  }

  find(accountId: string): Account {
    return store.find(this.dir, accountId)
  }

  /** The model and effort each mode last used on this account. */
  choices(accountId: string): Record<string, choices.ModeChoice> {
    this.find(accountId)
    return choices.readChoices(this.dir, accountId)
  }

  /** Records a mode's model or effort on this account. Every selection counts, session-only ones too. */
  choose(accountId: string, mode: string, patch: choices.ChoicePatch): Record<string, choices.ModeChoice> {
    this.find(accountId)
    return choices.saveChoice(this.dir, accountId, mode, patch)
  }

  /** The account a new session uses; a session that already has one passes it and keeps it. */
  resolve(accountId?: string | null, poolId?: string | null): Account {
    return store.resolve(this.dir, accountId, poolId)
  }

  context(account: Account): env.AccountContext {
    return env.accountContext(this.dir, account)
  }

  // ---- Stored credentials -----------------------------------------------------------------

  async readCredential(accountId: string, provider: string): Promise<Credential | null> {
    this.find(accountId)
    const text = await this.secrets.get(secretKey(accountId, `pi-auth/${validProvider(provider)}`))
    if (!text) return null
    try {
      return JSON.parse(text) as Credential
    } catch {
      return null
    }
  }

  private credentialLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    return withCredentialLock(join(this.dir, '.credential-locks'), key, work, this.credentialLockOptions)
  }

  /** Stores a provider's credential, or removes it when `credential` is `null`. */
  async writeCredential(accountId: string, provider: string, credential: Credential | null): Promise<void> {
    this.find(accountId)
    const name = validProvider(provider)
    await this.credentialLock(`provider/${accountId}/${name}`, () => this.persistCredential(accountId, name, credential))
  }

  /** The entire refresh read/modify/write is coordinated across services and processes. */
  async modifyCredential(accountId: string, provider: string, change: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    this.find(accountId)
    const name = validProvider(provider)
    return this.credentialLock(`provider/${accountId}/${name}`, async () => {
      const current = (await this.readCredential(accountId, name)) ?? undefined
      const updated = await change(current)
      if (updated !== undefined) await this.persistCredential(accountId, name, updated)
      return updated ?? current
    })
  }

  private async persistCredential(accountId: string, name: string, credential: Credential | null): Promise<void> {
    // Different providers still share the account's provider index. Keep its short commit serialized.
    await this.credentialLock(`account/${accountId}`, async () => {
      this.find(accountId)
      if (credential === null) await this.secrets.delete(secretKey(accountId, `pi-auth/${name}`))
      else await this.secrets.set(secretKey(accountId, `pi-auth/${name}`), JSON.stringify(credential))
      store.updateState(this.dir, accountId, (state) => {
        state.piProviders = state.piProviders.filter((existing) => existing !== name)
        if (credential !== null) state.piProviders = [...state.piProviders, name].sort()
      })
    })
  }

  async listCredentials(accountId: string): Promise<{ providerId: string; type: 'api_key' | 'oauth' }[]> {
    this.find(accountId)
    const listed: { providerId: string; type: 'api_key' | 'oauth' }[] = []
    for (const provider of store.loadState(this.dir, accountId).piProviders) {
      const credential = await this.readCredential(accountId, provider).catch(() => null)
      if (credential && typeof credential.type === 'string') listed.push({ providerId: provider, type: credential.type })
    }
    return listed
  }

  /** Pi and explicit account edits share the same cross-process credential lock. */
  private credentialStore(accountId: string) {
    return {
      read: async (providerId: string) => (await this.readCredential(accountId, providerId)) ?? undefined,
      list: () => this.listCredentials(accountId),
      modify: (providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) => this.modifyCredential(accountId, providerId, change),
      delete: (providerId: string) => this.writeCredential(accountId, providerId, null)
    }
  }

  /** Pi's OAuth device ID belongs to this Harness installation, not to one isolated account. */
  installationDeviceId(): Promise<string> {
    if (!this.installationDeviceIdPromise) {
      this.installationDeviceIdPromise = this.loadInstallationDeviceId().catch((error: unknown) => {
        this.installationDeviceIdPromise = null
        throw error
      })
    }
    return this.installationDeviceIdPromise
  }

  private async loadInstallationDeviceId(): Promise<string> {
    const { SettingsManager } = await loadPi()
    const settings = SettingsManager.create(process.cwd(), env.ensureSharedDir(this.dir))
    const deviceId = settings.getOrCreateDeviceId()
    await settings.flush()
    return deviceId
  }

  // ---- The Pi runtime ---------------------------------------------------------------------

  /** The lazily loaded Pi runtime of one account: its models and its credentials. Pi's own `~/.pi` is never used. */
  runtime(account: env.AccountContext | Account): Promise<ModelRuntime> {
    const id = account.id
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      const configDir = 'configDir' in account ? account.configDir : env.ensureHome(this.dir, account)
      runtime = loadPi()
        .then(({ ModelRuntime }) => ModelRuntime.create({ credentials: this.credentialStore(id) as never, modelsPath: join(configDir, 'models.json') }))
        .then((created) => {
          // Reading provider responses never changes what a request does; a broken observer is ignored.
          try { this.observeModels?.(created, id) } catch { /* observation is best effort */ }
          return created
        })
        .catch((error: unknown) => {
          this.runtimes.delete(id)
          throw error
        })
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  /** Drops a cached runtime after its credentials changed outside it (sign-in, key edits, terminal sessions). */
  invalidate(accountId: string): void {
    this.runtimes.delete(accountId)
  }

  async models(accountId?: string | null): Promise<ModelOption[]> {
    const account = accountId ? this.find(accountId) : store.defaultAccount(this.dir)
    if (!account) return []
    const available = await (await this.runtime(account)).getAvailable()
    return available.map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name || model.id, provider: String(model.provider), supportsImages: model.input.includes('image'), reasoning: model.reasoning }))
  }

  /** Offline inspection never refreshes OAuth tokens, contacts a provider, or changes credentials. */
  async inspect(accountId: string, signal?: AbortSignal): Promise<{ credentials: number; models: ModelOption[] }> {
    this.find(accountId)
    const { ModelRuntime } = await loadPi()
    const credentials = this.credentialStore(accountId)
    const readOnly = { read: credentials.read, list: credentials.list, modify: async () => undefined, delete: async () => undefined }
    const runtime = await ModelRuntime.create({ credentials: readOnly as never, modelsPath: join(env.configDir(this.dir, { id: accountId }), 'models.json'), refreshOnCreate: false, allowModelNetwork: false, signal })
    const saved = await runtime.listCredentials({ signal })
    const providers = new Set(saved.map(item => item.providerId))
    return { credentials: saved.length, models: runtime.getModels().filter(model => providers.has(String(model.provider))).map(model => ({ id: `${model.provider}/${model.id}`, name: model.name || model.id, provider: String(model.provider), supportsImages: model.input.includes('image'), reasoning: model.reasoning })) }
  }

  /** Whether sessions can run, and why not. */
  async status(accountId?: string | null): Promise<{ available: boolean; reason: string | null; models: number }> {
    const account = accountId ? this.find(accountId) : store.defaultAccount(this.dir)
    if (!account) return { available: false, reason: 'Add a Pi account in Accounts to use Chat.', models: 0 }
    try {
      const models = await this.models(account.id)
      return models.length ? { available: true, reason: null, models: models.length } : { available: false, reason: `The Pi account "${account.label}" has no signed-in provider. Sign in or add a key in Accounts.`, models: 0 }
    } catch (error) {
      log('Pi runtime failed to load', error instanceof Error ? error.message : String(error))
      return { available: false, reason: 'The Pi SDK could not be loaded.', models: 0 }
    }
  }

  /** Providers Pi can sign in to (OAuth) or take a key for, independent of any account. */
  async providers(): Promise<{ id: string; name: string; oauth: boolean; oauthLabel: string | null; subscription: boolean; apiKey: boolean }[]> {
    const { ModelRuntime } = await loadPi()
    const none = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => undefined }
    const runtime = await ModelRuntime.create({ credentials: none, modelsPath: null, refreshOnCreate: false })
    return runtime
      .getProviders()
      .map((provider) => ({ id: provider.id, name: provider.name, oauth: Boolean(provider.auth.oauth), oauthLabel: provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? null, subscription: Boolean(provider.auth.oauth?.isSubscription), apiKey: Boolean(provider.auth.apiKey?.login) }))
      .filter((provider) => provider.oauth || provider.apiKey)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  // ---- Status checks ----------------------------------------------------------------------

  private async probe(account: Account): Promise<Probe> {
    const runtime = await this.runtime(account)
    const credentials = await runtime.listCredentials()
    const available = await runtime.getAvailable()
    const subscription = credentials.filter((credential) => runtime.isUsingSubscription(credential.providerId)).map((credential) => credential.providerId)
    return {
      signedIn: credentials.length > 0 && available.length > 0,
      authMethod: [...new Set(credentials.map((credential) => credential.type))].join(', ') || null,
      plan: subscription.length ? `Subscription: ${subscription.join(', ')}` : null,
      identity: credentials.map((credential) => credential.providerId).join(', ') || null,
      capabilities: [`models:${available.length}`, ...credentials.map((credential) => `provider:${credential.providerId}`)]
    }
  }

  /** Checks one account and records what Pi reports. */
  async refreshOne(account: Account): Promise<void> {
    let probe: Probe | null = null
    let failure: string | null = null
    try {
      probe = await this.probe(account)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const { previous, state } = store.updateState(this.dir, account.id, (current) => {
      current.lastCheckedAt = now()
      if (probe) {
        current.signedIn = probe.signedIn
        current.authMethod = probe.authMethod
        current.plan = probe.plan ?? current.plan
        current.identity = probe.identity
        if (probe.limits) current.limits = probe.limits
        current.capabilities = probe.capabilities
        const keepLimitError = current.lastError !== null && store.isLimitCategory(current.lastError.category) && store.limitErrorActive(current.lastError)
        if (probe.signedIn === true && !keepLimitError) current.lastError = null
      } else {
        current.lastError = { category: classifyMessage(failure ?? '') ?? 'unknown', message: store.scrub(failure ?? ''), at: now(), resetsAt: null }
      }
    })
    if (previous !== state.health) store.audit(this.dir, account.id, 'health.changed', `${previous} → ${state.health} (status check)`)
    this.changed({ accountId: account.id })
  }

  async refresh(accountId?: string | null): Promise<AccountsOverview> {
    const accounts = accountId ? [this.find(accountId)] : store.loadRegistry(this.dir).accounts.filter((account) => account.provider === store.PROVIDER)
    for (const account of accounts) await this.refreshOne(account)
    return this.overview()
  }

  // ---- Create, rename, remove -------------------------------------------------------------

  create(label: string, authKind: string): AccountsOverview {
    const account = store.addAccount(this.dir, label, authKind)
    env.ensureHome(this.dir, account)
    store.audit(this.dir, account.id, 'account.created', `Pi account "${account.label}" (${account.authKind})`)
    this.changed({ accountId: account.id })
    return this.overview()
  }

  rename(accountId: string, label: string): AccountsOverview {
    store.renameAccount(this.dir, accountId, label)
    store.audit(this.dir, accountId, 'account.renamed', store.cleanLabel(label))
    this.changed({ accountId })
    return this.overview()
  }

  setDefault(accountId: string): AccountsOverview {
    store.setDefault(this.dir, accountId)
    store.audit(this.dir, accountId, 'default.changed', 'Default Pi account for new sessions.')
    this.changed({ accountId })
    return this.overview()
  }

  private async forgetCredentials(account: Account): Promise<void> {
    for (const provider of store.loadState(this.dir, account.id).piProviders) await this.writeCredential(account.id, provider, null)
    this.invalidate(account.id)
  }

  /** Deletes the account: removes its stored credentials and its runtime folder. Sessions pinned to it ask for another account next time they start. */
  async remove(accountId: string): Promise<AccountsOverview> {
    const account = this.find(accountId)
    for (const login of this.logins.values()) if (login.accountId === accountId) login.cancel()
    this.latestLogins.delete(accountId)
    await this.forgetCredentials(account).catch(() => undefined)
    await this.secrets.delete(secretKey(account.id, 'apiKey')).catch(() => undefined)
    store.forgetAccount(this.dir, account)
    rmSync(join(this.dir, safeId(account.id)), { recursive: true, force: true })
    store.audit(this.dir, account.id, 'account.deleted', `"${account.label}" and its stored sign-in were removed.`)
    this.changed({ accountId: account.id })
    return this.overview()
  }

  savePool(pool: { id?: string; label: string; accountIds: string[] }): AccountsOverview {
    const saved = store.savePool(this.dir, pool)
    store.audit(this.dir, null, 'pool.saved', `${saved.label}: ${saved.accountIds.length} account(s)`)
    this.changed()
    return this.overview()
  }

  removePool(poolId: string): AccountsOverview {
    store.removePool(this.dir, poolId)
    store.audit(this.dir, null, 'pool.removed', poolId)
    this.changed()
    return this.overview()
  }

  // ---- Keys and sign-in -------------------------------------------------------------------

  async setApiKey(accountId: string, rawKey: string, provider: string): Promise<AccountsOverview> {
    const account = this.find(accountId)
    const key = rawKey.trim()
    if (!key || key.length > 4096 || /\s/.test(key)) throw invalid('Paste the key without spaces.')
    if (!provider) throw invalid('Choose which Pi provider the key is for.')
    await this.writeCredential(account.id, provider, { type: 'api_key', key })
    this.invalidate(account.id)
    store.audit(this.dir, account.id, 'key.set', 'Provider key stored in the Keychain.')
    await this.refreshOne(account)
    return this.overview()
  }

  async removeProvider(accountId: string, provider: string): Promise<AccountsOverview> {
    const account = this.find(accountId)
    await this.writeCredential(account.id, provider, null)
    this.invalidate(account.id)
    store.audit(this.dir, account.id, 'key.removed', provider)
    await this.refreshOne(account)
    return this.overview()
  }

  async signOut(accountId: string): Promise<AccountsOverview> {
    const account = this.find(accountId)
    await this.forgetCredentials(account)
    store.audit(this.dir, account.id, 'logout', 'Signed out; stored credentials removed.')
    store.updateState(this.dir, account.id, (current) => {
      current.signedIn = false
      current.identity = null
      current.lastError = null
    })
    this.changed({ accountId: account.id })
    return this.overview()
  }

  private finishLogin(loginId: string, success: boolean, error: string | null, cancelled = false): void {
    const login = this.logins.get(loginId)
    if (!login) return
    this.logins.delete(loginId)
    for (const prompt of login.prompts.values()) prompt.reject(new Error('Sign-in ended.'))
    if (success) this.invalidate(login.accountId)
    store.audit(this.dir, login.accountId, success ? 'login.completed' : 'login.failed', error ?? '')
    // A fresh sign-in starts clean; a limit that still applies is reported again by the next run.
    if (success) store.updateState(this.dir, login.accountId, (current) => void (current.lastError = null))
    login.revision += 1
    const status: AccountLoginSnapshot['status'] = success ? 'completed' : cancelled ? 'cancelled' : 'failed'
    if (this.latestLogins.get(login.accountId)?.loginId === loginId) {
      this.latestLogins.set(login.accountId, {
        accountId: login.accountId,
        loginId,
        provider: login.provider,
        method: login.method,
        revision: login.revision,
        status,
        // A terminal result is enough to reconcile the client. In particular, do not retain a
        // device code after the attempt ends.
        events: [],
        prompt: null,
        success,
        error
      })
    }
    this.bus.emit({ type: 'accounts.login', accountId: login.accountId, loginId, revision: login.revision, success, error })
    try {
      void this.refreshOne(this.find(login.accountId)).catch(() => undefined)
    } catch {
      // The account was removed while its sign-in was running.
    }
  }

  /**
   * Starts a provider's own sign-in for this account. Progress, links to open, and prompts
   * arrive as `accounts.loginEvent` notices; the outcome as `accounts.login`.
   */
  async loginStart(accountId: string, provider: string, method?: string | null): Promise<{ loginId: string }> {
    const account = this.find(accountId)
    if (!provider) throw invalid('Choose which Pi provider to sign in to.')
    store.audit(this.dir, account.id, 'login.started', `${method ?? 'oauth'} · ${provider}`)
    const loginId = randomUUID()
    const controller = new AbortController()
    const login: PendingLogin = {
      accountId: account.id,
      provider,
      method: method === 'api_key' ? 'api_key' : 'oauth',
      prompts: new Map(),
      cancel: () => controller.abort(),
      revision: 0,
      events: [],
      prompt: null
    }
    this.logins.set(loginId, login)
    this.latestLogins.set(account.id, {
      accountId: account.id,
      loginId,
      provider: login.provider,
      method: login.method,
      revision: 0,
      status: 'running',
      events: [],
      prompt: null,
      success: null,
      error: null
    })
    const event = (payload: Record<string, unknown>): void => {
      login.revision += 1
      if (payload.type === 'prompt') login.prompt = payload
      else if (payload.type === 'promptClosed' && login.prompt?.promptId === payload.promptId) login.prompt = null
      else {
        login.events.push(payload)
        if (login.events.length > 50) login.events.shift()
      }
      if (this.latestLogins.get(account.id)?.loginId === loginId) {
        this.latestLogins.set(account.id, {
          accountId: account.id,
          loginId,
          provider: login.provider,
          method: login.method,
          revision: login.revision,
          status: 'running',
          events: login.events.map((step) => ({ ...step })),
          prompt: login.prompt ? { ...login.prompt } : null,
          success: null,
          error: null
        })
      }
      this.bus.emit({ type: 'accounts.loginEvent', accountId: account.id, loginId, revision: login.revision, event: payload })
    }
    const interaction = {
      signal: controller.signal,
      notify: (notification: Record<string, unknown>) => event(notification),
      prompt: (prompt: { type: string; message: string; placeholder?: string; options?: unknown; signal?: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          const promptId = randomUUID()
          login.prompts.set(promptId, { resolve, reject })
          prompt.signal?.addEventListener('abort', () => {
            login.prompts.delete(promptId)
            event({ type: 'promptClosed', promptId })
            reject(new Error('Prompt closed.'))
          })
          event({ type: 'prompt', promptId, prompt: { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder ?? null, options: prompt.options ?? null } })
        })
    }
    void this.runtime(account)
      .then(async (runtime) => {
        if (login.method !== 'oauth') return runtime.login(provider, login.method, interaction as never)
        const deviceId = await this.installationDeviceId()
        return runtime.login(provider, login.method, interaction as never, { getDeviceId: () => deviceId })
      })
      .then(() => this.finishLogin(loginId, true, null))
      .catch((error: unknown) => this.finishLogin(
        loginId,
        false,
        controller.signal.aborted ? 'Sign-in was cancelled.' : error instanceof Error ? error.message : String(error),
        controller.signal.aborted
      ))
    return { loginId }
  }

  /** Current in-memory sign-in progress for one account; codes and prompts are never written to disk. */
  loginStatus(accountId: string): AccountLoginSnapshot | null {
    this.find(accountId)
    const snapshot = this.latestLogins.get(accountId)
    return snapshot ? structuredClone(snapshot) : null
  }

  loginRespond(loginId: string, promptId: string, value: string | null): void {
    const login = this.logins.get(loginId)
    const prompt = login?.prompts.get(promptId)
    if (!login || !prompt) throw new HarnessError('not_found', 'That sign-in step is no longer waiting.')
    login.prompts.delete(promptId)
    // The renderer's recoverable snapshot must stop presenting a prompt as soon as it is answered.
    const current = this.latestLogins.get(login.accountId)
    if (current?.loginId === loginId && current.prompt?.promptId === promptId) {
      login.prompt = null
      current.revision += 1
      login.revision = current.revision
      current.prompt = null
      this.latestLogins.set(login.accountId, current)
      this.bus.emit({ type: 'accounts.loginEvent', accountId: login.accountId, loginId, revision: current.revision, event: { type: 'promptClosed', promptId } })
    }
    if (value === null) prompt.reject(new Error('Cancelled.'))
    else prompt.resolve(value)
  }

  loginCancel(accountId: string, loginId?: string | null): void {
    if (loginId) {
      const login = this.logins.get(loginId)
      if (login?.accountId === accountId) login.cancel()
    } else for (const login of this.logins.values()) if (login.accountId === accountId) login.cancel()
    store.audit(this.dir, accountId, 'login.cancelled', '')
  }

  // ---- Terminal sessions --------------------------------------------------------------------

  /**
   * The `pi` command reads `auth.json` from its agent folder. For a terminal session the
   * account's stored credentials are written there (mode 0600) while the terminal runs, then
   * read back and removed.
   */
  /** How many terminal sessions are running on this account right now. */
  terminalCount(accountId: string): number {
    return this.terminals.get(accountId) ?? 0
  }

  /**
   * Starts a terminal's use of the account's auth.json. The file is written from the store when the
   * first terminal of the account begins. While another process's terminal still uses it, the tokens
   * already in the file stay, because that terminal may have refreshed them; only a provider the file
   * lacks is added from the store, so a key saved after the other terminal began still reaches this one.
   */
  async terminalBegin(account: Account): Promise<void> {
    const count = (this.terminals.get(account.id) ?? 0) + 1
    this.terminals.set(account.id, count)
    if (count > 1) return
    const path = join(env.configDir(this.dir, account), 'auth.json')
    let shared = false
    try {
      shared = this.otherTerminalProcesses(account.id)
      this.claimLease(account.id)
      const existing = shared && existsSync(path) ? readAuth(path) : null
      const data = await this.storedCredentials(account.id, existing ?? {})
      if (!existing || Object.keys(data).length > Object.keys(existing).length) {
        atomicWrite(path, JSON.stringify(data, null, 2))
        chmodSync(path, 0o600)
      }
      this.terminalSnapshots.set(account.id, data)
    } catch (error) {
      this.terminals.delete(account.id)
      this.terminalSnapshots.delete(account.id)
      this.releaseLease(account.id)
      if (!shared) rmSync(path, { force: true })
      throw error
    }
  }

  /**
   * Ends a terminal's use of the auth.json. Each terminal saves what its Pi changed since it began (a
   * refreshed or new sign-in, or a provider it signed out of), even while another process still uses the
   * file, so no refresh is lost when the other terminal ends first. A credential saved to the store after
   * the terminal began is in neither the file nor the snapshot, so it stays. The last terminal of the
   * account to end, in every process, removes the file.
   */
  async terminalEnd(account: Account): Promise<void> {
    const remaining = Math.max(0, (this.terminals.get(account.id) ?? 1) - 1)
    if (remaining > 0) {
      this.terminals.set(account.id, remaining)
      return
    }
    this.terminals.delete(account.id)
    const snapshot = this.terminalSnapshots.get(account.id) ?? {}
    this.terminalSnapshots.delete(account.id)
    this.releaseLease(account.id)
    const path = join(env.configDir(this.dir, account), 'auth.json')
    const data = readAuth(path)
    if (data) {
      let changed = false
      for (const provider of new Set([...Object.keys(snapshot), ...Object.keys(data)])) {
        if (provider in data) {
          if (sameCredential(data[provider], snapshot[provider])) continue
          await this.writeCredential(account.id, provider, data[provider]).catch(() => undefined)
          changed = true
        } else if (provider in snapshot) {
          await this.writeCredential(account.id, provider, null).catch(() => undefined)
          changed = true
        }
      }
      if (changed) {
        this.invalidate(account.id)
        store.audit(this.dir, account.id, 'credentials.synced', 'Pi terminal sign-in saved to the Keychain.')
      }
    }
    if (!this.otherTerminalProcesses(account.id)) rmSync(path, { force: true })
  }

  /** The account's stored credentials, with `existing` kept as it is for every provider it already has. */
  private async storedCredentials(accountId: string, existing: Record<string, Credential>): Promise<Record<string, Credential>> {
    const data = { ...existing }
    for (const provider of store.loadState(this.dir, accountId).piProviders) {
      if (provider in data) continue
      const credential = await this.readCredential(accountId, provider).catch(() => null)
      if (credential) data[provider] = credential
    }
    return data
  }

  /**
   * Whether another live process has a terminal on this account. Lease files of processes that have
   * ended are removed, so a crash never leaves the account looking busy.
   */
  private otherTerminalProcesses(accountId: string): boolean {
    const folder = leaseFolder(this.dir, accountId)
    let names: string[]
    try {
      names = readdirSync(folder)
    } catch {
      return false
    }
    let others = false
    for (const name of names) {
      const pid = Number(name)
      if (!/^\d+$/.test(name) || pid <= 0 || pid === process.pid) continue
      if (processAlive(pid)) others = true
      else rmSync(join(folder, name), { force: true })
    }
    return others
  }

  private claimLease(accountId: string): void {
    const folder = leaseFolder(this.dir, accountId)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    atomicWrite(join(folder, String(process.pid)), JSON.stringify({ pid: process.pid, startedAt: now() }))
  }

  private releaseLease(accountId: string): void {
    rmSync(join(leaseFolder(this.dir, accountId), String(process.pid)), { force: true })
  }

  // ---- Health from runs ---------------------------------------------------------------------

  /** Tracks account health and limits from run events. `run` is the event's run record, when it is known. */
  onRunEvent(event: RunEvent, run: RunRecord | null): void {
    if (event.type === 'account.status') this.applyStatus(event)
    else if (event.type === 'completed' && run?.accountId) {
      const accountId = run.accountId
      const { previous, state } = store.updateState(this.dir, accountId, (current) => {
        // A finished run proves the sign-in works; limit windows and limit errors stay until they reset.
        if (current.lastError && (!store.isLimitCategory(current.lastError.category) || !store.limitErrorActive(current.lastError))) current.lastError = null
        current.signedIn = true
      })
      if (previous !== state.health) this.changed({ accountId, health: state.health, previous })
    }
  }

  /**
   * Records what a provider reported about its limits. An endpoint reading replaces that provider's
   * limits; a header reading merges by id. Windows whose reset has passed are dropped. No credential
   * is stored here.
   */
  applyLimits(
    accountId: string,
    readouts: readonly {
      provider: string
      limits: Limit[]
      source: 'headers' | 'provider' | 'estimate' | 'unavailable'
      reason: string | null
      observedAt: string
      plan?: string | null
    }[]
  ): AccountsOverview {
    this.find(accountId)
    const expired = (limit: Limit): boolean => {
      const time = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
      return !Number.isNaN(time) && time <= Date.now()
    }
    store.updateState(this.dir, accountId, (state) => {
      for (const readout of readouts) {
        // An endpoint read is the provider's whole answer; a header read only adds what it saw.
        const kept = new Map(
          (readout.source === 'provider' ? [] : state.limits.filter((limit) => limit.provider === readout.provider && !expired(limit)))
            .map((limit) => [limit.id, limit])
        )
        for (const limit of readout.limits) kept.set(limit.id, limit)
        state.limits = [...state.limits.filter((limit) => limit.provider !== readout.provider), ...kept.values()]
        const entry: ProviderLimitState = { provider: readout.provider, source: readout.source, reason: readout.reason, observedAt: readout.observedAt }
        state.providerLimits = [...state.providerLimits.filter((existing) => existing.provider !== readout.provider), entry]
        if (readout.plan) state.plan = readout.plan
      }
      state.limits.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    })
    this.changed({ accountId })
    return this.overview()
  }

  private applyStatus(event: RunEvent): void {
    const payload = event.payload as { accountId?: unknown; category?: unknown; message?: unknown; limits?: unknown; plan?: unknown; resetsAt?: unknown }
    if (typeof payload.accountId !== 'string') return
    const accountId = payload.accountId
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
    const category = text(payload.category)
    const message = text(payload.message) === null ? null : store.scrub(payload.message as string)
    const limits = Array.isArray(payload.limits) ? (payload.limits as Limit[]) : null
    let result: ReturnType<typeof store.updateState>
    try {
      result = store.updateState(this.dir, accountId, (state) => {
        if (limits) {
          for (const limit of limits) state.limits = [...state.limits.filter((existing) => existing.id !== limit.id), limit]
          state.limits.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        }
        if (text(payload.plan) !== null) state.plan = text(payload.plan)
        if (category) {
          state.lastError = { category, message: message ?? '', at: now(), resetsAt: text(payload.resetsAt) } satisfies Issue
          if (category === 'auth_expired') state.signedIn = false
        }
      })
    } catch {
      return
    }
    if (result.previous !== result.state.health) {
      store.audit(this.dir, accountId, 'health.changed', `${result.previous} → ${result.state.health}${message ? `: ${message}` : ''}`)
      this.changed({ accountId, health: result.state.health, previous: result.previous, message, resetsAt: text(payload.resetsAt) })
    } else {
      this.changed({ accountId })
    }
  }
}
