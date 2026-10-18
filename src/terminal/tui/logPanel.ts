import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'

import { redactLogText } from '../../core/bus'
import type { RunEvent } from '../../sessions/contracts'
import type { TerminalTrajectorySnapshot } from '../trajectory'

export interface LogSection {
  title: string
  text: string
}

const payloadOf = (event: RunEvent): Record<string, unknown> =>
  event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const numberOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function safe(text: string): string {
  return redactLogText(stripTerminalSequences(text)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\t/g, '    ')
}

function timeOf(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : value
}

function webError(output: string): string | undefined {
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    if (typeof value.error !== 'string') return undefined
    const status = numberOf(value.status)
    return `${status === undefined ? '' : `HTTP ${status}: `}${value.error}`
  } catch {
    return /^(?:The page could not be read:|The search could not be completed:)/.test(output) ? output : undefined
  }
}

function eventDetail(event: RunEvent): string[] {
  const payload = payloadOf(event)
  switch (event.type) {
    case 'context.snapshot':
      return ['prompt and tool definitions omitted']
    case 'message.delta':
    case 'message.completed':
    case 'message.steered':
      return ['message content omitted']
    case 'tool.started':
      return [`tool ${stringOf(payload.name) ?? 'unknown'} started; inputs omitted`]
    case 'tool.completed': {
      const name = stringOf(payload.name) ?? 'unknown'
      const duration = numberOf(payload.durationMs)
      const result = [`tool ${name} ${payload.ok === false ? 'failed' : 'completed'}${duration === undefined ? '' : ` · ${duration} ms`}`]
      const output = stringOf(payload.output)
      const webFailure = (name === 'web_fetch' || name === 'web_search') && output ? webError(output) : undefined
      if (webFailure) result.push(`  ${webFailure}`)
      else if (payload.ok === false && output) result.push(`  ${output}`)
      if (payload.outputTruncated === true) result.push('  recorded output was truncated')
      return result
    }
    case 'retry.started':
    case 'retry.ended':
      return [`attempt ${numberOf(payload.attempt) ?? '?'}${numberOf(payload.maxAttempts) === undefined ? '' : ` of ${numberOf(payload.maxAttempts)}`}${numberOf(payload.delayMs) === undefined ? '' : ` · retry delay ${numberOf(payload.delayMs)} ms`}`, ...(stringOf(payload.error) ? [`  ${payload.error}`] : [])]
    case 'compaction.ended':
      return [payload.aborted === true ? 'compaction aborted' : 'compaction completed', ...(stringOf(payload.error) ? [`  ${payload.error}`] : [])]
    case 'extension.notice':
      return payload.kind === 'error' || payload.level === 'error' ? [stringOf(payload.text) ?? 'extension error'] : ['non-error extension notice omitted']
    case 'account.status': {
      const message = stringOf(payload.message)
      return [stringOf(payload.category) ?? 'account status', ...(message ? [message] : [])]
    }
    case 'status.changed': {
      const reason = stringOf(payload.reason)
      return [stringOf(payload.status) ?? 'status changed', ...(reason ? [reason] : [])]
    }
    case 'failed': {
      const message = stringOf(payload.message)
      return [stringOf(payload.code) ?? 'run failed', ...(message ? [message] : [])]
    }
    case 'usage.updated': {
      const request = payload.request && typeof payload.request === 'object' ? payload.request as Record<string, unknown> : {}
      return [`${stringOf(request.provider) ?? stringOf(payload.provider) ?? 'provider'}/${stringOf(request.model) ?? stringOf(payload.model) ?? 'model'} · request ${numberOf(request.index) ?? numberOf(payload.requests) ?? '?'}`]
    }
    case 'approval.requested':
    case 'approval.resolved':
      return [`tool ${stringOf(payload.target) ?? ''} · decision ${stringOf(payload.decision) ?? 'pending'}; action details omitted`]
    case 'question.requested':
    case 'question.answered':
      return ['question content omitted']
    default:
      return []
  }
}

export function formatRunEventLog(snapshots: TerminalTrajectorySnapshot[]): string {
  if (!snapshots.length) return 'No run events recorded for this conversation.'
  const sections: string[] = []
  for (const snapshot of snapshots) {
    sections.push(`Run ${snapshot.run.id} · ${snapshot.run.status} · ${snapshot.run.mode}`)
    const events = snapshot.events.slice().sort((left, right) => left.sequence - right.sequence)
    if (!events.length) sections.push('  No recorded events')
    for (const event of events) {
      sections.push(`${timeOf(event.timestamp)}  #${event.sequence}  ${event.type}`)
      sections.push(...eventDetail(event).map(detail => `  ${detail}`))
    }
    sections.push('')
  }
  return safe(sections.join('\n').trimEnd())
}

export interface LogPanelOptions {
  tui: TUI
  theme: Theme
  sections: LogSection[]
  close(): void
  changed(): void
}

/** A static, full-screen view of the diagnostic snapshot taken when /log was opened. */
export class LogPanel implements Component, Focusable {
  private source = 0
  private offset = 0
  private atEnd = true
  private maxOffset = 0
  private focusedValue = false

  constructor(private readonly options: LogPanelOptions) {}

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value }
  invalidate(): void {}

  private changeSource(direction: number): void {
    const count = this.options.sections.length
    if (!count) return
    this.source = (this.source + direction + count) % count
    this.offset = 0
    this.atEnd = true
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.options.close(); return }
    if (matchesKey(data, 'left') || matchesKey(data, 'shift+tab')) this.changeSource(-1)
    else if (matchesKey(data, 'right') || matchesKey(data, 'tab')) this.changeSource(1)
    else if (matchesKey(data, 'home')) { this.offset = 0; this.atEnd = false }
    else if (matchesKey(data, 'end')) this.atEnd = true
    else if (matchesKey(data, 'up')) { this.offset = Math.max(0, this.currentOffset() - 1); this.atEnd = false }
    else if (matchesKey(data, 'down')) { this.offset = this.currentOffset() + 1; this.atEnd = false }
    else if (matchesKey(data, 'pageUp')) { this.offset = Math.max(0, this.currentOffset() - this.pageSize()); this.atEnd = false }
    else if (matchesKey(data, 'pageDown')) { this.offset = this.currentOffset() + this.pageSize(); this.atEnd = false }
    this.options.changed()
  }

  private pageSize(): number { return Math.max(1, this.options.tui.terminal.rows - 4) }
  private currentOffset(): number { return this.atEnd ? this.maxOffset : this.offset }

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    const rows = Math.max(1, Math.trunc(this.options.tui.terminal.rows))
    const section = this.options.sections[this.source] ?? { title: 'Logs', text: 'No log sources are available.' }
    const bodyRows = Math.max(0, rows - 2)
    const contentWidth = Math.max(1, width)
    const raw = safe(section.text).split('\n')
    const lines = raw.flatMap(line => line ? wrapTextWithAnsi(line, contentWidth) : [''])
    const maxOffset = Math.max(0, lines.length - bodyRows)
    this.maxOffset = maxOffset
    if (this.atEnd) this.offset = maxOffset
    else this.offset = Math.max(0, Math.min(maxOffset, this.offset))
    const first = this.offset
    const last = Math.min(lines.length, first + bodyRows)
    const position = `${this.source + 1}/${Math.max(1, this.options.sections.length)} · lines ${lines.length ? first + 1 : 0}-${last}/${lines.length}`
    const title = this.options.theme.bold(this.options.theme.fg('accent', `${section.title} · ${position}`))
    const footer = this.options.theme.fg('dim', '↑/↓ scroll · PgUp/PgDn page · ←/→ source · Esc close')
    return [title, ...lines.slice(first, last), footer].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
