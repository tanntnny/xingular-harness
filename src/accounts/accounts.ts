// The accounts service: everything that needs the secret store, the Pi runtime, or a notice.
// Credentials go to the embedding application's secret store; nothing here writes one to the
// harness's own files, except a terminal session's `auth.json` while that terminal runs.
import { chmodSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { log, type Bus } from '../core/bus'
import { HarnessError, invalid } from '../core/errors'
import { atomicWrite, now, readJson, safeId } from '../core/fs'
import type { RunEvent, RunRecord } from '../sessions/contracts'
import * as env from './env'
import { secretKey, type SecretStore } from './secrets'
import * as store from './store'
import type { Account, AccountsOverview, Issue, Limit } from './store'

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

function validProvider(provider: string): string {
  if (provider && provider.length <= 64 && /^[A-Za-z0-9._-]+$/.test(provider)) return provider
  throw invalid('Invalid provider name.')
}

interface PendingLogin {
  accountId: string
  cancel: () => void
  prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>
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
}

export class Accounts {
  readonly dir: string
  private readonly secrets: SecretStore
  private readonly bus: Bus
  private readonly runtimes = new Map<string, Promise<ModelRuntime>>()
  private readonly logins = new Map<string, PendingLogin>()
  private readonly terminals = new Map<string, number>()

  constructor(options: AccountsOptions) {
    this.dir = options.dir
    this.secrets = options.secrets
    this.bus = options.bus
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

  /** Stores a provider's credential, or removes it when `credential` is `null`. */
  async writeCredential(accountId: string, provider: string, credential: Credential | null): Promise<void> {
    this.find(accountId)
    const name = validProvider(provider)
    if (credential === null) await this.secrets.delete(secretKey(accountId, `pi-auth/${name}`))
    else await this.secrets.set(secretKey(accountId, `pi-auth/${name}`), JSON.stringify(credential))
    store.updateState(this.dir, accountId, (state) => {
      state.piProviders = state.piProviders.filter((existing) => existing !== name)
      if (credential !== null) state.piProviders = [...state.piProviders, name].sort()
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

  /** Pi's `CredentialStore` for one account. Writes are serialized, so a refresh never races another. */
  private credentialStore(accountId: string) {
    let chain: Promise<unknown> = Promise.resolve()
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const next = chain.then(work)
      chain = next.catch(() => undefined)
      return next
    }
    return {
      read: async (providerId: string) => (await this.readCredential(accountId, providerId)) ?? undefined,
      list: () => this.listCredentials(accountId),
      modify: (providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) =>
        serialize(async () => {
          const current = (await this.readCredential(accountId, providerId)) ?? undefined
          const updated = await change(current)
          if (updated !== undefined) await this.writeCredential(accountId, providerId, updated)
          return updated ?? current
        }),
      delete: (providerId: string) => serialize(() => this.writeCredential(accountId, providerId, null))
    }
  }

  // ---- The Pi runtime ---------------------------------------------------------------------

  /** The lazily loaded Pi runtime of one account: its models and its credentials. Pi's own `~/.pi` is never used. */
  runtime(account: env.AccountContext | Account): Promise<ModelRuntime> {
    const id = account.id
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      const configDir = 'configDir' in account ? account.configDir : env.ensureHome(this.dir, account)
      runtime = import('@earendil-works/pi-coding-agent')
        .then(({ ModelRuntime }) => ModelRuntime.create({ credentials: this.credentialStore(id) as never, modelsPath: join(configDir, 'models.json') }))
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
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
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
        current.lastError = { category: 'unknown', message: store.scrub(failure ?? ''), at: now(), resetsAt: null }
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

  private finishLogin(loginId: string, success: boolean, error: string | null): void {
    const login = this.logins.get(loginId)
    if (!login) return
    this.logins.delete(loginId)
    for (const prompt of login.prompts.values()) prompt.reject(new Error('Sign-in ended.'))
    if (success) this.invalidate(login.accountId)
    store.audit(this.dir, login.accountId, success ? 'login.completed' : 'login.failed', error ?? '')
    // A fresh sign-in starts clean; a limit that still applies is reported again by the next run.
    if (success) store.updateState(this.dir, login.accountId, (current) => void (current.lastError = null))
    this.bus.emit({ type: 'accounts.login', accountId: login.accountId, loginId, success, error })
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
    const runtime = await this.runtime(account)
    const loginId = randomUUID()
    const controller = new AbortController()
    const login: PendingLogin = { accountId: account.id, prompts: new Map(), cancel: () => controller.abort() }
    this.logins.set(loginId, login)
    const event = (payload: Record<string, unknown>): void => this.bus.emit({ type: 'accounts.loginEvent', accountId: account.id, loginId, event: payload })
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
    runtime
      .login(provider, method === 'api_key' ? 'api_key' : 'oauth', interaction as never)
      .then(() => this.finishLogin(loginId, true, null))
      .catch((error: unknown) => this.finishLogin(loginId, false, controller.signal.aborted ? 'Sign-in was cancelled.' : error instanceof Error ? error.message : String(error)))
    return { loginId }
  }

  loginRespond(loginId: string, promptId: string, value: string | null): void {
    const login = this.logins.get(loginId)
    const prompt = login?.prompts.get(promptId)
    if (!login || !prompt) throw new HarnessError('not_found', 'That sign-in step is no longer waiting.')
    login.prompts.delete(promptId)
    if (value === null) prompt.reject(new Error('Cancelled.'))
    else prompt.resolve(value)
  }

  loginCancel(accountId: string, loginId?: string | null): void {
    if (loginId) this.logins.get(loginId)?.cancel()
    store.audit(this.dir, accountId, 'login.cancelled', '')
  }

  // ---- Terminal sessions --------------------------------------------------------------------

  /**
   * The `pi` command reads `auth.json` from its agent folder. For a terminal session the
   * account's stored credentials are written there (mode 0600) while the terminal runs, then
   * read back and removed.
   */
  async terminalBegin(account: Account): Promise<void> {
    const count = (this.terminals.get(account.id) ?? 0) + 1
    this.terminals.set(account.id, count)
    if (count > 1) return
    const path = join(env.configDir(this.dir, account), 'auth.json')
    try {
      const data: Record<string, unknown> = {}
      for (const provider of store.loadState(this.dir, account.id).piProviders) {
        const credential = await this.readCredential(account.id, provider).catch(() => null)
        if (credential) data[provider] = credential
      }
      atomicWrite(path, JSON.stringify(data, null, 2))
      chmodSync(path, 0o600)
    } catch (error) {
      this.terminals.delete(account.id)
      rmSync(path, { force: true })
      throw error
    }
  }

  async terminalEnd(account: Account): Promise<void> {
    const remaining = Math.max(0, (this.terminals.get(account.id) ?? 1) - 1)
    if (remaining > 0) {
      this.terminals.set(account.id, remaining)
      return
    }
    this.terminals.delete(account.id)
    const path = join(env.configDir(this.dir, account), 'auth.json')
    let data: Record<string, Credential> | null = null
    try {
      const parsed = readJson<Record<string, Credential>>(path)
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      data = null
    }
    if (data) {
      for (const provider of store.loadState(this.dir, account.id).piProviders) if (!(provider in data)) await this.writeCredential(account.id, provider, null).catch(() => undefined)
      for (const [provider, credential] of Object.entries(data)) await this.writeCredential(account.id, provider, credential).catch(() => undefined)
      this.invalidate(account.id)
      store.audit(this.dir, account.id, 'credentials.synced', 'Pi terminal sign-in saved to the Keychain.')
    }
    rmSync(path, { force: true })
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
