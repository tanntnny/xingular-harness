import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'

import type { RunEvent } from '../../sessions/contracts'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'

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

export interface TrajectoryPanelOptions {
  tui: TUI
  theme: Theme
  runs: TerminalTrajectoryRun[]
  initialIndex: number
  initial: TerminalTrajectorySnapshot
  read(runId: string, afterSequence?: number): Promise<TerminalTrajectorySnapshot>
  copy(text: string): Promise<void>
  close(): void
  changed(): void
  notify(message: string, type?: string): void
}

/** Read-only view of saved run evidence, scoped by its source before it reaches this component. */
export class TrajectoryPanel implements Component, Focusable {
  private runIndex: number
  private run: TerminalTrajectoryRun
  private events: RunEvent[]
  private selected = 0
  private detailOffset = 0
  private focusedValue = false
  private loading = false
  private disposed = false
  private timer: ReturnType<typeof setInterval>
  private error?: string

  constructor(private readonly options: TrajectoryPanelOptions) {
    this.runIndex = Math.max(0, Math.min(options.runs.length - 1, options.initialIndex))
    this.run = options.initial.run
    this.events = options.initial.events.slice().sort((left, right) => left.sequence - right.sequence)
    this.selected = Math.max(0, this.events.length - 1)
    this.timer = setInterval(() => { void this.refresh() }, 2_000)
    this.timer.unref?.()
  }

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value }
  get selectedRunId(): string { return this.run.id }
  get selectedEvent(): RunEvent | undefined { return this.events[this.selected] }

  invalidate(): void { this.options.changed() }

  private async refresh(): Promise<void> {
    if (this.disposed || this.loading || !ACTIVE.has(this.run.status)) return
    this.loading = true
    const lastSequence = this.events.at(-1)?.sequence
    const followedLatest = this.selected === this.events.length - 1
    try {
      const snapshot = await this.options.read(this.run.id, lastSequence)
      if (this.disposed) return
      this.run = snapshot.run
      if (lastSequence === undefined) this.events = snapshot.events.slice().sort((left, right) => left.sequence - right.sequence)
      else {
        const existing = new Set(this.events.map(event => event.sequence))
        this.events = [...this.events, ...snapshot.events.filter(event => !existing.has(event.sequence))].sort((left, right) => left.sequence - right.sequence)
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

  private async changeRun(direction: -1 | 1): Promise<void> {
    const next = this.runIndex + direction
    if (next < 0 || next >= this.options.runs.length || this.loading) return
    this.runIndex = next
    this.run = this.options.runs[next]!
    this.events = []
    this.selected = 0
    this.detailOffset = 0
    this.error = undefined
    this.options.changed()
    this.loading = true
    try {
      const snapshot = await this.options.read(this.run.id)
      if (this.disposed || this.run.id !== snapshot.run.id) return
      this.run = snapshot.run
      this.events = snapshot.events.slice().sort((left, right) => left.sequence - right.sequence)
      this.selected = Math.max(0, this.events.length - 1)
    } catch (error) {
      if (!this.disposed) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.options.close(); return }
    if (matchesKey(data, 'left')) { void this.changeRun(1); return }
    if (matchesKey(data, 'right')) { void this.changeRun(-1); return }
    if (matchesKey(data, 'up')) { this.selected = Math.max(0, this.selected - 1); this.detailOffset = 0; this.options.changed(); return }
    if (matchesKey(data, 'down')) { this.selected = this.events.length ? Math.min(this.events.length - 1, this.selected + 1) : 0; this.detailOffset = 0; this.options.changed(); return }
    if (matchesKey(data, 'pageUp')) { this.detailOffset = Math.max(0, this.detailOffset - 8); this.options.changed(); return }
    if (matchesKey(data, 'pageDown')) { this.detailOffset += 8; this.options.changed(); return }
    if (data.toLowerCase() === 'c' && this.selectedEvent) {
      const text = JSON.stringify(this.selectedEvent, null, 2)
      void this.options.copy(text).then(() => this.options.notify('Copied selected trajectory event')).catch(error => this.options.notify(String(error), 'error'))
    }
  }

  render(width: number): string[] {
    width = Math.max(0, Math.trunc(width))
    const bodyRows = Math.max(0, Math.floor(this.options.tui.terminal.rows * 0.8) - 3)
    if (!width || !bodyRows) return []
    const { theme } = this.options
    const runPosition = `${this.runIndex + 1}/${this.options.runs.length}`
    const modelEvent = [...this.events].reverse().find(event => event.type === 'usage.updated')
    const usage = modelEvent ? payloadOf(modelEvent) : {}
    const model = stringOf(usage.model) ?? 'model unavailable'
    const lines = [theme.bold(theme.fg('accent', `Run ${runPosition} · ${this.run.id} · ${this.run.status}${this.loading ? ' · loading' : ''}`))]
    if (bodyRows >= 9) {
      lines.push(theme.fg('muted', `${model} · ${durationLine(this.run)} · ${this.run.mode}`))
      lines.push(theme.fg('muted', usageLine(this.events)))
      lines.push(this.run.goal ? theme.fg('dim', `Prompt: ${this.run.goal.replace(/\s+/g, ' ').slice(0, 140)}`) : theme.fg('dim', 'Prompt text unavailable'))
    } else if (bodyRows >= 6) {
      lines.push(theme.fg('muted', `${model} · ${durationLine(this.run)}`))
    }

    lines.push(theme.bold('Events'))
    if (this.error) lines.push(theme.fg('error', `Read error: ${this.error}`))
    if (!this.events.length) lines.push(theme.fg('dim', this.loading ? 'Loading recorded events…' : 'No recorded events'))
    const structural = lines.length + 2
    const available = Math.max(0, bodyRows - structural - 1)
    const ledgerBudget = this.events.length ? Math.min(this.events.length, Math.max(1, Math.floor(available * 0.4))) : 0
    const detailBudget = Math.max(0, available - ledgerBudget)
    const firstEvent = Math.max(0, Math.min(this.events.length - ledgerBudget, this.selected - Math.floor(ledgerBudget / 2)))
    for (let offset = 0; offset < ledgerBudget; offset++) {
      const index = firstEvent + offset
      const event = this.events[index]!
      const prefix = index === this.selected ? '❯' : ' '
      const label = `${prefix} ${timeOf(event.timestamp)}  ${event.type}  ${eventDescription(event)}`
      lines.push(index === this.selected ? theme.bg('selectedBg', theme.fg('text', label)) : theme.fg('muted', label))
    }

    const selected = this.selectedEvent
    lines.push(theme.bold(selected ? `Selected event · ${selected.type} · #${selected.sequence}` : 'Selected event'))
    if (selected) {
      const details = wrapTextWithAnsi(safe(JSON.stringify({ payload: selected.payload, type: selected.type, sequence: selected.sequence, timestamp: selected.timestamp }, null, 2)), width)
      const maxOffset = Math.max(0, details.length - detailBudget)
      this.detailOffset = Math.min(this.detailOffset, maxOffset)
      lines.push(...details.slice(this.detailOffset, this.detailOffset + detailBudget).map(line => theme.fg('dim', line)))
    }
    return lines.slice(0, bodyRows).map(line => truncateToWidth(line, width, ''))
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
  }
}
