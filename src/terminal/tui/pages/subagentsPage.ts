import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { CHROME_PAD, headerRow, neutralRule, padded, type TabInfo } from '../chrome'
import { FilterList, type ListRow, type RowTone } from '../list'
import type { TerminalPage } from '../page'
import { ACTIVE_SUBAGENT_STATUSES, terminalSubagentDuration, type TerminalSubagentActivity } from '../../subagentMonitor'
import { profileColor, opentuiTheme } from '../../opentui/theme'
import { subagentTasks } from '../../opentui/subagentsWidget'
import { formatTokenCount } from '../status'
import { getWorkingSpinnerFrames, SPINNER_INTERVAL_MS, spinnerFrameAt } from '../workingStatus'

export interface SubagentsPageOptions {
  theme(): Theme
  snapshot(): readonly TerminalSubagentActivity[]
  changed(): void
  now?(): number
}

const TABS = [{ id: 'subagents', title: 'Subagents' }] as const

function clean(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function statusGlyph(item: TerminalSubagentActivity, now: number): string {
  if (item.status === 'running') {
    const started = Date.parse(item.startedAt)
    return spinnerFrameAt(now - (Number.isFinite(started) ? started : now), getWorkingSpinnerFrames(process.env.TERM), SPINNER_INTERVAL_MS)
  }
  switch (item.status) {
    case 'queued': return '○'
    case 'waiting_for_approval':
    case 'waiting_for_input': return '●'
    case 'completed': return '✓'
    case 'failed': return '✕'
    case 'interrupted': return '!'
  }
}

function statusGlyphTone(item: TerminalSubagentActivity): RowTone {
  if (item.status === 'completed') return 'success'
  if (item.status === 'failed') return 'error'
  if (item.status === 'waiting_for_approval' || item.status === 'waiting_for_input') return 'accent'
  if (item.status === 'running') return 'warning'
  return 'muted'
}

function effectiveModel(item: TerminalSubagentActivity): string {
  const model = item.usage?.model
  if (model) return `${item.usage?.provider ? `${item.usage.provider}/` : ''}${model}`
  return item.model ?? '—'
}

function usageSummary(item: TerminalSubagentActivity): string {
  const usage = item.usage
  if (!usage) return 'usage —'
  const cache = [usage.cacheReadTokens, usage.cacheWriteTokens]
    .filter((value): value is number => typeof value === 'number' && value > 0)
    .map(formatTokenCount)
  const cost = typeof usage.costUsd === 'number'
    ? `${usage.costSource === 'estimate' ? '~' : ''}$${usage.costUsd.toFixed(usage.costUsd > 0 && usage.costUsd < 0.001 ? 5 : usage.costUsd < 0.01 ? 4 : 2).replace(/0+$/u, '').replace(/\.$/u, '')}`
    : ''
  const fields = [
    typeof usage.inputTokens === 'number' ? `↑${formatTokenCount(usage.inputTokens)}` : '',
    typeof usage.outputTokens === 'number' ? `↓${formatTokenCount(usage.outputTokens)}` : '',
    cache.some(Boolean) ? `c${cache.join('/')}` : '',
    cost,
    typeof usage.contextTokens === 'number' ? `ctx${formatTokenCount(usage.contextTokens)}${typeof usage.contextWindow === 'number' ? `/${formatTokenCount(usage.contextWindow)}` : ''}` : '',
    typeof usage.requests === 'number' ? `req${usage.requests}` : ''
  ].filter(Boolean)
  return fields.length ? fields.join(' ') : 'usage —'
}

function rowSubtitle(item: TerminalSubagentActivity, width: number): string {
  const available = Math.max(1, width - 2)
  const verbose = width >= 96
  const account = clean(item.accountLabel ?? '') || '—'
  const model = truncateToWidth(effectiveModel(item), 24, '…')
  const details = verbose
    ? [`acct ${account}`, `model ${model}`, `eff ${item.effort ?? '—'}`, usageSummary(item)].join(' · ')
    : [`a:${account}`, `m:${model}`, `e:${item.effort ?? '—'}`, usageSummary(item)].join(' · ')
  return truncateToWidth(details, available, '…')
}

export class SubagentsPage implements TerminalPage {
  presentation = 'fullscreen' as const
  private readonly list: FilterList<TerminalSubagentActivity>

  constructor(private readonly options: SubagentsPageOptions) {
    this.list = new FilterList({
      theme: options.theme, search: 'always', noun: ['subagent', 'subagents'], rowGap: 1,
      empty: 'No subagents have started in the latest run'
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'subagents' }
  hint(): string { return '↑↓ select · type to search' }

  private rows(width = 80, now = this.options.now?.() ?? Date.now()): ListRow<TerminalSubagentActivity>[] {
    const ordered = [...this.options.snapshot()].sort((left, right) => {
      const active = Number(ACTIVE_SUBAGENT_STATUSES.has(right.status)) - Number(ACTIVE_SUBAGENT_STATUSES.has(left.status))
      return active || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id)
    })
    return ordered.map(item => {
      const profile = clean(item.profile?.name ?? '') || 'subagent'
      const title = clean(item.title) || 'Subagent'
      const color = item.profile?.color ? profileColor(opentuiTheme, item.profile.color) : null
      const glyph = statusGlyph(item, now)
      const labelParts = [
        { text: `${glyph} `, ...(item.status === 'running' && color ? { color } : { tone: statusGlyphTone(item) }) },
        { text: profile, ...(color ? { color } : { tone: 'muted' as const }) },
        { text: `  ${title}` }
      ]
      return {
        id: item.id,
        label: labelParts.map(part => part.text).join(''),
        labelParts,
        subtitle: rowSubtitle(item, width),
        searchText: `${profile} ${title} ${item.goal ?? ''} ${item.status} ${item.activity} ${item.accountLabel ?? ''} ${effectiveModel(item)} ${item.effort ?? ''} ${usageSummary(item)}`,
        data: item
      }
    })
  }

  render(width: number, rows: number): string[] {
    const items = this.rows(width, this.options.now?.() ?? Date.now())
    this.list.setRows(items)
    const active = items.filter(item => item.data && ACTIVE_SUBAGENT_STATUSES.has(item.data.status)).length
    const selected = this.list.selected?.data
    const header = headerRow('Subagents', `${active} active · ${items.length} total`, width, this.options.theme())
    const bodyRows = Math.max(0, rows - 7)
    const listRows = Math.max(1, Math.min(this.list.height, Math.floor(bodyRows * 0.6)))
    const output = [header, '', ...this.list.render(width, listRows), '']
    if (selected) {
      const theme = this.options.theme()
      const detailIndent = ' '.repeat(CHROME_PAD * 2)
      const detailLines = (text: string) => wrapTextWithAnsi(theme.fg('text', clean(text)), Math.max(1, width - detailIndent.length))
        .map(line => `${detailIndent}${line}`)
      output.push(neutralRule(width, theme))
      output.push(padded(theme.fg('muted', `Profile: ${clean(selected.profile?.name ?? '') || 'copy of the parent'}`), width))
      output.push(padded(theme.fg('accent', 'Task'), width))
      output.push(...detailLines(selected.goal || 'Subagent'))
      output.push(padded(theme.fg('muted', `Status: ${[selected.status.replaceAll('_', ' '), subagentTasks(selected.checklist), terminalSubagentDuration(selected)].filter(Boolean).join(' · ')}`), width))
      output.push(padded(theme.fg('accent', 'Current activity'), width))
      output.push(...detailLines(selected.activity))
    } else {
      output.push(padded(this.options.theme().fg('muted', 'The selected subagent’s task and current activity appear here.'), width))
    }
    return output.slice(0, Math.max(0, rows)).map(line => truncateToWidth(line, width, ''))
  }

  handleInput(data: string): boolean {
    this.list.setRows(this.rows())
    if (matchesKey(data, 'enter')) return this.list.handleInput(data)
    if (this.list.handleInput(data)) {
      this.options.changed()
      return true
    }
    return false
  }
}
