// The limits side of `/usage`: what each provider last said about a plan window, a balance or a
// rate limit. Header capture keeps it fresh during use; a page open may read a documented endpoint
// once in a while. Nothing here spends tokens or sends a prompt.
import type { Accounts } from '../../accounts/accounts'
import { scrub, type Account, type Limit } from '../../accounts/store'
import { readUsageSettings } from '../settings'
import { adapterFor } from './adapters'
import { observeProviderResponses } from './capture'
import { normalizeHeaders } from './normalize'
import type { AdapterContext, FetchLike, LimitReadout, ProviderResponseLike, UsageLimitsReport } from './types'

export interface UsageLimitsOptions {
  accounts: Accounts
  root: () => string | null
  fetch?: FetchLike
  now?: () => Date
}

const DEFAULT_BASE: Record<string, string> = {
  openrouter: 'https://openrouter.ai',
  deepseek: 'https://api.deepseek.com',
  anthropic: 'https://api.anthropic.com',
  'openai-codex': 'https://chatgpt.com/backend-api',
  'opencode-go': 'https://opencode.ai'
}

const HEADER_WRITE_INTERVAL_MS = 15_000
const REQUEST_TIMEOUT_MS = 6_000

function origin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export class UsageLimits {
  private readonly fetchImpl: FetchLike
  private readonly now: () => Date
  private readonly headerWrites = new Map<string, number>()

  constructor(private readonly options: UsageLimitsOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
    this.now = options.now ?? (() => new Date())
  }

  /** Lets an account's model runtime report response headers without changing any request. */
  observeModels(models: unknown, accountId: string): void {
    observeProviderResponses(models, (provider, response) => this.recordHeaders(accountId, provider, response))
  }

  /** Records what one provider response said. Throttled per account and provider. */
  recordHeaders(accountId: string, provider: string, response: ProviderResponseLike): void {
    if (!provider || provider.length > 64) return
    const key = `${accountId}\u0000${provider}`
    const at = this.now().getTime()
    const last = this.headerWrites.get(key) ?? 0
    if (at - last < HEADER_WRITE_INTERVAL_MS) return
    const normalized = normalizeHeaders(provider, response, this.now())
    if (!normalized.limits.length) return
    this.headerWrites.set(key, at)
    try {
      this.options.accounts.applyLimits(accountId, [{
        provider,
        limits: normalized.limits,
        source: 'headers',
        reason: null,
        observedAt: this.now().toISOString()
      }])
    } catch {
      // The account may have been removed while a response was arriving.
    }
  }

  /** What the accounts already know, without touching the network. */
  read(accountId?: string | null): UsageLimitsReport {
    const overview = this.options.accounts.overview()
    const accounts = overview.accounts.filter((account) => !accountId || account.id === accountId)
    return {
      generatedAt: this.now().toISOString(),
      accounts: accounts.map((account) => {
        const known = new Map<string, { source: 'headers' | 'provider' | 'estimate' | 'unavailable'; reason: string | null; observedAt: string }>()
        for (const entry of account.state.providerLimits ?? []) known.set(entry.provider, entry)
        for (const limit of account.state.limits) {
          const provider = limit.provider
          if (!provider || known.has(provider)) continue
          known.set(provider, { source: limit.source === 'provider' ? 'provider' : 'headers', reason: null, observedAt: limit.observedAt ?? this.now().toISOString() })
        }
        return {
          accountId: account.id,
          label: account.label,
          plan: account.state.plan,
          health: account.state.health,
          providers: [...known.entries()].map(([provider, entry]) => ({
            provider,
            source: entry.source,
            reason: entry.reason,
            observedAt: entry.observedAt,
            limits: account.state.limits.filter((limit) => limit.provider === provider && !(limit.resetsAt && Date.parse(limit.resetsAt) <= this.now().getTime()))
          })).sort((left, right) => left.provider.localeCompare(right.provider))
        }
      })
    }
  }

  /** Reads every provider that is due, then returns the stored report. */
  async refresh(accountId?: string | null, options: { force?: boolean } = {}): Promise<UsageLimitsReport> {
    const settings = readUsageSettings(this.options.root())
    const overview = this.options.accounts.overview()
    const accounts = overview.accounts.filter((account) => !accountId || account.id === accountId)
    for (const account of accounts) {
      let credentials: { providerId: string; type: 'api_key' | 'oauth' }[]
      try {
        credentials = await this.options.accounts.listCredentials(account.id)
      } catch {
        continue
      }
      for (const credential of credentials) {
        const known = this.read(account.id).accounts[0]?.providers.find((entry) => entry.provider === credential.providerId)
        const age = known ? this.now().getTime() - Date.parse(known.observedAt) : Number.POSITIVE_INFINITY
        if (!options.force && Number.isFinite(age) && age < settings.refreshMinutes * 60_000) continue
        await this.refreshProvider(this.options.accounts.find(account.id), credential.providerId, credential.type, settings.experimentalProbes)
      }
    }
    return this.read(accountId)
  }

  private async refreshProvider(account: Account, provider: string, credentialType: 'api_key' | 'oauth', experimental: boolean): Promise<void> {
    const observedAt = this.now().toISOString()
    const unavailable = (reason: string): void => {
      try {
        this.options.accounts.applyLimits(account.id, [{ provider, limits: [], source: 'unavailable', reason: scrub(reason), observedAt }])
      } catch {
        // The account was removed while its limits were being read.
      }
    }
    const adapter = adapterFor(provider)
    if (!adapter) return unavailable('No documented usage endpoint for this provider. Local usage is shown instead.')
    if (adapter.stability === 'experimental' && !experimental) return unavailable('Experimental provider probes are off. Turn them on in the usage plugin settings.')
    let context: AdapterContext
    try {
      const runtime = await this.options.accounts.runtime(account)
      const auth = await runtime.getAuth(provider)
      if (!auth) return unavailable('This provider is not signed in.')
      const configured = runtime.getProvider(provider)?.baseUrl ?? null
      const expected = DEFAULT_BASE[provider]
      if (configured && expected && origin(configured) !== origin(expected)) {
        return unavailable('This provider uses a custom base URL, so its own usage endpoint cannot be read.')
      }
      context = {
        provider,
        credentialType,
        auth: { ...auth.auth, ...(auth.auth.baseUrl ? {} : configured ? { baseUrl: configured } : {}) },
        baseUrl: auth.auth.baseUrl ?? configured ?? null,
        fetch: this.fetchImpl,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        now: this.now()
      }
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : 'The provider credential could not be resolved.')
    }
    try {
      const reading = await adapter.read(context)
      this.options.accounts.applyLimits(account.id, [{
        provider,
        limits: reading.limits.map((limit) => ({ ...limit, provider, observedAt, source: 'provider' })),
        source: 'provider',
        reason: reading.reason ? scrub(reading.reason) : null,
        observedAt,
        plan: reading.plan ?? null
      }])
    } catch (error) {
      unavailable(error instanceof Error ? error.message : 'The provider usage endpoint could not be read.')
    }
  }

  /** Limits known for one account and provider, for diagnostics. */
  limitsOf(accountId: string, provider: string): Limit[] {
    return this.options.accounts.overview().accounts.find((account) => account.id === accountId)?.state.limits.filter((limit) => limit.provider === provider) ?? []
  }
}

export type { LimitReadout }
