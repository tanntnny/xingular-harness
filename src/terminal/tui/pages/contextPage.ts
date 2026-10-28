// `/context`: what the latest request was made of, one row per contributor, with the share of the
// window each one takes and where the rest of it went. The page only reads: `terminal.context`
// answers with the attribution and, on request, the text of one row.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { ContextAttribution, ContextGroup, ContextRow } from '../../../context/types'
import { CHROME_PAD, headerRow, neutralRule, padded, selectedRow, selectionMuted, selectionText, type TabInfo } from '../chrome'
import type { TerminalPage } from '../page'

export type ContextTab = 'request' | 'growth'
export type ContextGrouping = 'owner' | 'kind'

interface ContextPageOptions {
  theme(): Theme
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  changed(): void
  initialTab?: ContextTab
  /** Opens the variant editor for the row the person wants to shrink. */
  openVariant?(): void
  /** Runs the session's compaction, after the page confirms what it would free. */
  compact?(): Promise<void>
  confirm?(title: string, message: string): Promise<boolean>
}

const BARS = '▁▂▃▄▅▆▇█'
const OWNER_TITLES: Record<ContextGroup, string> = {
  foundation: 'Foundation · harness',
  variant: 'Variant',
  application: 'Your application',
  conversation: 'Conversation',
  reserved: 'Reserved and free'
}
const OWNER_ORDER: readonly ContextGroup[] = ['foundation', 'variant', 'application', 'conversation', 'reserved']
const KIND_ORDER = ['System prompt', 'Tools', 'Memory', 'Skills', 'Messages', 'Reserved'] as const
type Kind = (typeof KIND_ORDER)[number]

function kindOf(row: ContextRow): Kind {
  if (row.group === 'reserved') return 'Reserved'
  if (row.id === 'messages' || row.id === 'context-update' || row.id === 'references' || row.id === 'required-skills' || row.id === 'wiki' || row.id === 'session-state') return 'Messages'
  if (row.id === 'memory') return 'Memory'
  if (row.id === 'skills') return 'Skills'
  if (row.id === 'tools' || row.id === 'tools-harness' || row.id === 'tools-application' || row.id === 'tool-guidance') return 'Tools'
  return 'System prompt'
}

function count(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function percent(value: number | null): string {
  return value === null ? '?' : `${value.toFixed(1)}%`
}

function tone(share: number | null): 'error' | 'warning' | 'success' | 'dim' {
  if (share === null) return 'dim'
  if (share >= 90) return 'error'
  if (share >= 70) return 'warning'
  return 'success'
}

/** A context bar: filled as the window is used, with room left in the track. */
function usageBar(share: number | null, width: number, theme: Theme): string {
  const room = Math.max(1, width - 2)
  const track = '░'.repeat(room)
  if (share === null) return `[${theme.fg('dim', track)}]`
  const filled = Math.max(0, Math.min(room, Math.round((Math.max(0, Math.min(100, share)) / 100) * room)))
  return `[${theme.fg(tone(share), '█'.repeat(filled))}${theme.fg('dim', '░'.repeat(room - filled))}]`
}

/** A label on the left and a quiet value at the right edge of the same row. */
function spread(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, '')
  const room = Math.max(0, width - visibleWidth(left) - 2)
  const value = truncateToWidth(right, room, '')
  return left + ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(value))) + value
}

interface Entry {
  row: ContextRow
  /** Its group heading, printed when it differs from the entry above. */
  heading: string | null
  folded: boolean
}

export class ContextPage implements TerminalPage {
  presentation = 'fullscreen' as const
  focused = false
  private tab: ContextTab
  private grouping: ContextGrouping = 'owner'
  private data: ContextAttribution | null = null
  private detail: { id: string; title: string; text: string } | null = null
  private selectedId: string | null = null
  private folded = new Set<ContextGroup>()
  private offset = 0
  private detailOffset = 0
  private maxOffset = 0
  private scrollRows = 1
  private busy = false
  private reloadPending = false
  private error: string | null = null
  private disposed = false

  constructor(private readonly options: ContextPageOptions) {
    this.tab = options.initialTab ?? 'request'
  }

  tabs(): readonly TabInfo[] {
    return [{ id: 'request', title: 'Request' }, { id: 'growth', title: 'Growth' }]
  }

  activeTab(): string {
    return this.tab
  }

  selectTab(id: string): void {
    if (id !== 'request' && id !== 'growth') return
    if (id === this.tab) return
    this.tab = id
    this.offset = 0
    this.detail = null
    this.options.changed()
    if (!this.data) void this.load()
  }

  hint(): string {
    if (this.detail) return '↑/↓ scroll · esc close · q close page'
    return this.tab === 'request'
      ? '↑/↓ move · space fold · enter text · g group · c compact · v variant · r refresh · q close'
      : '↑/↓ scroll · r refresh · q close'
  }

  activate(): void {
    if (!this.data) void this.load()
  }

  dispose(): void {
    this.disposed = true
  }

  private async load(section?: string): Promise<void> {
    if (this.disposed) return
    if (this.busy) {
      this.reloadPending = true
      return
    }
    this.busy = true
    this.error = null
    this.options.changed()
    try {
      const answer = await this.options.call('terminal.context', section ? { section } : {}) as { attribution?: ContextAttribution | null; text?: { id: string; title: string; text: string } | null }
      if (this.disposed) return
      this.data = answer.attribution ?? null
      if (section) {
        if (answer.text) this.detail = answer.text
        else this.error = 'That row carries no text: it is measured, not written.'
        this.detailOffset = 0
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'The context could not be read.'
    } finally {
      this.busy = false
      this.options.changed()
      if (this.reloadPending) {
        this.reloadPending = false
        void this.load()
      }
    }
  }

  handleInput(data: string): boolean {
    if (this.detail) {
      const page = Math.max(1, this.scrollRows - 2)
      if (matchesKey(data, 'up')) this.detailOffset = Math.max(0, this.detailOffset - 1)
      else if (matchesKey(data, 'down')) this.detailOffset += 1
      else if (matchesKey(data, 'pageUp')) this.detailOffset = Math.max(0, this.detailOffset - page)
      else if (matchesKey(data, 'pageDown')) this.detailOffset += page
      else if (matchesKey(data, 'escape') || data === 'q') {
        this.detail = null
        this.options.changed()
      } else return false
      this.options.changed()
      return true
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const tabs: ContextTab[] = ['request', 'growth']
      const direction = matchesKey(data, 'shift+tab') ? -1 : 1
      this.selectTab(tabs[(tabs.indexOf(this.tab) + direction + tabs.length) % tabs.length]!)
      return true
    }
    const entries = this.entries()
    const current = Math.max(0, entries.findIndex((entry) => entry.row.id === this.selectedId))
    if (matchesKey(data, 'up')) this.move(entries, current - 1)
    else if (matchesKey(data, 'down')) this.move(entries, current + 1)
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = this.maxOffset
    else if (data === ' ' && entries[current]) {
      const row = entries[current]!.row
      if (this.folded.has(row.group)) this.folded.delete(row.group)
      else this.folded.add(row.group)
    } else if (matchesKey(data, 'enter') && entries[current]) {
      void this.load(entries[current]!.row.id)
      return true
    } else if (data === 'g') {
      this.grouping = this.grouping === 'owner' ? 'kind' : 'owner'
      this.folded.clear()
      this.offset = 0
    } else if (data === 'r') {
      void this.load()
      return true
    } else if (data === 'c') {
      void this.compact()
      return true
    } else if (data === 'v') {
      this.options.openVariant?.()
      return true
    } else return false
    this.options.changed()
    return true
  }

  private move(entries: readonly Entry[], index: number): void {
    if (!entries.length) return
    const next = entries[Math.max(0, Math.min(entries.length - 1, index))]
    if (next) this.selectedId = next.row.id
  }

  private async compact(): Promise<void> {
    if (!this.options.compact) return
    const free = this.data?.free === null || this.data?.free === undefined ? null : this.data.free
    const question = free === null
      ? 'Pi will summarize this conversation and start the next request from the summary.'
      : `Pi will summarize this conversation. About ${count(free)} tokens are free before it does.`
    if (this.options.confirm && !(await this.options.confirm('Compact the conversation now?', question))) return
    try {
      await this.options.compact()
      await this.load()
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'Compaction failed.'
      this.options.changed()
    }
  }

  /** The rows in the order the page draws them, with the heading each one introduces. */
  private entries(): Entry[] {
    const rows = this.data?.rows ?? []
    if (this.grouping === 'owner') {
      const ordered = [...rows].sort((left, right) => OWNER_ORDER.indexOf(left.group) - OWNER_ORDER.indexOf(right.group))
      const out: Entry[] = []
      for (const row of ordered) {
        const previous = out.at(-1)?.row.group
        out.push({ row, heading: previous === row.group ? null : (OWNER_TITLES[row.group] ?? row.group), folded: this.folded.has(row.group) })
      }
      return out
    }
    const ordered = [...rows].sort((left, right) => KIND_ORDER.indexOf(kindOf(left)) - KIND_ORDER.indexOf(kindOf(right)))
    const out: Entry[] = []
    let last: string | null = null
    for (const row of ordered) {
      const kind = kindOf(row)
      const folded = this.folded.has(kind as ContextGroup)
      out.push({ row, heading: last === kind ? null : kind, folded })
      last = kind
    }
    return out
  }

  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    const data = this.data
    const meta = data ? `${count(data.used)} / ${data.window === null ? '?' : count(data.window)} · ${percent(data.share)}` : undefined
    const header = [headerRow('Context', meta, width, theme), neutralRule(width, theme)]
    const body = this.detail ? this.detailBody(width, theme) : this.tab === 'growth' ? this.growthBody(width, theme) : this.requestBody(width, theme)
    const list = this.detail ? body : body
    const room = Math.max(0, rows - header.length - 2)
    this.scrollRows = Math.max(1, room)
    const offset = this.detail ? Math.min(this.detailOffset, Math.max(0, list.length - room)) : Math.min(this.offset, Math.max(0, list.length - room))
    this.maxOffset = Math.max(0, list.length - room)
    if (this.detail) this.detailOffset = offset
    else this.offset = offset
    const footer = [neutralRule(width, theme), padded(theme.fg('dim', this.hint()), width)]
    return [...header, ...list.slice(offset, offset + room), ...footer].map((line) => truncateToWidth(line, width, ''))
  }

  private requestBody(width: number, theme: Theme): string[] {
    const data = this.data
    if (!data) {
      return [padded(theme.fg(this.error ? 'error' : 'dim', this.error ?? (this.busy ? 'Reading the recorded context…' : 'No reply yet: the next request records what it is made of.')), width)]
    }
    const inner = Math.max(8, width - CHROME_PAD * 2)
    const body: string[] = []
    body.push(padded(spread(
      theme.fg('text', `${count(data.used)} of ${data.window === null ? 'an unknown window' : count(data.window)}`),
      theme.fg(tone(data.share), `${percent(data.share)} used · ${data.source}`),
      inner
    ), width))
    body.push(padded(usageBar(data.share, inner, theme), width))
    body.push('')
    for (const entry of this.entries()) {
      if (entry.heading) {
        const total = data.rows.filter((row) => (this.grouping === 'owner' ? OWNER_TITLES[row.group] === entry.heading : kindOf(row) === entry.heading)).reduce((sum, row) => sum + row.tokens, 0)
        body.push(padded(theme.bold(theme.fg('accent', entry.heading)) + theme.fg('dim', `  ${count(total)}`), width))
      }
      if (entry.folded) continue
      body.push(this.rowLine(entry.row, inner, width, theme))
    }
    body.push('')
    body.push(padded(theme.fg('dim', `free ${data.free === null ? '?' : count(data.free)}${data.compaction ? ` · reserve ${count(data.compaction.reserveTokens)}` : ''}`), width))
    if (data.onDemand.length) {
      body.push('')
      body.push(padded(theme.fg('accent', 'On demand') + theme.fg('dim', '  not in this request'), width))
      for (const item of data.onDemand) {
        const cost = item.tokensEach === null ? (item.note ?? '') : `about ${count(item.tokensEach)} each · ${item.note ?? ''}`
        body.push(padded(`  ${theme.fg('text', item.title)}  ${theme.fg('dim', `${item.items} available · ${cost}`)}`, width))
      }
    }
    if (data.note) {
      body.push('')
      body.push(...wrapTextWithAnsi(theme.fg('dim', data.note), inner).map((line) => padded(line, width)))
    }
    if (this.error) body.push(padded(theme.fg('error', this.error), width))
    return body
  }

  private rowLine(row: ContextRow, inner: number, width: number, theme: Theme): string {
    const selected = row.id === this.selectedId
    const marker = selected ? '❯ ' : row.always ? '  ' : '· '
    const budget = row.budget ? `  ${count(row.tokens * 4)} of ${count(row.budget)} chars` : ''
    const tools = row.tools?.length ? `  ${row.tools.map((tool) => `${tool.group} ${tool.count}`).join(' · ')}` : ''
    const note = row.note ? `  ${row.note}` : ''
    const tail = `${count(row.tokens).padStart(7)}${percent(row.share).padStart(7)}`
    const label = `${marker}${row.title}`
    const fixed = visibleWidth(tail) + 1
    const left = truncateToWidth(label, Math.max(4, inner - fixed - visibleWidth(budget) - visibleWidth(tools) - visibleWidth(note)), '…')
    const line = `${left}${' '.repeat(Math.max(1, inner - visibleWidth(left) - fixed))}${tail}`
    if (selected) return selectedRow(padded(line, width), width, theme)
    const rest = `${budget}${tools}${note}`
    if (rest && inner > visibleWidth(line) + visibleWidth(rest)) {
      const quiet = theme.fg('dim', rest)
      return padded(selected ? selectionMuted(theme, line) : line + ' '.repeat(Math.max(1, inner - visibleWidth(line) - visibleWidth(rest))) + quiet, width)
    }
    return padded(selected ? selectionText(theme, line) : line, width)
  }

  private growthBody(width: number, theme: Theme): string[] {
    const data = this.data
    if (!data) return [padded(theme.fg('dim', this.busy ? 'Reading the recorded context…' : 'No reply yet.'), width)]
    const inner = Math.max(8, width - CHROME_PAD * 2)
    const body: string[] = []
    const history = data.history.slice(-24)
    if (history.length) {
      const peak = Math.max(...history.map((point) => point.used), 1)
      const spark = history.map((point) => BARS[Math.min(BARS.length - 1, Math.round((point.used / peak) * (BARS.length - 1)))]).join('')
      body.push(padded(theme.fg('accent', spark), width))
      body.push(padded(theme.fg('dim', `${history.length} requests · peak ${count(peak)}${data.compactions.length ? ` · ${data.compactions.length} compaction${data.compactions.length === 1 ? '' : 's'}` : ''}`), width))
    } else {
      body.push(padded(theme.fg('dim', 'No measured request yet.'), width))
    }
    body.push('')
    body.push(padded(spread(theme.fg('dim', 'REQUEST'), theme.fg('dim', 'USED      SHARE'), inner), width))
    for (const point of history.slice().reverse().slice(0, 12)) {
      body.push(padded(spread(`  ${point.request}`, `${count(point.used).padStart(8)}${percent(point.share).padStart(8)}`, inner), width))
    }
    for (const compaction of data.compactions.slice(-3)) {
      const before = compaction.before === null ? '?' : count(compaction.before)
      const after = compaction.after === null ? '?' : count(compaction.after)
      body.push(padded(theme.fg('warning', `  compacted ${before} → ${after}`), width))
    }
    body.push('')
    body.push(...wrapTextWithAnsi(theme.fg('dim', data.note ?? ''), inner).filter(Boolean).map((line) => padded(line, width)))
    return body
  }

  private detailBody(width: number, theme: Theme): string[] {
    const detail = this.detail!
    const inner = Math.max(8, width - CHROME_PAD * 2)
    const body: string[] = []
    body.push(padded(theme.bold(theme.fg('accent', detail.title)), width))
    body.push('')
    for (const line of detail.text.split('\n')) {
      if (!line.trim()) {
        body.push('')
        continue
      }
      for (const wrapped of wrapTextWithAnsi(theme.fg('text', line), inner)) body.push(padded(wrapped, width))
    }
    return body
  }
}
