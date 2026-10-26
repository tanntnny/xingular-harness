// `/usage:analysis` and `/usage:limit`: one centered dialog with two tabs. It reads the derived
// usage ledger and the provider readings the accounts already hold; the page never touches a run
// file, a credential or the network itself.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { UsageLimitsReport } from '../../../usage/limits/types'
import type { UsagePeriod, UsageRow, UsageScope, UsageSummary, UsageTotals } from '../../../usage/types'
import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'

type UsageTab = 'analysis' | 'limits'

interface UsagePageOptions {
  theme(): Theme
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  changed(): void
  initialTab?: UsageTab
  initialPeriod?: UsagePeriod
}

const PERIODS: { key: string; period: UsagePeriod; label: string }[] = [
  { key: '1', period: 'today', label: 'today' },
  { key: '2', period: '7d', label: '7d' },
  { key: '3', period: '30d', label: '30d' },
  { key: '0', period: 'all', label: 'all time' }
]

const SCOPES: { key: string; scope: UsageScope; label: string }[] = [
  { key: 'c', scope: 'account', label: 'account' },
  { key: 's', scope: 'session', label: 'session' },
  { key: 'p', scope: 'project', label: 'project' },
  { key: 'a', scope: 'all', label: 'all accounts' }
]

const BARS = '▁▂▃▄▅▆▇█'

function clean(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\t/g, ' ')
}

function oneLine(value: string): string {
  return clean(value).replace(/\s+/g, ' ').trim()
}

function count(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function money(value: number | null): string {
  if (value === null) return '—'
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const delta = at - now
  if (delta <= 0) return 'reset due'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `resets in ${hours}h ${minutes % 60}m`
  return `resets in ${Math.floor(hours / 24)}d`
}

function ago(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 'unknown time'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function usageLine(totals: UsageTotals): string {
  const parts = [
    `${count(totals.inputTokens)} in`,
    `${count(totals.cacheReadTokens)} cached`,
    `${count(totals.outputTokens)} out`,
    `${count(totals.requests)} requests`,
    money(totals.costUsd)
  ]
  if (totals.unpricedRequests) parts.push(`${totals.unpricedRequests} unpriced`)
  return parts.join(' · ')
}

function share(value: number, total: number): string {
  if (!total) return '0%'
  return `${Math.round((value / total) * 100)}%`
}

function tokensOf(row: UsageTotals): number {
  return row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens
}

type BarTone = 'success' | 'warning' | 'error' | 'dim'

/** A quota-left bar: green with room, amber when it narrows, red when it runs out. */
function barTone(percent: number | null | undefined, rejected = false): BarTone {
  if (rejected) return 'error'
  if (percent === null || percent === undefined) return 'dim'
  if (percent >= 50) return 'success'
  if (percent >= 20) return 'warning'
  return 'error'
}

function bar(percent: number | null | undefined, width: number, theme: Theme, rejected = false): string {
  const track = '░'.repeat(width)
  if (percent === null || percent === undefined) return `[${theme.fg('dim', track)}]`
  const filled = Math.max(0, Math.min(width, Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)))
  return `[${theme.fg(barTone(percent, rejected), '█'.repeat(filled))}${theme.fg('dim', '░'.repeat(Math.max(0, width - filled)))}]`
}

/** A label on the left and a quiet value on the right of the same row. */
function spread(left: string, right: string, width: number): string {
  if (!right) return left
  const rightText = truncateToWidth(right, Math.max(0, width - visibleWidth(left) - 2), '')
  return left + ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(rightText))) + rightText
}

export class UsagePage implements TerminalPage {
  presentation = 'centered' as const
  focused = false
  private tab: UsageTab
  private period: UsagePeriod = '7d'
  private scope: UsageScope = 'account'
  private summary?: UsageSummary
  private limitsSummary?: UsageSummary
  private limits?: UsageLimitsReport
  private busy = false
  private error?: string
  private refreshLimits: boolean
  private offset = 0
  private scrollRows = 1
  private maxOffset = 0
  private disposed = false

  constructor(private readonly options: UsagePageOptions) {
    this.tab = options.initialTab ?? 'analysis'
    this.period = options.initialPeriod ?? '7d'
    this.refreshLimits = this.tab === 'limits'
  }

  tabs(): readonly TabInfo[] {
    return [{ id: 'analysis', title: 'Analysis' }, { id: 'limits', title: 'Limits' }]
  }

  activeTab(): string {
    return this.tab
  }

  selectTab(id: string): void {
    if ((id === 'analysis' || id === 'limits') && id !== this.tab) {
      this.tab = id
      this.offset = 0
      this.options.changed()
      if (id === 'limits' && !this.limits) {
        this.refreshLimits = true
        void this.load()
      }
      else if (id === 'analysis' && !this.summary) void this.load()
      else if (id === 'limits' && this.refreshLimits) void this.load()
    }
  }

  hint(): string {
    return this.tab === 'analysis'
      ? '↑/↓ scroll · PgUp/PgDn page · 1 today 2 7d 3 30d 0 all · c account s session p project a all accounts · r refresh · Tab limits · Esc close'
      : '↑/↓ scroll · PgUp/PgDn page · r read provider limits · Tab analysis · Esc close'
  }

  activate(): void {
    if (!this.summary && !this.limits) void this.load()
  }

  dispose(): void {
    this.disposed = true
  }

  private async load(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.error = undefined
    this.options.changed()
    try {
      if (this.tab === 'analysis') {
        this.summary = await this.options.call('terminal.usage.summary', {
          scope: this.scope,
          period: this.period,
          timezoneOffsetMinutes: -new Date().getTimezoneOffset()
        }) as UsageSummary
      } else {
        // The provider's windows and this app's own ledger answer different questions; show both.
        const [limits, summary] = await Promise.all([
          this.options.call('terminal.usage.limits', { refresh: this.refreshLimits }),
          this.options.call('terminal.usage.summary', {
            scope: 'account',
            period: '7d',
            timezoneOffsetMinutes: -new Date().getTimezoneOffset()
          })
        ])
        this.limits = limits as UsageLimitsReport
        this.limitsSummary = summary as UsageSummary
        this.refreshLimits = false
      }
      this.offset = 0
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Usage could not be read.'
    } finally {
      this.busy = false
      if (!this.disposed) this.options.changed()
    }
  }

  handleInput(data: string): boolean {
    const page = Math.max(1, this.scrollRows - 1)
    if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down')) this.offset = Math.min(this.maxOffset, this.offset + 1)
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - page)
    else if (matchesKey(data, 'pageDown')) this.offset = Math.min(this.maxOffset, this.offset + page)
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = this.maxOffset
    else if (data === 'r') {
      if (this.tab === 'limits') this.refreshLimits = true
      void this.load()
    } else if (this.tab === 'analysis' && PERIODS.some((entry) => entry.key === data)) {
      this.period = PERIODS.find((entry) => entry.key === data)!.period
      void this.load()
    } else if (this.tab === 'analysis' && SCOPES.some((entry) => entry.key === data)) {
      this.scope = SCOPES.find((entry) => entry.key === data)!.scope
      void this.load()
    } else return false
    this.options.changed()
    return true
  }

  private analysisContent(width: number, theme: Theme): { header: string[]; body: string[] } {
    const summary = this.summary
    const header: string[] = []
    if (!summary) {
      header.push(theme.fg(this.error ? 'error' : 'dim', this.error ?? (this.busy ? 'Reading usage…' : 'No usage to show.')))
      return { header, body: [] }
    }
    const scope = SCOPES.find((entry) => entry.scope === summary.scope)?.label ?? summary.scope
    const period = PERIODS.find((entry) => entry.period === summary.period)?.label ?? summary.period
    header.push(theme.bold(theme.fg('accent', `${scope} · ${period}`)))
    header.push(...wrapTextWithAnsi(theme.fg('muted', usageLine(summary.totals)), width))
    const details = [
      summary.totals.cacheHitPercent === null ? null : `${summary.totals.cacheHitPercent}% cache hits`,
      `TTFT ${duration(summary.totals.avgTtftMs)}`,
      `request ${duration(summary.totals.avgDurationMs)}`,
      summary.totals.estimatedCostUsd ? `${money(summary.totals.estimatedCostUsd)} estimated` : null
    ].filter((entry): entry is string => Boolean(entry))
    if (details.length) header.push(...wrapTextWithAnsi(theme.fg('dim', details.join(' · ')), width))
    if (this.error) header.push(...wrapTextWithAnsi(theme.fg('error', this.error), width))

    const body: string[] = ['']
    const total = tokensOf(summary.totals)
    const gap = (): void => {
      if (body.length && body[body.length - 1] !== '') body.push('')
    }
    if (summary.byDay.length) {
      const max = Math.max(...summary.byDay.map((day) => day.inputTokens + day.cacheReadTokens + day.outputTokens), 1)
      const spark = summary.byDay.slice(-14).map((day) => BARS[Math.min(BARS.length - 1, Math.round(((day.inputTokens + day.cacheReadTokens + day.outputTokens) / max) * (BARS.length - 1)))]).join('')
      body.push(theme.fg('accent', spark))
      for (const day of summary.byDay.slice(-3).reverse()) {
        body.push(...wrapTextWithAnsi(theme.fg('muted', `  ${day.day}  ${count(day.inputTokens + day.cacheReadTokens + day.outputTokens)} tokens · ${count(day.requests)} requests · ${money(day.costUsd)}`), width))
      }
    }
    const section = (rows: UsageRow[]): void => {
      if (!rows.length) return
      gap()
      for (const row of rows) {
        const line = `  ${oneLine(row.label)}  ${share(tokensOf(row), total)}  ${count(tokensOf(row))} tokens · ${count(row.requests)} requests · ${money(row.costUsd)}`
        body.push(...wrapTextWithAnsi(theme.fg('muted', line), width))
      }
    }
    section(summary.byModel)
    section(summary.byProvider)
    section(summary.byAccount)
    section(summary.bySession)
    if (body.length === 1) body.push(theme.fg('dim', 'No requests were recorded in this period.'))
    while (body.length > 1 && body[body.length - 1] === '') body.pop()
    return { header, body }
  }

  private limitsContent(width: number, theme: Theme): { header: string[]; body: string[] } {
    const report = this.limits
    const header: string[] = []
    if (!report) {
      header.push(theme.fg(this.error ? 'error' : 'dim', this.error ?? (this.busy ? 'Reading provider limits…' : 'No limit readings yet.')))
      return { header, body: [] }
    }
    if (this.error) header.push(...wrapTextWithAnsi(theme.fg('error', this.error), width))
    const body: string[] = []
    const barWidth = Math.max(8, Math.min(16, Math.floor(width / 6)))
    for (const account of report.accounts) {
      if (body.length) body.push('')
      body.push(theme.bold(oneLine(account.label)) + theme.fg('dim', `${account.plan ? ` · ${oneLine(account.plan)}` : ''} · ${account.health}`))
      if (!account.providers.length) {
        body.push(theme.fg('dim', '  No limit readings.'))
        continue
      }
      for (const provider of account.providers) {
        body.push('')
        const source = provider.source === 'provider' ? '' : provider.source
        const meta = [source, ago(provider.observedAt)].filter(Boolean).join(' · ')
        const tone = provider.source === 'unavailable' ? 'warning' : 'muted'
        body.push(...wrapTextWithAnsi(theme.fg(tone, `  ${provider.provider}${meta ? ` · ${meta}` : ''}${provider.reason ? ` · ${oneLine(provider.reason)}` : ''}`), width))
        for (const limit of provider.limits) {
          body.push('')
          const reset = until(limit.resetsAt)
          body.push(...wrapTextWithAnsi(spread(theme.bold(`  ${oneLine(limit.label)}`), theme.fg('dim', reset), width), width))
          const used = limit.usedPercent ?? null
          const remainingPercent = limit.remainingPercent
            ?? (used === null
              ? limit.remaining !== null && limit.remaining !== undefined && limit.limit !== null && limit.limit !== undefined && limit.limit > 0
                ? Math.max(0, Math.min(100, (limit.remaining / limit.limit) * 100))
                : null
              : Math.max(0, Math.min(100, 100 - used)))
          const rejected = limit.status === 'rejected'
          const tone = barTone(remainingPercent, rejected)
          const absolute = limit.remaining !== null && limit.remaining !== undefined
            ? `${limit.unit === 'usd' ? money(limit.remaining) : limit.unit === 'currency' ? `${limit.remaining.toFixed(2)} ${limit.detail ?? ''}`.trim() : count(limit.remaining)} left`
            : limit.limit !== null && limit.limit !== undefined
              ? `limit ${count(limit.limit)}${limit.unit && limit.unit !== 'percent' ? ` ${limit.unit}` : ''}`
              : ''
          const value = remainingPercent === null ? absolute || '—' : `${Math.round(remainingPercent)}% left`
          const suffix = remainingPercent !== null && absolute ? `  ${theme.fg('dim', absolute)}` : ''
          body.push(...wrapTextWithAnsi(`  ${bar(remainingPercent, barWidth, theme, rejected)}  ${theme.fg(tone, value)}${suffix}`, width))
        }
      }
    }
    if (!report.accounts.length) body.push(theme.fg('dim', 'No accounts.'))
    const local = this.limitsSummary?.totals
    if (local) {
      if (body.length) body.push('')
      body.push(...wrapTextWithAnsi(theme.fg('dim', `7d · ${count(local.inputTokens + local.cacheReadTokens + local.outputTokens)} tokens · ${count(local.requests)} requests · ${money(local.costUsd)}`), width))
    }
    return { header, body }
  }

  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    const { header, body } = this.tab === 'analysis' ? this.analysisContent(width, theme) : this.limitsContent(width, theme)
    const bodyRows = Math.max(0, rows - header.length)
    this.scrollRows = Math.max(1, bodyRows)
    this.maxOffset = Math.max(0, body.length - bodyRows)
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset))
    return [...header, ...body.slice(this.offset, this.offset + bodyRows)].slice(0, rows).map((line) => truncateToWidth(line, width, ''))
  }
}
