import type { Theme, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { doctorReportSchema, type DoctorReport } from '../../../doctor/types'
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

export class DoctorPage implements TerminalPage {
  focused = false
  private report?: DoctorReport
  private error?: string
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private busy = false
  private offset = 0
  constructor(private readonly options: DoctorPageOptions) {}
  tabs(): readonly TabInfo[] { return [{ id: 'doctor', title: 'Doctor' }] }
  activeTab(): string { return 'doctor' }
  hint(): string { return '↑/↓ scroll · r refresh · t retry finding · l live checks · c cancel · Esc close' }
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
    if (matchesKey(data, 'up')) this.offset = Math.max(0, this.offset - 1)
    else if (matchesKey(data, 'down')) this.offset++
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
    const report = this.report
    const counts = report?.findings.reduce<Record<string, number>>((all, finding) => { all[finding.status] = (all[finding.status] ?? 0) + 1; return all }, {}) ?? {}
    const lines = [
      this.error ?? (report ? `${report.mode} · ${report.state} · ${report.completed}/${report.total} checks` : 'Preparing diagnostics…'),
      report ? `Account ${report.context.accountId ?? 'none'} · Model ${report.context.model ?? 'none'}` : '',
      Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' · '),
      ...report?.findings.flatMap(finding => [
        '', `[${finding.status}] ${finding.category} · ${finding.title} (${finding.verification})`,
        finding.evidence, ...(finding.remedy ? [`Action: ${finding.remedy}`] : [])
      ]) ?? []
    ].flatMap(line => stripTerminalSequences(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').split('\n').flatMap(part => wrapTextWithAnsi(part, width)))
    this.offset = Math.max(0, Math.min(this.offset, lines.length - rows))
    return lines.slice(this.offset, this.offset + rows).map(line => this.options.theme().fg('text', line))
  }
}
