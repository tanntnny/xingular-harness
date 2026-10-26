// Accounts. One profile (settings, registry, memory) and any number of Pi accounts, each with
// its own isolated agent folder, stored credentials, sign-in state, limits, health, and audit
// trail.
//
// Device-local layout under `<state dir>/accounts/`:
//   accounts.json        accounts, the default, pools (no secrets)
//   <id>/state.json      health, plan, limits, last error (no secrets)
//   <id>/home/pi/        Pi's own agent folder for this account
//   _shared/pi/          settings, skills, prompts linked into every account's agent folder
//   audit.jsonl          append-only account actions (secrets scrubbed)
//
// Switching is always manual. A pool only chooses an account when a session starts; a running
// or resumed session keeps the account it started with.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import { appendLine, newId, now, readJsonOr, safeId, writeJson } from '../core/fs'
import { charCount, compareText, lines, takeChars } from '../core/text'

/** The only provider the harness runs. Records of other providers are kept in the file and ignored. */
export const PROVIDER = 'pi'

export interface Account {
  id: string
  provider: string
  label: string
  /** `subscription` (a provider's own sign-in) or `apiKey`. */
  authKind: string
  credentialStore?: string
  createdAt: string
}

export interface Pool {
  id: string
  provider: string
  label: string
  accountIds: string[]
}

interface Registry {
  accounts: Account[]
  defaults: Record<string, string>
  pools: Pool[]
  migratedProviderKeys: boolean
}

export interface Limit {
  id: string
  label: string
  usedPercent?: number | null
  /** The same window from the other side: quota left. Additive for surfaces that read limits as remaining. */
  remainingPercent?: number | null
  resetsAt?: string | null
  windowMinutes?: number | null
  /** `allowed`, `warning`, `rejected`, or `configured` when the provider reports it. */
  status?: string | null
  /** Which provider the reading belongs to. Older records may omit it. */
  provider?: string | null
  /** What kind of ceiling this is. */
  kind?: 'window' | 'rate' | 'credit' | 'configured' | 'error'
  /** The unit of `used`, `limit` and `remaining`. */
  unit?: 'percent' | 'requests' | 'tokens' | 'usd' | 'currency' | 'count'
  used?: number | null
  limit?: number | null
  remaining?: number | null
  /** How the reading was obtained. */
  source?: 'headers' | 'provider' | 'estimate' | 'error'
  observedAt?: string | null
  /** A short provider note, such as a balance currency. */
  detail?: string | null
}

/** The last readout for one provider of one account, including when nothing could be read. */
export interface ProviderLimitState {
  provider: string
  source: 'headers' | 'provider' | 'estimate' | 'unavailable'
  reason: string | null
  observedAt: string
}

export interface Issue {
  /** `auth_expired`, `rate_limited`, `quota`, `network`, or `unknown`. */
  category: string
  message: string
  at: string
  resetsAt: string | null
}

export interface AccountState {
  /** `ok`, `limited`, `auth_expired`, `signed_out`, `error`, or `unknown`. */
  health: string
  signedIn: boolean | null
  authMethod: string | null
  plan: string | null
  identity: string | null
  limits: Limit[]
  /** What the last limit readout found for each provider, including an unavailable one. */
  providerLimits: ProviderLimitState[]
  lastError: Issue | null
  lastCheckedAt: string | null
  cliVersion: string | null
  /** Features detected for this account, e.g. `models:12`, `provider:anthropic`. */
  capabilities: string[]
  /** Providers with a stored credential (names only). */
  piProviders: string[]
}

export const emptyState = (): AccountState => ({ health: 'unknown', signedIn: null, authMethod: null, plan: null, identity: null, limits: [], providerLimits: [], lastError: null, lastCheckedAt: null, cliVersion: null, capabilities: [], piProviders: [] })

export type AccountView = Account & { isDefault: boolean; state: AccountState }

export interface AccountsOverview {
  accounts: AccountView[]
  pools: Pool[]
  defaults: Record<string, string>
}

export interface AuditEntry {
  at: string
  accountId: string | null
  action: string
  detail: string
}

// ---- Files ------------------------------------------------------------------------------

const registryPath = (dir: string): string => join(dir, 'accounts.json')
const statePath = (dir: string, accountId: string): string => join(dir, safeId(accountId), 'state.json')

export function loadRegistry(dir: string): Registry {
  const stored = readJsonOr<Partial<Registry>>(registryPath(dir), {}) ?? {}
  return { accounts: stored.accounts ?? [], defaults: stored.defaults ?? {}, pools: stored.pools ?? [], migratedProviderKeys: stored.migratedProviderKeys ?? false }
}

export function saveRegistry(dir: string, registry: Registry): void {
  mkdirSync(dir, { recursive: true })
  writeJson(registryPath(dir), registry)
}

export function loadState(dir: string, accountId: string): AccountState {
  try {
    return { ...emptyState(), ...(readJsonOr<Partial<AccountState>>(statePath(dir, accountId), {}) ?? {}) }
  } catch {
    return emptyState()
  }
}

function saveState(dir: string, accountId: string, state: AccountState): void {
  writeJson(statePath(dir, accountId), state)
}

/** Replaces anything that looks like a token so audit lines and stored errors never hold secrets. */
export function scrub(text: string): string {
  const words = text.split(' ').map((word) => {
    const bytes = Buffer.byteLength(word)
    const tokenLike = bytes >= 24 && (word.match(/[A-Za-z0-9]/g)?.length ?? 0) * 10 >= bytes * 8
    return tokenLike || word.startsWith('sk-') || word.startsWith('sess-') ? '[redacted]' : word
  })
  return takeChars(words.join(' '), 500)
}

export function audit(dir: string, accountId: string | null, action: string, detail: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendLine(join(dir, 'audit.jsonl'), JSON.stringify({ at: now(), accountId, action, detail: scrub(detail) } satisfies AuditEntry))
  } catch {
    // An audit line that cannot be written never fails the action it describes.
  }
}

/** The newest audit entries first, optionally for one account. */
export function readAudit(dir: string, accountId?: string | null, limit = 100): AuditEntry[] {
  let text = ''
  try {
    text = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
  } catch {
    text = ''
  }
  const entries = lines(text).flatMap((line) => {
    try {
      const entry = JSON.parse(line) as AuditEntry
      return entry && typeof entry.at === 'string' && typeof entry.action === 'string' && (!accountId || entry.accountId === accountId) ? [entry] : []
    } catch {
      return []
    }
  })
  return entries.reverse().slice(0, Math.min(limit, 1000))
}

// ---- Health -----------------------------------------------------------------------------

function inFuture(timestamp: string | null | undefined): boolean {
  const time = timestamp ? Date.parse(timestamp) : Number.NaN
  return !Number.isNaN(time) && time > Date.now()
}

// How long a limit error that came without a reset time keeps the account limited. Providers
// report no limit windows, so nothing else would ever lift it.
const UNTIMED_LIMIT_ERROR_SECS = 3600

export const isLimitCategory = (category: string): boolean => category === 'rate_limited' || category === 'quota'

/**
 * Whether a `rate_limited` or `quota` error still counts. With a reset time it counts until
 * then; without one it counts for a short while after it was recorded.
 */
export function limitErrorActive(issue: Issue): boolean {
  if (issue.resetsAt) return inFuture(issue.resetsAt)
  const at = Date.parse(issue.at)
  return !Number.isNaN(at) && Math.trunc((Date.now() - at) / 1000) < UNTIMED_LIMIT_ERROR_SECS
}

export function deriveHealth(state: AccountState): string {
  const limitedByWindow = state.limits.some((limit) => (limit.status === 'rejected' || (limit.usedPercent ?? 0) >= 100) && (!limit.resetsAt || inFuture(limit.resetsAt)))
  const issue = state.lastError
  if (issue?.category === 'auth_expired') return 'auth_expired'
  if (issue && isLimitCategory(issue.category) && limitErrorActive(issue)) return 'limited'
  if (state.signedIn === false) return 'signed_out'
  if (limitedByWindow) return 'limited'
  if (issue && !isLimitCategory(issue.category)) return 'error'
  return state.signedIn === true ? 'ok' : 'unknown'
}

/** Read-modify-write on one account's state. Returns the previous health and the new state. */
export function updateState(dir: string, accountId: string, change: (state: AccountState) => void): { previous: string; state: AccountState } {
  const state = loadState(dir, accountId)
  const previous = state.health
  change(state)
  state.health = deriveHealth(state)
  saveState(dir, accountId, state)
  return { previous, state }
}

// ---- Lookup and pinning -----------------------------------------------------------------

export function find(dir: string, accountId: string): Account {
  const account = loadRegistry(dir).accounts.find((entry) => entry.id === accountId)
  if (!account) throw new HarnessError('account_required', "This session's account was removed.", 'Choose another account for it.')
  return account
}

const usable = (state: AccountState): boolean => state.health === 'ok' || state.health === 'unknown'

/**
 * Chooses the account for a new session: the explicit account, else the pool's first usable
 * account, else the default, else the first account. It never skips to another one silently.
 */
export function resolve(dir: string, accountId?: string | null, poolId?: string | null): Account {
  const registry = loadRegistry(dir)
  if (accountId) {
    const account = find(dir, accountId)
    if (account.provider !== PROVIDER) throw invalid('That account belongs to another provider.')
    return account
  }
  if (poolId) {
    const pool = registry.pools.find((entry) => entry.id === poolId)
    if (!pool) throw notFound('Pool')
    const members = pool.accountIds.flatMap((id) => registry.accounts.find((account) => account.id === id) ?? [])
    const ready = members.find((account) => usable(loadState(dir, account.id)))
    if (ready) return ready
    const resets = members.flatMap((account) => {
      const state = loadState(dir, account.id)
      return [...state.limits.map((limit) => limit.resetsAt), state.lastError?.resetsAt].filter((reset): reset is string => Boolean(reset))
    })
    const earliest = resets.sort(compareText)[0]
    throw new HarnessError('account_unavailable', `Every account in ${pool.label} is unavailable.`, earliest ? `The earliest reset is ${earliest}.` : 'Reauthenticate an account in Accounts.')
  }
  const account = registry.accounts.find((entry) => entry.id === registry.defaults[PROVIDER]) ?? registry.accounts.find((entry) => entry.provider === PROVIDER)
  if (!account) throw new HarnessError('account_required', 'Add a Pi account first.', 'Open Accounts (⌘4) to sign in.')
  return account
}

/** The default account, if any exists. */
export function defaultAccount(dir: string): Account | null {
  try {
    return resolve(dir)
  } catch {
    return null
  }
}

export function summaryAuthentication(dir: string): 'authenticated' | 'unauthenticated' | 'unknown' {
  const states = loadRegistry(dir).accounts.filter((account) => account.provider === PROVIDER).map((account) => loadState(dir, account.id))
  if (states.some((state) => state.signedIn === true)) return 'authenticated'
  return states.some((state) => state.signedIn === false) ? 'unauthenticated' : 'unknown'
}

export function overview(dir: string): AccountsOverview {
  const registry = loadRegistry(dir)
  return {
    accounts: registry.accounts.filter((account) => account.provider === PROVIDER).map((account) => ({ ...account, isDefault: registry.defaults[account.provider] === account.id, state: loadState(dir, account.id) })),
    pools: registry.pools.filter((pool) => pool.provider === PROVIDER),
    defaults: registry.defaults
  }
}

// ---- Changes ----------------------------------------------------------------------------

export function cleanLabel(label: string): string {
  const cleaned = label.trim()
  if (!cleaned || charCount(cleaned) > 60) throw invalid('Give the account a name of 1–60 characters.')
  return cleaned
}

export function addAccount(dir: string, label: string, authKind: string): Account {
  if (authKind !== 'subscription' && authKind !== 'apiKey') throw invalid('Unknown sign-in type.')
  const account: Account = { id: newId(), provider: PROVIDER, label: cleanLabel(label), authKind, credentialStore: 'keyring', createdAt: now() }
  const registry = loadRegistry(dir)
  registry.defaults[PROVIDER] ??= account.id
  registry.accounts.push(account)
  saveRegistry(dir, registry)
  return account
}

export function renameAccount(dir: string, accountId: string, label: string): void {
  const cleaned = cleanLabel(label)
  const registry = loadRegistry(dir)
  const account = registry.accounts.find((entry) => entry.id === accountId)
  if (!account) throw notFound('Account')
  account.label = cleaned
  saveRegistry(dir, registry)
}

export function setDefault(dir: string, accountId: string): Account {
  const account = find(dir, accountId)
  const registry = loadRegistry(dir)
  registry.defaults[account.provider] = account.id
  saveRegistry(dir, registry)
  return account
}

/** Drops the account from the registry, its pools, and the default. Its folder and secrets are the caller's to remove. */
export function forgetAccount(dir: string, account: Account): void {
  const registry = loadRegistry(dir)
  registry.accounts = registry.accounts.filter((entry) => entry.id !== account.id)
  if (registry.defaults[account.provider] === account.id) {
    const next = registry.accounts.find((entry) => entry.provider === account.provider)
    if (next) registry.defaults[account.provider] = next.id
    else delete registry.defaults[account.provider]
  }
  for (const pool of registry.pools) pool.accountIds = pool.accountIds.filter((id) => id !== account.id)
  saveRegistry(dir, registry)
}

export function savePool(dir: string, pool: { id?: string; label: string; accountIds: string[] }): Pool {
  const label = cleanLabel(pool.label)
  const registry = loadRegistry(dir)
  for (const id of pool.accountIds) {
    const account = registry.accounts.find((entry) => entry.id === id)
    if (!account) throw notFound('Account')
    if (account.provider !== PROVIDER) throw invalid('A pool holds accounts of one provider.')
  }
  const next: Pool = { id: pool.id ? safeId(pool.id) : newId(), provider: PROVIDER, label, accountIds: [...pool.accountIds] }
  registry.pools = [...registry.pools.filter((existing) => existing.id !== next.id), next]
  saveRegistry(dir, registry)
  return next
}

export function removePool(dir: string, poolId: string): void {
  const registry = loadRegistry(dir)
  registry.pools = registry.pools.filter((pool) => pool.id !== poolId)
  saveRegistry(dir, registry)
}
