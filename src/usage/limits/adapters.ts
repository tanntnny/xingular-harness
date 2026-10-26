// Provider limits read from a provider's own usage endpoint. Header capture covers the rest; an
// endpoint here must be read-only, used by the provider's own clients, and safe to call with the
// account's credential.
import type { Limit } from '../../accounts/store'
import { authHeaders, failure, getJson } from './http'
import { toIso } from './normalize'
import type { AdapterContext, ProviderLimitAdapter } from './types'

const providerEntry = (provider: string, observedAt: string, limit: Omit<Limit, 'provider' | 'observedAt' | 'source'>): Limit =>
  ({ ...limit, provider, observedAt, source: 'provider' })

const percent = (used: number, limit: number): number | null => (limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : null)

export const OPENROUTER_ADAPTER: ProviderLimitAdapter = {
  id: 'openrouter-key',
  providers: ['openrouter'],
  stability: 'documented',
  async read({ provider, auth, baseUrl, fetch, signal, now }: AdapterContext) {
    const base = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    const reading = await getJson(fetch, `${base}/key`, authHeaders(auth), signal)
    if (reading.status < 200 || reading.status >= 300) throw new Error(failure(reading.status, 'OpenRouter'))
    const data = (reading.body as { data?: Record<string, unknown> } | null)?.data
    if (!data || typeof data !== 'object') return { limits: [], reason: 'OpenRouter returned no key details.' }
    const observedAt = now.toISOString()
    const limits: Limit[] = []
    const limit = typeof data.limit === 'number' ? data.limit : null
    const remaining = typeof data.limit_remaining === 'number' ? data.limit_remaining : null
    if (limit !== null && remaining !== null) {
      const used = Math.max(0, limit - remaining)
      limits.push(providerEntry(provider, observedAt, {
        id: `${provider}:key-credits`,
        label: 'Key credits',
        kind: 'credit',
        unit: 'usd',
        used,
        limit,
        remaining,
        usedPercent: percent(used, limit),
        remainingPercent: percent(remaining, limit),
        status: remaining <= 0 ? 'rejected' : percent(used, limit)! >= 80 ? 'warning' : 'allowed'
      }))
    }
    const budgets = Array.isArray(data.budgets) ? data.budgets : []
    for (const value of budgets.slice(0, 8)) {
      if (!value || typeof value !== 'object') continue
      const budget = value as Record<string, unknown>
      const cap = typeof budget.limit_usd === 'number' ? budget.limit_usd : null
      const spend = typeof budget.spend_usd === 'number' ? budget.spend_usd : null
      if (cap === null || spend === null) continue
      const id = typeof budget.budget_id === 'string' ? budget.budget_id : typeof budget.guardrail_id === 'string' ? budget.guardrail_id : `${budget.scope}`
      const interval = typeof budget.reset_interval === 'string' ? budget.reset_interval : 'lifetime'
      limits.push(providerEntry(provider, observedAt, {
        id: `${provider}:budget-${id}`,
        label: `Budget (${interval})`,
        kind: 'credit',
        unit: 'usd',
        used: spend,
        limit: cap,
        remaining: typeof budget.remaining_usd === 'number' ? budget.remaining_usd : Math.max(0, cap - spend),
        usedPercent: percent(spend, cap),
        remainingPercent: percent(typeof budget.remaining_usd === 'number' ? budget.remaining_usd : Math.max(0, cap - spend), cap),
        resetsAt: toIso(typeof budget.resets_at === 'string' ? budget.resets_at : undefined, now),
        status: spend >= cap ? 'rejected' : percent(spend, cap)! >= 80 ? 'warning' : 'allowed'
      }))
    }
    const free = data.free_model_daily_requests
    if (free && typeof free === 'object') {
      const used = typeof (free as Record<string, unknown>).used === 'number' ? (free as Record<string, number>).used : null
      const cap = typeof (free as Record<string, unknown>).limit === 'number' ? (free as Record<string, number>).limit : null
      if (used !== null && cap !== null) {
        limits.push(providerEntry(provider, observedAt, {
          id: `${provider}:free-daily`,
          label: 'Free-model requests today',
          kind: 'rate',
          unit: 'requests',
          used,
          limit: cap,
          remaining: Math.max(0, cap - used),
          usedPercent: percent(used, cap),
          remainingPercent: percent(cap - used, cap),
          status: used >= cap ? 'rejected' : percent(used, cap)! >= 80 ? 'warning' : 'allowed'
        }))
      }
    }
    return {
      limits,
      plan: data.is_free_tier === true ? 'Free tier' : null,
      reason: limits.length ? null : 'OpenRouter reports no credit limit for this key.'
    }
  }
}

export const DEEPSEEK_ADAPTER: ProviderLimitAdapter = {
  id: 'deepseek-balance',
  providers: ['deepseek'],
  stability: 'documented',
  async read({ provider, auth, baseUrl, fetch, signal, now }: AdapterContext) {
    const base = (baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
    const reading = await getJson(fetch, `${base}/user/balance`, authHeaders(auth), signal)
    if (reading.status < 200 || reading.status >= 300) throw new Error(failure(reading.status, 'DeepSeek'))
    const body = reading.body as { is_available?: unknown; balance_infos?: unknown } | null
    const available = body?.is_available === true
    const infos = Array.isArray(body?.balance_infos) ? body!.balance_infos as Record<string, unknown>[] : []
    const observedAt = now.toISOString()
    const limits: Limit[] = infos.slice(0, 4).flatMap((info) => {
      if (!info || typeof info !== 'object') return []
      const currency = typeof info.currency === 'string' ? info.currency : 'USD'
      const total = typeof info.total_balance === 'string' ? Number(info.total_balance) : typeof info.total_balance === 'number' ? info.total_balance : null
      if (total === null || !Number.isFinite(total)) return []
      return [providerEntry(provider, observedAt, {
        id: `${provider}:balance-${currency}`,
        label: `Balance (${currency})`,
        kind: 'credit',
        unit: 'currency',
        remaining: total,
        detail: currency,
        status: available ? (total > 0 ? 'allowed' : 'rejected') : 'rejected'
      })]
    })
    return { limits, reason: limits.length ? null : 'DeepSeek returned no balance.' }
  }
}

export const ANTHROPIC_ADMIN_ADAPTER: ProviderLimitAdapter = {
  id: 'anthropic-rate-limits',
  providers: ['anthropic'],
  stability: 'documented',
  async read({ provider, credentialType, auth, baseUrl, fetch, signal, now }: AdapterContext) {
    // A subscription sign-in is not an organization administrator.
    if (credentialType !== 'api_key') return { limits: [], reason: 'Organization limits need an Anthropic admin API key.' }
    const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
    const headers = { ...authHeaders(auth), 'anthropic-version': '2023-06-01' }
    const reading = await getJson(fetch, `${base}/v1/organizations/rate_limits`, headers, signal)
    if (reading.status < 200 || reading.status >= 300) throw new Error(failure(reading.status, 'Anthropic'))
    const data = (reading.body as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) return { limits: [], reason: 'Anthropic returned no rate limits for this credential.' }
    const observedAt = now.toISOString()
    const limits: Limit[] = []
    for (const value of data.slice(0, 24)) {
      if (!value || typeof value !== 'object') continue
      const group = (value as Record<string, unknown>).group as Record<string, unknown> | undefined
      const groupName = typeof group?.display_name === 'string' ? group.display_name : typeof group?.type === 'string' ? group.type : 'Organization'
      const groupId = typeof group?.id === 'string' ? group.id : groupName
      const entries = Array.isArray((value as Record<string, unknown>).limits) ? (value as Record<string, unknown>).limits as Record<string, unknown>[] : []
      for (const item of entries) {
        const type = typeof item.type === 'string' ? item.type : ''
        const cap = typeof item.value === 'number' ? item.value : null
        if (!type || cap === null) continue
        limits.push(providerEntry(provider, observedAt, {
          id: `${provider}:configured-${groupId}-${type}`,
          label: `${groupName} · ${type.replaceAll('_', ' ')}`,
          kind: 'configured',
          unit: type.includes('token') ? 'tokens' : 'requests',
          limit: cap,
          windowMinutes: 1,
          status: 'configured',
          detail: 'Configured limit, not current usage'
        }))
      }
    }
    return { limits, reason: limits.length ? null : 'Anthropic returned no configured rate limits.' }
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const pick = (value: Record<string, unknown> | null, keys: readonly string[]): unknown => {
  if (!value) return undefined
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key]
  return undefined
}

const numeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const clampPercent = (value: number | null): number | null =>
  value === null ? null : Math.min(100, Math.max(0, value))

const windowLabel = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return 'Usage window'
  const minutes = Math.round(seconds / 60)
  if (minutes === 300) return '5-hour window'
  if (minutes === 10_080) return 'Weekly window'
  if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}-day window`
  if (minutes >= 60) return `${Math.round(minutes / 60)}-hour window`
  return `${minutes} min window`
}

const epochIso = (value: number | null): string | null => {
  if (value === null) return null
  // The Codex usage endpoint reports seconds; tolerate milliseconds too.
  const millis = value > 10_000_000_000 ? value : value * 1_000
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** The account id Pi's Codex OAuth credential carries in its access-token claims. */
function codexAccountId(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = record(payload['https://api.openai.com/auth'])
    const id = auth?.chatgpt_account_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/** ChatGPT/Codex plan windows and credits, from the account's own usage endpoint. */
export const CODEX_ADAPTER: ProviderLimitAdapter = {
  id: 'codex-usage',
  providers: ['openai-codex'],
  stability: 'documented',
  async read({ provider, auth, baseUrl, fetch, signal, now }: AdapterContext) {
    const base = (baseUrl || 'https://chatgpt.com/backend-api').replace(/\/$/, '')
    const headers: Record<string, string> = { ...authHeaders(auth), accept: 'application/json' }
    const accountId = codexAccountId(auth.apiKey)
    if (accountId) headers['chatgpt-account-id'] = accountId
    const reading = await getJson(fetch, `${base}/wham/usage`, headers, signal)
    if (reading.status === 401 || reading.status === 403) throw new Error('The ChatGPT sign-in cannot read Codex usage. Sign in again in Accounts.')
    if (reading.status < 200 || reading.status >= 300) throw new Error(failure(reading.status, 'Codex'))
    const root = record(reading.body) ?? {}
    const rate = record(pick(root, ['ratelimit', 'rateLimit', 'rate_limit']))
    const observedAt = now.toISOString()
    const limits: Limit[] = []
    for (const [name, keys] of [
      ['primary', ['primarywindow', 'primaryWindow', 'primary_window']],
      ['secondary', ['secondarywindow', 'secondaryWindow', 'secondary_window']]
    ] as const) {
      const window = record(pick(rate, keys))
      const used = numeric(pick(window, ['usedpercent', 'usedPercent', 'used_percent']))
      const reset = numeric(pick(window, ['resetat', 'resetAt', 'reset_at']))
      const windowSeconds = numeric(pick(window, ['limitwindowseconds', 'limitWindowSeconds', 'limit_window_seconds']))
      if (used === null && reset === null && windowSeconds === null) continue
      const usedPercent = clampPercent(used)
      limits.push(providerEntry(provider, observedAt, {
        id: `${provider}:window-${name}`,
        label: windowLabel(windowSeconds),
        kind: 'window',
        unit: 'percent',
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        windowMinutes: windowSeconds === null ? null : Math.round(windowSeconds / 60),
        resetsAt: epochIso(reset),
        status: usedPercent === null ? 'allowed' : usedPercent >= 100 ? 'rejected' : usedPercent >= 80 ? 'warning' : 'allowed'
      }))
    }
    const credits = record(pick(root, ['credits']))
    const balance = numeric(pick(credits, ['balance']))
    const unlimited = pick(credits, ['unlimited']) === true
    const hasCredits = pick(credits, ['hascredits', 'hasCredits', 'has_credits'])
    // Credits are an optional extra on ChatGPT plans: an empty balance is not a used-up plan window.
    const includeCredits = unlimited || (balance !== null && (hasCredits === true || balance > 0))
    if (includeCredits) {
      limits.push(providerEntry(provider, observedAt, {
        id: `${provider}:credits`,
        label: 'Credits',
        kind: 'credit',
        unit: 'count',
        remaining: unlimited ? null : balance,
        status: unlimited ? 'allowed' : balance !== null && balance > 0 ? 'allowed' : 'warning',
        detail: unlimited ? 'Unlimited credits' : 'ChatGPT credits'
      }))
    }
    const plan = pick(root, ['plantype', 'planType', 'plan_type'])
    return {
      limits,
      plan: typeof plan === 'string' && plan ? `ChatGPT ${plan}` : null,
      reason: limits.length ? null : 'The ChatGPT account reported no Codex windows.'
    }
  }
}

/** OpenCode Go's 5-hour, weekly and monthly subscription windows. */
export const OPENCODE_GO_ADAPTER: ProviderLimitAdapter = {
  id: 'opencode-go-usage',
  providers: ['opencode-go'],
  stability: 'documented',
  async read({ provider, auth, fetch, signal, now }: AdapterContext) {
    const reading = await getJson(fetch, 'https://opencode.ai/zen/go/v1/usage', { ...authHeaders(auth), accept: 'application/json' }, signal)
    if (reading.status === 401 || reading.status === 403) throw new Error('The OpenCode API key cannot read Go usage. Check the key in Accounts.')
    if (reading.status < 200 || reading.status >= 300) throw new Error(failure(reading.status, 'OpenCode Go'))
    const root = record(reading.body) ?? {}
    const usage = record(pick(root, ['usage']))
    if (!usage) return { limits: [], reason: 'OpenCode Go returned no usage windows.' }
    const renewsAt = typeof pick(usage, ['renewsAt', 'renews_at', 'endsAt', 'ends_at']) === 'string'
      ? toIso(String(pick(usage, ['renewsAt', 'renews_at', 'endsAt', 'ends_at'])), now)
      : typeof pick(root, ['renewsAt', 'renews_at']) === 'string'
        ? toIso(String(pick(root, ['renewsAt', 'renews_at'])), now)
        : null
    const observedAt = now.toISOString()
    const limits: Limit[] = []
    const windows = [
      { key: 'rolling', label: '5-hour window', minutes: 300 },
      { key: 'weekly', label: 'Weekly window', minutes: 10_080 },
      { key: 'monthly', label: 'Monthly window', minutes: 43_200 }
    ] as const
    for (const window of windows) {
      const value = record(pick(usage, [window.key, `${window.key}Usage`]))
      const usedPercent = clampPercent(numeric(pick(value, ['percent', 'usagePercent', 'usage_percent'])))
      if (usedPercent === null) continue
      const resetInSec = numeric(pick(value, ['resetInSec', 'reset_in_sec', 'resetInSeconds', 'resetsInSec']))
      const resetAt = pick(value, ['resetAt', 'reset_at', 'resetsAt', 'resets_at', 'resetTime', 'reset_time'])
      const resetsAt = resetInSec !== null
        ? new Date(now.getTime() + Math.max(0, resetInSec) * 1_000).toISOString()
        : typeof resetAt === 'string' ? toIso(resetAt, now) : window.key === 'monthly' ? renewsAt : null
      limits.push(providerEntry(provider, observedAt, {
        id: `${provider}:window-${window.key}`,
        label: window.label,
        kind: 'window',
        unit: 'percent',
        usedPercent,
        remainingPercent: 100 - usedPercent,
        windowMinutes: window.minutes,
        resetsAt,
        status: usedPercent >= 100 ? 'rejected' : usedPercent >= 80 ? 'warning' : 'allowed',
        detail: window.key === 'monthly' ? 'Monthly allowance' : null
      }))
    }
    return { limits, reason: limits.length ? null : 'OpenCode Go returned no usage windows.' }
  }
}

const ADAPTERS: readonly ProviderLimitAdapter[] = [OPENROUTER_ADAPTER, DEEPSEEK_ADAPTER, ANTHROPIC_ADMIN_ADAPTER, CODEX_ADAPTER, OPENCODE_GO_ADAPTER]

/** The documented adapter for a provider, when one exists. Headers remain the other source. */
export function adapterFor(provider: string): ProviderLimitAdapter | null {
  return ADAPTERS.find((adapter) => adapter.providers.includes(provider)) ?? null
}

export const DOCUMENTED_ADAPTERS = ADAPTERS
