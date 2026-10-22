import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { redactLogText } from '../../../core/bus'
import type { RunEvent } from '../../../sessions/contracts'
import type { TerminalTrajectorySnapshot } from '../../trajectory'
import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'

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

export interface LogPageOptions {
  theme: () => Theme
  /** The diagnostic sources, read when the page is first shown and not again while the overlay is open. */
  load(): Promise<LogSection[]>
  changed(): void
}

/** A static view of the diagnostic snapshot taken when the page was first shown. */
export class LogPage implements TerminalPage {
  focused = false
  private sections: LogSection[] | undefined
  private error: string | undefined
  private source = 0
  private offset = 0
  private atEnd = true
  private maxOffset = 0
  private rows = 1
  private disposed = false

  constructor(private readonly options: LogPageOptions) {}

  activate(): void {
    if (this.sections || this.disposed) return
    this.options.load().then(
      sections => { this.sections = sections },
      error => { this.error = error instanceof Error ? error.message : String(error) }
    ).finally(() => { if (!this.disposed) this.options.changed() })
  }

  dispose(): void { this.disposed = true }

  tabs(): readonly TabInfo[] {
    return this.sections?.map((item, index) => ({ id: String(index), title: item.title })) ?? [
      { id: '0', title: 'Diagnostics' }, { id: '1', title: 'Run Events' }
    ]
  }
  activeTab(): string { return String(this.source) }
  hint(): string { return '↑/↓ scroll · PgUp/PgDn page' }

  private changeSource(direction: number): void {
    const count = this.sections?.length ?? 0
    if (!count) return
    this.source = (this.source + direction + count) % count
    this.offset = 0
    this.atEnd = true
  }

  private currentOffset(): number { return this.atEnd ? this.maxOffset : this.offset }

  handleInput(data: string): boolean {
    const page = Math.max(1, this.rows - 1)
    if (matchesKey(data, 'tab')) this.changeSource(1)
    else if (matchesKey(data, 'shift+tab')) this.changeSource(-1)
    else if (matchesKey(data, 'home')) { this.offset = 0; this.atEnd = false }
    else if (matchesKey(data, 'end')) this.atEnd = true
    else if (matchesKey(data, 'up')) { this.offset = Math.max(0, this.currentOffset() - 1); this.atEnd = false }
    else if (matchesKey(data, 'down')) { this.offset = this.currentOffset() + 1; this.atEnd = false }
    else if (matchesKey(data, 'pageUp')) { this.offset = Math.max(0, this.currentOffset() - page); this.atEnd = false }
    else if (matchesKey(data, 'pageDown')) { this.offset = this.currentOffset() + page; this.atEnd = false }
    else return false
    return true
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.sections) return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read logs: ${this.error}` : 'Reading logs…')]
    const section = this.sections[this.source] ?? { title: 'Logs', text: 'No log sources are available.' }
    const bodyRows = Math.max(0, rows - 2)
    this.rows = Math.max(1, bodyRows)
    const lines = safe(section.text).split('\n').flatMap(line => line ? wrapTextWithAnsi(line, width) : [''])
    this.maxOffset = Math.max(0, lines.length - bodyRows)
    if (this.atEnd) this.offset = this.maxOffset
    else this.offset = Math.max(0, Math.min(this.maxOffset, this.offset))
    const last = Math.min(lines.length, this.offset + bodyRows)
    const position = theme.fg('dim', `lines ${lines.length ? this.offset + 1 : 0}-${last}/${lines.length}`)
    return [position, ...lines.slice(this.offset, last)].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
