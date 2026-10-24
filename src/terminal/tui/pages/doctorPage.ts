import type { Theme, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { doctorReportSchema, type DoctorFinding, type DoctorReport } from '../../../doctor/types'
import type { TerminalPage } from '../page'
import type { TabInfo } from '../chrome'

interface DoctorPageOptions {
  theme(): Theme
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  selection(): { model: string | null; tools: string[] }
  confirm: ExtensionUIContext['confirm']
  select: ExtensionUIContext['select']
  changed(): void
}

type StatusTone = 'success' | 'warning' | 'error' | 'dim' | 'muted' | 'accent'

const STATUSES: DoctorFinding['status'][] = ['pass', 'warning', 'fail', 'disabled', 'blocked', 'unverified']
const STATUS_TONE: Record<DoctorFinding['status'], StatusTone> = {
  pass: 'success', warning: 'warning', fail: 'error', disabled: 'dim', blocked: 'warning', unverified: 'muted'
}

function cleanText(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\t/g, ' ')
}

function oneLine(value: string): string {
  return cleanText(value).replace(/\s+/g, ' ').trim()
}

function padCell(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, '')
  return fitted + ' '.repeat(Math.max(0, width - visibleWidth(fitted)))
}

function tableRow(cells: string[], widths: number[], width: number): string[] {
  const wrapped = cells.map((cell, index) => {
    const lines = wrapTextWithAnsi(cell, widths[index]!)
    return lines.length ? lines : ['']
  })
  const height = Math.max(...wrapped.map(lines => lines.length))
  return Array.from({ length: height }, (_, row) => truncateToWidth(
    wrapped.map((lines, column) => padCell(lines[row] ?? '', widths[column]!)).join('  '), width, ''
  ))
}

function appendDetails(lines: string[], label: string, value: string | undefined, width: number, theme: Theme): void {
  if (!value?.trim()) return
  for (const paragraph of cleanText(value).split('\n')) {
    const wrapped = wrapTextWithAnsi(`${label}: ${paragraph}`, Math.max(1, width - 2))
    lines.push(...(wrapped.length ? wrapped : [`${label}:`]).map(line => theme.fg('muted', `  ${line}`)))
  }
}

export class DoctorPage implements TerminalPage {
  focused = false
  private report?: DoctorReport
  private error?: string
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private busy = false
  private offset = 0
  private scrollRows = 1
  private maxOffset = 0
  constructor(private readonly options: DoctorPageOptions) {}
  tabs(): readonly TabInfo[] { return [{ id: 'doctor', title: 'Doctor' }] }
  activeTab(): string { return 'doctor' }
  hint(): string { return '↑/↓ scroll · PgUp/PgDn/wheel page · Home/End · r refresh · t retry · l live · c cancel · Esc close' }
  activate(): void { if (!this.report && !this.busy) void this.start() }
  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    if (this.report?.state === 'running') void this.options.call('terminal.doctor.cancel', { id: this.report.id }).catch(() => undefined)
  }
  private async start(mode: 'local' | 'live' = 'local', checks: string[] = []): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    this.error = undefined
    clearTimeout(this.timer)
    try {
      if (this.report?.state === 'running') await this.options.call('terminal.doctor.cancel', { id: this.report.id })
      const result = await this.options.call('terminal.doctor.start', { ...this.options.selection(), mode, checks, confirmed: mode === 'live' })
      this.report = doctorReportSchema.parse(result)
      this.offset = 0
      if (this.disposed) {
        await this.options.call('terminal.doctor.cancel', { id: this.report.id })
        return
      }
      this.poll()
    } catch { this.error = 'Diagnostics could not be started. Check the host connection.' }
    finally { this.busy = false; if (!this.disposed) this.options.changed() }
  }
  private poll(): void {
    if (this.disposed || this.report?.state !== 'running') return
    const id = this.report.id
    this.timer = setTimeout(() => {
      void this.options.call('terminal.doctor.read', { id }).then(result => {
        if (this.disposed || this.report?.id !== id) return
        this.report = doctorReportSchema.parse(result)
        this.options.changed()
        this.poll()
      }).catch(() => { this.error = 'The diagnostic host connection was lost.'; this.options.changed() })
    }, 200)
  }
  private async chooseLive(): Promise<void> {
    const report = this.report
    if (!report || this.busy || report.state === 'running') return
    const selected: string[] = []
    const checks = report.liveChecks
    while (!this.disposed) {
      const labels = checks.map(check => `${selected.includes(check.id) ? '[x]' : '[ ]'} ${check.title}`)
      const run = 'Run selected checks'
      const choice = await this.options.select('Select live checks', [...labels, run])
      if (!choice || this.disposed) return
      if (choice === run) break
      const check = checks[labels.indexOf(choice)]
      if (check) {
        const index = selected.indexOf(check.id)
        if (index < 0) selected.push(check.id)
        else selected.splice(index, 1)
      }
    }
    if (!selected.length || this.disposed) return
    const notice = [`Account: ${report.context.accountId ?? 'none'}`, `Model: ${report.context.model ?? 'none'}`, ...checks.filter(check => selected.includes(check.id)).map(check => `${check.title}: ${check.notice}`)].join('\n\n')
    if (await this.options.confirm('Run these live diagnostics?', notice) && !this.disposed) await this.start('live', selected)
  }
  private async retry(): Promise<void> {
    const report = this.report
    if (!report || this.busy || report.state === 'running') return
    const labels = report.findings.map(finding => `${finding.status}: ${finding.title}`)
    const selected = await this.options.select('Retry local readiness check', labels)
    const finding = selected ? report.findings[labels.indexOf(selected)] : undefined
    if (finding && !this.disposed) await this.start('local', finding.id === 'doctor' ? [] : [finding.id])
  }
  handleInput(data: string): boolean {
    const page = Math.max(1, this.scrollRows - 1)
    if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down')) this.offset = Math.min(this.maxOffset, this.offset + 1)
    else if (matchesKey(data, 'pageUp')) this.offset = Math.max(0, this.offset - page)
    else if (matchesKey(data, 'pageDown')) this.offset = Math.min(this.maxOffset, this.offset + page)
    else if (matchesKey(data, 'home')) this.offset = 0
    else if (matchesKey(data, 'end')) this.offset = this.maxOffset
    else if (data === 'r') void this.start()
    else if (data === 'l') void this.chooseLive()
    else if (data === 't') void this.retry()
    else if (data === 'c' && this.report?.state === 'running') {
      void this.options.call('terminal.doctor.cancel', { id: this.report.id }).then(result => {
        this.report = doctorReportSchema.parse(result); clearTimeout(this.timer); this.options.changed()
      }).catch(() => { this.error = 'Could not cancel diagnostics.'; this.options.changed() })
    } else return false
    return true
  }
  render(width: number, rows: number): string[] {
    if (width < 1 || rows < 1) return []
    const theme = this.options.theme()
    const report = this.report
    const counts = report?.findings.reduce<Record<string, number>>((all, finding) => {
      all[finding.status] = (all[finding.status] ?? 0) + 1
      return all
    }, {}) ?? {}
    const stateTone: StatusTone = report?.state === 'completed' ? 'success' : report?.state === 'cancelled' ? 'warning' : 'accent'
    const summary = report ? [
      ...wrapTextWithAnsi(theme.bold(theme.fg(stateTone, `${report.mode} · ${report.state} · ${report.completed}/${report.total} checks`)), width),
      ...wrapTextWithAnsi(theme.fg('muted', `Account ${oneLine(report.context.accountId ?? 'none')} · Model ${oneLine(report.context.model ?? 'none')}`), width),
      ...wrapTextWithAnsi(STATUSES.filter(status => counts[status]).map(status => theme.fg(STATUS_TONE[status], `${counts[status]} ${status}`)).join(theme.fg('dim', ' · ')), width)
    ] : [theme.fg(this.error ? 'error' : 'dim', this.error ?? 'Preparing diagnostics…')]
    if (this.error && report) summary.unshift(...wrapTextWithAnsi(theme.fg('error', this.error), width))

    const content: string[] = []
    if (report?.findings.length) {
      const statusWidth = 11
      const categoryWidth = 14
      const verificationWidth = 12
      const gapsWidth = 6
      const checkWidth = width - statusWidth - categoryWidth - verificationWidth - gapsWidth
      if (checkWidth >= 18) {
        const widths = [statusWidth, checkWidth, categoryWidth, verificationWidth]
        content.push(...tableRow([
          theme.bold(theme.fg('dim', 'STATUS')),
          theme.bold(theme.fg('dim', 'CHECK')),
          theme.bold(theme.fg('dim', 'CATEGORY')),
          theme.bold(theme.fg('dim', 'VERIFY'))
        ], widths, width))
        for (const [index, finding] of report.findings.entries()) {
          content.push(...tableRow([
            theme.bold(theme.fg(STATUS_TONE[finding.status], finding.status.toUpperCase())),
            oneLine(finding.title), oneLine(finding.category), oneLine(finding.verification)
          ], widths, width))
          appendDetails(content, 'Evidence', finding.evidence, width, theme)
          appendDetails(content, 'Next step', finding.remedy, width, theme)
          if (index < report.findings.length - 1) content.push('')
        }
      } else {
        for (const [index, finding] of report.findings.entries()) {
          const heading = `${theme.bold(theme.fg(STATUS_TONE[finding.status], finding.status.toUpperCase()))} · ${oneLine(finding.title)}`
          content.push(...wrapTextWithAnsi(heading, width))
          content.push(...wrapTextWithAnsi(theme.fg('dim', `${oneLine(finding.category)} · ${oneLine(finding.verification)}`), width))
          appendDetails(content, 'Evidence', finding.evidence, width, theme)
          appendDetails(content, 'Next step', finding.remedy, width, theme)
          if (index < report.findings.length - 1) content.push('')
        }
      }
    } else {
      content.push(theme.fg('dim', report?.state === 'running' ? 'Waiting for findings…' : 'No findings to show.'))
    }

    const bodyRows = Math.max(0, rows - summary.length)
    this.scrollRows = Math.max(1, bodyRows)
    this.maxOffset = Math.max(0, content.length - bodyRows)
    this.offset = Math.max(0, Math.min(this.offset, this.maxOffset))
    return [...summary, ...content.slice(this.offset, this.offset + bodyRows)].slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
