// `/usage:analysis`: one façade over the derived usage ledger. The terminal resolves whose usage
// is asked for; a host may pass ids explicitly. No method here reads a run's raw events.
import type { Accounts } from '../accounts/accounts'
import { invalid } from '../core/errors'
import { summarize, type RatesLookup } from './analytics'
import { indexedRuns, lastIndexedAt, syncUsage } from './ledger'
import { modelRates } from '../sessions/pricing'
import { USAGE_PERIODS, type UsageFilter, type UsagePeriod, type UsageScope, type UsageSummary } from './types'

export interface UsageOptions {
  root: () => string
  accounts: Accounts
  rates?: RatesLookup
  now?: () => Date
}

export interface UsageSummaryInput {
  scope?: UsageScope | null
  sessionId?: string | null
  accountId?: string | null
  projectId?: string | null
  period?: UsagePeriod | null
  timezoneOffsetMinutes?: number | null
}

export class Usage {
  private readonly now: () => Date
  private readonly rates: RatesLookup

  constructor(private readonly options: UsageOptions) {
    this.now = options.now ?? (() => new Date())
    // List rates only price a request the provider did not price; a failed lookup leaves it unknown.
    this.rates = options.rates ?? ((provider, model) => modelRates(provider, model))
  }

  /** The one question the analysis page asks. */
  async summary(input: UsageSummaryInput): Promise<UsageSummary> {
    const root = this.options.root()
    // A data root that has never been indexed gets one bounded catch-up pass on first use.
    if (!lastIndexedAt(root)) syncUsage(root)
    const period: UsagePeriod = input.period && (USAGE_PERIODS as readonly string[]).includes(input.period) ? input.period : '7d'
    const scope: UsageScope = input.scope === 'session' || input.scope === 'project' || input.scope === 'all' || input.scope === 'account'
      ? input.scope
      : input.sessionId ? 'session' : input.projectId ? 'project' : input.accountId ? 'account' : 'all'
    const filter = this.filter(scope, input)
    const labels = new Map(this.options.accounts.overview().accounts.map((account) => [account.id, account.label]))
    return summarize({
      root,
      filter,
      period,
      timezoneOffsetMinutes: typeof input.timezoneOffsetMinutes === 'number' ? input.timezoneOffsetMinutes : 0,
      accountLabel: (id) => labels.get(id) ?? id.slice(0, 8),
      rates: this.rates,
      now: this.now()
    })
  }

  /** Indexes runs the ledger has not seen, such as runs recorded by an earlier process. */
  sync(): { runs: number; indexed: number; lastIndexedAt: string | null } {
    const root = this.options.root()
    const runs = syncUsage(root)
    return { runs, indexed: indexedRuns(root).length, lastIndexedAt: lastIndexedAt(root) }
  }

  private filter(scope: UsageScope, input: UsageSummaryInput): UsageFilter {
    const overview = this.options.accounts.overview()
    const defaultAccount = overview.defaults.pi ?? overview.accounts[0]?.id ?? null
    switch (scope) {
      case 'session':
        if (!input.sessionId) throw invalid('A session id is required for session usage.')
        return { session: input.sessionId, account: null, project: null }
      case 'project':
        if (!input.projectId) throw invalid('A project id is required for project usage.')
        return { session: null, account: null, project: input.projectId }
      case 'account': {
        const accountId = input.accountId ?? defaultAccount
        if (!accountId) throw invalid('An account is required for account usage.')
        return { session: null, account: accountId, project: null }
      }
      default:
        return { session: null, account: null, project: null }
    }
  }
}
