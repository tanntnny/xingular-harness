/** Saved run evidence for the current conversation: runs, their events, and the selected event's payload. */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import type { RunEvent } from '../../../sessions/contracts'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../../trajectory'
import { selectedRow, selectionText, type TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import { isPrimaryClick, type TerminalMouseInput } from '../mouse'

const ACTIVE = new Set(['queued', 'running', 'waiting_for_approval', 'waiting_for_input'])
type Payload = Record<string, unknown>

const payloadOf = (event: RunEvent): Payload => event.payload && typeof event.payload === 'object' ? event.payload as Payload : {}
const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const numberOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function safe(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
}

function timeOf(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : value
}

function eventDescription(event: RunEvent): string {
  const payload = payloadOf(event)
  switch (event.type) {
    case 'message.completed':
    case 'message.delta':
      return `${stringOf(payload.role) ?? 'message'}: ${stringOf(payload.text)?.replace(/\s+/g, ' ').slice(0, 90) ?? ''}`
    case 'tool.started':
    case 'tool.completed':
      return `${stringOf(payload.name) ?? 'tool'}${stringOf(payload.summary) ? ` · ${stringOf(payload.summary)}` : ''}`
    case 'usage.updated': {
      const request = payload.request && typeof payload.request === 'object' ? payload.request as Payload : {}
      return `${stringOf(request.model) ?? stringOf(payload.model) ?? 'model'} · request ${numberOf(request.index) ?? numberOf(payload.requests) ?? '?'} · ${numberOf(request.durationMs) ?? 0} ms`
    }
    case 'status.changed':
      return stringOf(payload.status) ?? 'status update'
    case 'retry.started':
    case 'retry.ended':
      return `attempt ${numberOf(payload.attempt) ?? 1}${stringOf(payload.error) ? ` · ${stringOf(payload.error)}` : ''}`
    case 'compaction.started':
    case 'compaction.ended':
      return stringOf(payload.reason) ?? 'context compaction'
    case 'extension.notice':
      return stringOf(payload.text) ?? 'extension notice'
    case 'context.snapshot':
      return 'Recorded prompt and tool definitions'
    case 'failed':
      return stringOf(payload.message) ?? stringOf(payload.code) ?? 'run failed'
    default:
      return stringOf(payload.text) ?? stringOf(payload.name) ?? ''
  }
}

function usageLine(events: readonly RunEvent[]): string {
  const event = [...events].reverse().find(item => item.type === 'usage.updated')
  if (!event) return 'Usage not recorded'
  const payload = payloadOf(event)
  const tokens = (name: string) => numberOf(payload[name])?.toLocaleString() ?? '—'
  const cost = numberOf(payload.costUsd)
  const requests = numberOf(payload.requests)
  return `Input ${tokens('inputTokens')} · Output ${tokens('outputTokens')} · Cache read ${tokens('cacheReadTokens')} · ${requests ?? 0} requests · ${cost === undefined ? 'cost —' : `$${cost.toFixed(4)}`}`
}

function durationLine(run: TerminalTrajectoryRun): string {
  const start = Date.parse(run.startedAt)
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return run.startedAt
  return `${((Math.max(0, end - start)) / 1000).toFixed(1)} s · ${timeOf(run.startedAt)}`
}

export interface TrajectoryPageOptions {
  theme: () => Theme
  runs(): Promise<TerminalTrajectoryRun[]>
  read(runId: string, afterSequence?: number): Promise<TerminalTrajectorySnapshot>
  copy(text: string): Promise<void>
  /** Opens on this run when it is in the list; otherwise the newest. */
  initialRunId?: string
  notify(message: string, type?: string): void
  changed(): void
}

const bySequence = (left: RunEvent, right: RunEvent) => left.sequence - right.sequence
const SECTIONS = [
  { id: 'runs', title: 'Runs' },
  { id: 'events', title: 'Events' }
] as const

export class TrajectoryPage implements TerminalPage {
  private runs: TerminalTrajectoryRun[] = []
  private section: typeof SECTIONS[number]['id'] = 'runs'
  private readonly runList: FilterList<TerminalTrajectoryRun>
  private runIndex = 0
  private run: TerminalTrajectoryRun | undefined
  private events: RunEvent[] = []
  private selected = 0
  private detailOffset = 0
  private eventRowsStart = -1
  private eventRowsFirst = 0
  private eventRowsCount = 0
  private loading = false
  private loaded = false
  private disposed = false
  private timer: ReturnType<typeof setInterval> | undefined
  private error: string | undefined

  constructor(private readonly options: TrajectoryPageOptions) {
    this.runList = new FilterList<TerminalTrajectoryRun>({
      theme: options.theme, search: 'never', noun: ['run', 'runs'], empty: 'No runs recorded for this native session yet',
      onActivate: row => { if (row.data) void this.selectRun(row.data) }
    })
  }

  get selectedRunId(): string | undefined { return this.run?.id }
  get selectedEvent(): RunEvent | undefined { return this.events[this.selected] }

  get focused(): boolean { return this.runList.focused }
  set focused(value: boolean) { this.runList.focused = value }

  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }

  activate(): void {
    if (this.disposed) return
    if (!this.loaded) void this.load()
    this.timer ??= setInterval(() => { void this.refresh() }, 2_000)
    this.timer.unref?.()
  }

  deactivate(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.disposed = true
    this.deactivate()
  }

  private async load(): Promise<void> {
    this.loading = true
    this.options.changed()
    try {
      this.runs = await this.options.runs()
      this.runList.setRows(this.runRows())
      const at = this.options.initialRunId ? this.runs.findIndex(run => run.id === this.options.initialRunId) : 0
      if (this.options.initialRunId && at < 0) throw new Error('Run not found in this native session')
      this.runIndex = Math.max(0, at)
      const selected = this.runs[this.runIndex]
      if (selected) {
        this.runList.select(selected.id)
        await this.open(selected)
        if (this.options.initialRunId) this.section = 'events'
      }
      this.error = undefined
    } catch (error) {
      if (!this.disposed) {
        this.error = error instanceof Error ? error.message : String(error)
        if (this.options.initialRunId) this.section = 'events'
      }
    } finally {
      this.loaded = true
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  private async open(run: TerminalTrajectoryRun): Promise<void> {
    const snapshot = await this.options.read(run.id)
    if (this.disposed || this.runs[this.runIndex]?.id !== run.id) return
    this.run = snapshot.run
    this.events = snapshot.events.slice().sort(bySequence)
    this.runList.select(run.id)
    this.selected = Math.max(0, this.events.length - 1)
    this.detailOffset = 0
  }

  private async refresh(): Promise<void> {
    if (this.disposed || this.loading || !this.run || !ACTIVE.has(this.run.status)) return
    this.loading = true
    const lastSequence = this.events.at(-1)?.sequence
    const followedLatest = this.selected === this.events.length - 1
    try {
      const snapshot = await this.options.read(this.run.id, lastSequence)
      if (this.disposed) return
      this.run = snapshot.run
      this.runs = this.runs.map(run => run.id === snapshot.run.id ? snapshot.run : run)
      this.runList.setRows(this.runRows())
      if (lastSequence === undefined) this.events = snapshot.events.slice().sort(bySequence)
      else {
        const existing = new Set(this.events.map(event => event.sequence))
        this.events = [...this.events, ...snapshot.events.filter(event => !existing.has(event.sequence))].sort(bySequence)
      }
      if (followedLatest && this.events.length) this.selected = this.events.length - 1
      this.error = undefined
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  /** `[` is the older run, `]` the newer one. */
  private runRows(): ListRow<TerminalTrajectoryRun>[] {
    return this.runs.map(run => ({
      id: run.id,
      label: run.id,
      detail: run.status + ' · ' + timeOf(run.startedAt),
      group: run.mode,
      searchText: run.id + ' ' + run.status + ' ' + (run.goal ?? ''),
      data: run
    }))
  }

  private async selectRun(run: TerminalTrajectoryRun): Promise<void> {
    const at = this.runs.findIndex(candidate => candidate.id === run.id)
    if (at < 0 || this.loading) return
    this.runIndex = at
    this.runList.select(run.id)
    this.run = run
    this.events = []
    this.selected = 0
    this.detailOffset = 0
    this.error = undefined
    this.loading = true
    this.options.changed()
    try {
      await this.open(run)
      this.section = 'events'
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  private async changeRun(direction: -1 | 1): Promise<void> {
    const next = this.runIndex + direction
    if (next < 0 || next >= this.runs.length || this.loading) return
    this.runIndex = next
    this.run = this.runs[next]!
    this.runList.select(this.run.id)
    this.events = []
    this.selected = 0
    this.detailOffset = 0
    this.error = undefined
    this.loading = true
    this.options.changed()
    try {
      await this.open(this.runs[next]!)
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  hint(): string {
    return this.section === 'runs' ? '↑/↓ runs · Enter inspect' : '[ ] runs · ↑/↓ events · PgUp/PgDn details · c copy'
  }

  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button !== 'left') return undefined
    if (this.section === 'runs') return this.runList.handleMouse({ ...event, y: event.y - 1 })
    const offset = event.y - this.eventRowsStart
    if (this.eventRowsStart < 0 || offset < 0 || offset >= this.eventRowsCount) return undefined
    const next = this.eventRowsFirst + offset
    const changed = this.selected !== next
    this.selected = next
    this.detailOffset = 0
    return { handled: true, render: changed || isPrimaryClick(event) }
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const at = SECTIONS.findIndex(section => section.id === this.section)
      const delta = matchesKey(data, 'shift+tab') ? -1 : 1
      this.section = SECTIONS[(at + delta + SECTIONS.length) % SECTIONS.length]!.id
      return true
    }
    if (this.section === 'runs') return this.runList.handleInput(data)
    if (data === '[') { void this.changeRun(1); return true }
    if (data === ']') { void this.changeRun(-1); return true }
    if (matchesKey(data, 'up')) { this.selected = Math.max(0, this.selected - 1); this.detailOffset = 0; return true }
    if (matchesKey(data, 'down')) { this.selected = this.events.length ? Math.min(this.events.length - 1, this.selected + 1) : 0; this.detailOffset = 0; return true }
    if (matchesKey(data, 'pageUp')) { this.detailOffset = Math.max(0, this.detailOffset - 8); return true }
    if (matchesKey(data, 'pageDown')) { this.detailOffset += 8; return true }
    if (data.toLowerCase() === 'c' && this.selectedEvent) {
      const text = JSON.stringify(this.selectedEvent, null, 2)
      void this.options.copy(text).then(() => this.options.notify('Copied selected trajectory event')).catch(error => this.options.notify(String(error), 'error'))
      return true
    }
    return false
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.section === 'runs') {
      this.eventRowsStart = -1
      this.eventRowsCount = 0
      if (this.error && !this.runs.length) return [theme.fg('error', 'Read error: ' + this.error)]
      const lines = [theme.fg('dim', !this.loaded ? 'Loading recorded runs…' : this.runs.length + ' recorded runs')]
      lines.push(...this.runList.render(width, Math.max(0, rows - lines.length)))
      return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
    }
    if (!this.run) {
      this.eventRowsStart = -1
      this.eventRowsCount = 0
      if (this.error) return [theme.fg('error', 'Read error: ' + this.error)]
      return [theme.fg('dim', this.loading || !this.loaded ? 'Loading recorded runs…' : 'No run selected. Choose a run in the Runs tab.')]
    }
    const runPosition = (this.runIndex + 1) + '/' + this.runs.length
    const modelEvent = [...this.events].reverse().find(event => event.type === 'usage.updated')
    const usage = modelEvent ? payloadOf(modelEvent) : {}
    const model = stringOf(usage.model) ?? 'model unavailable'
    const lines = [theme.bold(theme.fg('accent', 'Run ' + runPosition + ' · ' + this.run.id + ' · ' + this.run.status + (this.loading ? ' · loading' : '')))]
    if (rows >= 9) {
      lines.push(theme.fg('muted', model + ' · ' + durationLine(this.run) + ' · ' + this.run.mode))
      lines.push(theme.fg('muted', usageLine(this.events)))
      lines.push(this.run.goal ? theme.fg('dim', 'Prompt: ' + this.run.goal.replace(/\s+/g, ' ').slice(0, 140)) : theme.fg('dim', 'Prompt text unavailable'))
    } else if (rows >= 6) {
      lines.push(theme.fg('muted', model + ' · ' + durationLine(this.run)))
    }
    lines.push(theme.bold('Events'))
    if (this.error) lines.push(theme.fg('error', 'Read error: ' + this.error))
    if (!this.events.length) lines.push(theme.fg('dim', this.loading ? 'Loading recorded events…' : 'No recorded events'))
    const available = Math.max(0, rows - lines.length - 1)
    const ledgerBudget = this.events.length ? Math.min(this.events.length, Math.max(1, Math.floor(available * 0.4))) : 0
    const detailBudget = Math.max(0, available - ledgerBudget)
    const firstEvent = Math.max(0, Math.min(this.events.length - ledgerBudget, this.selected - Math.floor(ledgerBudget / 2)))
    this.eventRowsStart = lines.length
    this.eventRowsFirst = firstEvent
    this.eventRowsCount = ledgerBudget
    for (let offset = 0; offset < ledgerBudget; offset++) {
      const index = firstEvent + offset
      const event = this.events[index]!
      const prefix = index === this.selected ? '❯' : ' '
      const label = truncateToWidth(prefix + ' ' + timeOf(event.timestamp) + '  ' + event.type + '  ' + eventDescription(event), width, '')
      lines.push(index === this.selected ? selectedRow(selectionText(theme, label), width, theme) : theme.fg('muted', label))
    }
    const selected = this.selectedEvent
    lines.push(theme.bold(selected ? 'Selected event · ' + selected.type + ' · #' + selected.sequence : 'Selected event'))
    if (selected) {
      const details = wrapTextWithAnsi(safe(JSON.stringify({ payload: selected.payload, type: selected.type, sequence: selected.sequence, timestamp: selected.timestamp }, null, 2)), width)
      this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - detailBudget))
      lines.push(...details.slice(this.detailOffset, this.detailOffset + detailBudget).map(line => theme.fg('dim', line)))
    }
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
