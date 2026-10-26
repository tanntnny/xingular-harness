import { stat } from 'node:fs/promises'
import type { SessionInfo, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import { displayProjectName, singleLine } from './status'
import type { TerminalPage } from './page'
import { FilterList, type ListRow } from './list'
import type { TerminalMouseInput } from './mouse'

const RELATIVE_TIME = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const TIME_UNITS: readonly [number, Intl.RelativeTimeFormatUnit][] = [
  [365 * 24 * 60 * 60 * 1000, 'year'],
  [30 * 24 * 60 * 60 * 1000, 'month'],
  [7 * 24 * 60 * 60 * 1000, 'week'],
  [24 * 60 * 60 * 1000, 'day'],
  [60 * 60 * 1000, 'hour'],
  [60 * 1000, 'minute'],
  [1000, 'second']
]

export function formatSessionRelativeTime(value: Date, now = Date.now()): string {
  const delta = value.getTime() - now
  if (!Number.isFinite(delta)) return 'unknown time'
  const absolute = Math.abs(delta)
  const unit = TIME_UNITS.find(([size]) => absolute >= size)
  return unit ? RELATIVE_TIME.format(Math.round(delta / unit[0]), unit[1]) : RELATIVE_TIME.format(0, 'second')
}

export function formatSessionSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(1)}${units[unit]}`
}

function safe(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
}

export interface ResumeSessionsPageOptions {
  theme: () => Theme
  cwd(): string
  branch(): string | null
  listSessions(signal: AbortSignal): Promise<SessionInfo[]>
  select(path: string): void
  cancel(): void
  changed(): void
}

export class ResumeSessionsPage implements TerminalPage {
  readonly presentation = 'fullscreen' as const
  private readonly list: FilterList<string>
  private loading = false
  private loaded = false
  private disposed = false
  private error: string | undefined
  private abort?: AbortController

  constructor(private readonly options: ResumeSessionsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme,
      search: 'always',
      rowGap: 1,
      noun: ['session', 'sessions'],
      empty: 'No saved sessions in this project',
      onCancel: options.cancel,
      onActivate: row => { if (row.data) options.select(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  tabs() { return [{ id: 'sessions', title: 'Resume session' }] }
  activeTab(): string { return 'sessions' }
  hint(): string { return '↑/↓ select · type to search · Enter resume' }

  activate(): void {
    if (this.loaded || this.loading || this.disposed) return
    this.abort = new AbortController()
    void this.load(this.abort.signal)
  }

  dispose(): void {
    this.disposed = true
    this.abort?.abort()
  }

  private async load(signal: AbortSignal): Promise<void> {
    this.loading = true
    this.options.changed()
    try {
      const sessions = await this.options.listSessions(signal)
      const branch = singleLine(this.options.branch() ?? '') || '—'
      const rows = await Promise.all(sessions.map(async session => {
        let bytes: number | undefined
        try { bytes = (await stat(session.path)).size }
        catch { /* A removed or unreadable file remains selectable and shows an unknown size. */ }
        const title = session.name?.trim() || session.firstMessage.trim() || session.id
        const project = displayProjectName(session.cwd || this.options.cwd())
        const modified = formatSessionRelativeTime(session.modified)
        const subtitle = `${modified} · ${project}:${branch} · ${formatSessionSize(bytes)}`
        return {
          id: session.path,
          label: singleLine(title),
          subtitle,
          searchText: `${title} ${session.firstMessage} ${session.id} ${subtitle}`,
          data: session.path
        } satisfies ListRow<string>
      }))
      if (this.disposed || signal.aborted) return
      this.list.setRows(rows)
      this.error = undefined
    } catch (error) {
      if (!this.disposed && !signal.aborted) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loaded = true
      this.loading = false
      if (!this.disposed) this.options.changed()
    }
  }

  handleInput(data: string): boolean {
    if (!this.list.handleInput(data)) return false
    this.options.changed()
    return true
  }

  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    if (event.type === 'move') return { handled: true, render: false }
    if (event.type === 'wheel') return undefined
    const result = this.list.handleMouse(event)
    if (result?.render) this.options.changed()
    return result
  }

  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    if (this.error) return [theme.fg('error', `Could not read saved sessions: ${safe(this.error)}`)]
    if (this.loading || !this.loaded) return [theme.fg('dim', 'Loading saved sessions…')]
    return this.list.render(width, rows)
  }
}

