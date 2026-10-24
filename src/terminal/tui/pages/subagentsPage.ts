import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { headerRow, neutralRule, padded, type TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalPage } from '../page'
import { ACTIVE_SUBAGENT_STATUSES, terminalSubagentDuration, terminalSubagentTone, type TerminalSubagentActivity } from '../../subagentMonitor'
import { subagentTasks } from '../../opentui/subagentsWidget'

export interface SubagentsPageOptions {
  theme(): Theme
  snapshot(): readonly TerminalSubagentActivity[]
  changed(): void
}

const TABS = [{ id: 'subagents', title: 'Subagents' }] as const

function clean(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}

export class SubagentsPage implements TerminalPage {
  presentation = 'fullscreen' as const
  private readonly list: FilterList<TerminalSubagentActivity>

  constructor(private readonly options: SubagentsPageOptions) {
    this.list = new FilterList({
      theme: options.theme, search: 'always', noun: ['subagent', 'subagents'], empty: 'No subagents have started in this turn'
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'subagents' }
  hint(): string { return '↑↓ select · type to search' }

  private rows(): ListRow<TerminalSubagentActivity>[] {
    return this.options.snapshot().map(item => ({
      id: item.id,
      label: `${clean(item.profile?.name ?? '') || 'subagent'} · ${clean(item.title) || 'Subagent'}`,
      detail: [item.status.replaceAll('_', ' '), subagentTasks(item.checklist), terminalSubagentDuration(item)].filter(Boolean).join(' · '),
      tone: terminalSubagentTone(item.status),
      searchText: `${item.profile?.name ?? ''} ${item.title} ${item.goal ?? ''} ${item.status} ${item.activity}`,
      data: item
    }))
  }

  render(width: number, rows: number): string[] {
    const items = this.rows()
    this.list.setRows(items)
    const active = items.filter(item => item.data && ACTIVE_SUBAGENT_STATUSES.has(item.data.status)).length
    const selected = this.list.selected?.data
    const header = headerRow('Subagents', `${active} active · ${items.length} total`, width, this.options.theme())
    const bodyRows = Math.max(0, rows - 7)
    const listRows = Math.max(1, Math.min(this.list.height, Math.floor(bodyRows * 0.6)))
    const output = [header, '', ...this.list.render(width, listRows), '']
    if (selected) {
      const theme = this.options.theme()
      const textWidth = Math.max(1, width - 4)
      output.push(neutralRule(width, theme))
      output.push(padded(theme.fg('muted', `Profile: ${clean(selected.profile?.name ?? '') || 'copy of the parent'}`), width))
      output.push(padded(theme.fg('accent', 'Task'), width))
      output.push(...wrapTextWithAnsi(theme.fg('text', clean(selected.goal || 'Subagent')), textWidth))
      output.push(padded(theme.fg('muted', `Status: ${[selected.status.replaceAll('_', ' '), subagentTasks(selected.checklist), terminalSubagentDuration(selected)].filter(Boolean).join(' · ')}`), width))
      output.push(padded(theme.fg('accent', 'Current activity'), width))
      output.push(...wrapTextWithAnsi(theme.fg('text', clean(selected.activity)), textWidth))
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
