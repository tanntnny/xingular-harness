// `/context`: what the latest request was made of, one row per contributor, with the share of the
// window each one takes and where the rest of it went. The page only reads: `terminal.context`
// answers with the attribution and, on request, the text of one row.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, parseColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { ContextAttribution, ContextGroup, ContextRow } from '../../../context/types'
import { CHROME_PAD, padded, selectedRow, type TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { SERIES_COLORS } from '../theme'

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
/** Characters per token, for the budget column: the same ratio the attribution estimates with. */
const CHARS = 4
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

/** One rule for capacity, shared with the App's `Meter`: amber at 80, red at 95. */
function tone(share: number | null): 'error' | 'warning' | 'success' | 'dim' {
  if (share === null) return 'dim'
  if (share >= 95) return 'error'
  if (share >= 80) return 'warning'
  return 'success'
}

/** What a bar's run is called, short enough to sit in a legend. */
const SERIES_LABELS: Record<ContextGroup, string> = {
  foundation: 'foundation',
  variant: 'variant',
  application: 'your app',
  conversation: 'conversation',
  reserved: 'reserved'
}

/** The categorical colour of an owner group: the App's `--data-1..4`, in the same order. */
function seriesColor(theme: Theme, index: number): string {
  const palette = theme.appearance === 'light' ? SERIES_COLORS.light : SERIES_COLORS.dark
  return palette[index] ?? palette[palette.length - 1]!
}

/** Cells for each value out of `total`, by largest remainder, so the runs always add up. */
export function allocateCells(values: readonly number[], total: number): number[] {
  const cells = Math.max(0, Math.floor(total))
  const sum = values.reduce((acc, value) => acc + Math.max(0, value), 0)
  if (sum <= 0 || cells <= 0) return values.map(() => 0)
  const present = values.map((value, index) => ({ value: Math.max(0, value), index })).filter((entry) => entry.value > 0)
  if (cells < present.length) {
    const out = values.map(() => 0)
    for (const entry of [...present].sort((left, right) => right.value - left.value).slice(0, cells)) out[entry.index] = 1
    return out
  }
  const exact = values.map((value) => (Math.max(0, value) / sum) * cells)
  const out = exact.map((value) => Math.floor(value))
  let left = cells - out.reduce((acc, value) => acc + value, 0)
  for (const entry of exact.map((value, index) => ({ rest: value - Math.floor(value), index })).sort((left_, right) => right.rest - left_.rest)) {
    if (left <= 0) break
    out[entry.index] = (out[entry.index] ?? 0) + 1
    left -= 1
  }
  // A kind with tokens gets one cell while there is room to spare, so it never vanishes silently.
  for (const entry of present) {
    if ((out[entry.index] ?? 0) > 0) continue
    const donor = out.map((value, index) => ({ value, index })).filter((candidate) => candidate.index !== entry.index && candidate.value > 1).sort((a, b) => b.value - a.value)[0]
    if (!donor) break
    out[donor.index] = (out[donor.index] ?? 0) - 1
    out[entry.index] = 1
  }
  return out
}

/** The bar and its legend: one colour per kind of context, the track for free space, a marker at the reserve. */
export function contextBar(data: ContextAttribution, width: number, theme: Theme): { bar: string; legend: string[] } {
  const room = Math.max(1, width - 2)
  const parts = OWNER_ORDER.slice(0, 4)
    .map((group, index) => ({ group, tokens: data.totals[group], color: seriesColor(theme, index) }))
    .filter((part) => part.tokens > 0)
  const window = data.window
  const share = window === null || window <= 0 ? 100 : Math.min(100, (data.used / window) * 100)
  const filled = Math.max(0, Math.min(room, Math.round((share / 100) * room)))
  const cells = allocateCells(parts.map((part) => part.tokens), filled)
  const runs = parts.flatMap((part, index) => (cells[index] ?? 0) > 0 ? [{ text: '█'.repeat(cells[index]!), color: part.color }] : [])
  const trackCells = Math.max(0, room - filled)
  const reserve = data.compaction?.reserveTokens ?? null
  const markerAt = reserve !== null && window !== null && window > 0 ? Math.round(((data.used + reserve) / window) * room) : null
  const inTrack = markerAt !== null && markerAt >= filled && markerAt < room ? markerAt - filled : null
  const bar = '[' + runs.map((run) => theme.style(run.text, { fg: parseColor(run.color) })).join('')
    + (trackCells > 0
      ? theme.fg('dim', '░'.repeat(inTrack ?? trackCells))
        + (inTrack === null ? '' : theme.fg('warning', '│') + theme.fg('dim', '░'.repeat(Math.max(0, trackCells - inTrack - 1))))
      : (inTrack === null ? '' : theme.fg('warning', '│')))
    + ']'

  const entries: { text: string; color: string | null }[] = parts.map((part) => ({ text: `▌${SERIES_LABELS[part.group]} ${count(part.tokens)}`, color: part.color }))
  entries.push({ text: `free ${data.free === null ? '?' : count(data.free)}`, color: null })
  if (reserve !== null) entries.push({ text: `│ compaction at ${count(Math.min(window ?? data.used + reserve, data.used + reserve))}`, color: null })
  const legend: string[] = []
  let line = ''
  for (const entry of entries) {
    const piece = entry.color ? theme.style(entry.text, { fg: parseColor(entry.color) }) : theme.fg('dim', entry.text)
    const candidate = line ? `${line}  ${piece}` : piece
    if (line && visibleWidth(candidate) > width) {
      legend.push(line)
      line = piece
    } else line = candidate
  }
  if (line) legend.push(line)
  return { bar, legend }
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
      // Start on the first row so space and enter act on something the person can see.
      if (!this.entries().some((entry) => entry.row.id === this.selectedId)) this.selectedId = this.entries()[0]?.row.id ?? null
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
    const found = entries.findIndex((entry) => entry.row.id === this.selectedId)
    const current = found >= 0 ? found : 0
    if (!entries.length) return false
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
    // The overlay owns the tab strip, both rules and the hint; the body starts at the reading.
    const body = this.detail ? this.detailBody(width, theme) : this.tab === 'growth' ? this.growthBody(width, theme) : this.requestBody(width, theme)
    const room = Math.max(1, rows)
    this.scrollRows = room
    this.maxOffset = Math.max(0, body.length - room)
    const wanted = this.detail ? this.detailOffset : this.offset
    const offset = Math.max(0, Math.min(wanted, this.maxOffset))
    if (this.detail) this.detailOffset = offset
    else this.offset = offset
    return body.slice(offset, offset + room).map((line) => truncateToWidth(line, width, ''))
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
    const chart = contextBar(data, inner, theme)
    body.push(padded(chart.bar, width))
    for (const line of chart.legend) body.push(padded(line, width))
    body.push('')
    for (const entry of this.entries()) {
      if (entry.heading) {
        const total = data.rows.filter((row) => (this.grouping === 'owner' ? OWNER_TITLES[row.group] === entry.heading : kindOf(row) === entry.heading)).reduce((sum, row) => sum + row.tokens, 0)
        // The heading carries its group's colour, so the list and the bar read as one picture.
        const owner = this.grouping === 'owner' ? OWNER_ORDER.find((group) => OWNER_TITLES[group] === entry.heading) : undefined
        const swatch = owner ? theme.style('█ ', { fg: parseColor(seriesColor(theme, OWNER_ORDER.indexOf(owner))) }) : ''
        body.push(padded(swatch + theme.bold(theme.fg('accent', entry.heading)) + theme.fg('dim', `  ${count(total)}`), width))
      }
      if (entry.folded) continue
      body.push(this.rowLine(entry.row, inner, width, theme))
    }
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
    const tail = `${count(row.tokens).padStart(7)}${percent(row.share).padStart(7)}`
    // The note says why a figure is not exact, so it outranks the budget and the tool breakdown.
    const extras = [
      row.note ? row.note : '',
      row.budget ? `${count(row.chars ?? row.tokens * CHARS)} of ${count(row.budget)} chars` : '',
      row.tools?.length ? row.tools.map((tool) => `${tool.group} ${tool.count}`).join(' · ') : ''
    ].filter(Boolean)
    const room = (): number => Math.max(12, inner - visibleWidth(tail) - 1 - (extras.length ? visibleWidth(extras.join('  ')) + 2 : 0))
    let left = truncateToWidth(`${marker}${row.title}`, room(), '…')
    while (extras.length && visibleWidth(left) + visibleWidth(tail) + 2 + visibleWidth(extras.join('  ')) > inner) extras.pop()
    const rest = extras.join('  ')
    const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(tail) - (rest ? visibleWidth(rest) + 2 : 0))
    const line = `${left}${' '.repeat(gap)}${rest ? theme.fg('dim', rest) + '  ' : ''}${tail}`
    if (selected) return selectedRow(padded(line, width), width, theme)
    return padded(line, width)
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
