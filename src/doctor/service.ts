import { randomUUID } from 'node:crypto'
import { redactLogText } from '../core/bus'
import { invalid, notFound } from '../core/errors'
import { doctorInputSchema, findingSchema, type DoctorCheck, type DoctorContext, type DoctorInput, type DoctorProbeContext, type DoctorReport } from './types'

interface Job { report: DoctorReport; abort: AbortController; settled: Promise<void> }
export interface DoctorOptions {
  checks(context: DoctorContext): Promise<DoctorCheck[]>
  probe<T>(context: DoctorContext, signal: AbortSignal, action: (probe: DoctorProbeContext) => Promise<T>): Promise<T>
  timeout?: { local: number; live: number; model: number }
}

const safe = (text: string) => redactLogText(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').slice(0, 4000)

export class Doctor {
  private readonly jobs = new Map<string, Job>()
  private closed = false
  constructor(private readonly options: DoctorOptions) {}

  start(input: DoctorInput): DoctorReport {
    if (this.closed) throw invalid('Diagnostics are closed.')
    const parsed = doctorInputSchema.parse(input)
    if (parsed.mode === 'live' && (!parsed.confirmed || !parsed.checks.length)) throw invalid('Select live checks and confirm their costs and isolated resources first.')
    const context = structuredClone(parsed.context) as DoctorContext
    const report: DoctorReport = {
      id: randomUUID(), state: 'running', startedAt: new Date().toISOString(), endedAt: null,
      mode: parsed.mode, context: { accountId: context.accountId, model: context.model },
      completed: 0, total: 0, findings: [], liveChecks: []
    }
    const job: Job = { report, abort: new AbortController(), settled: Promise.resolve() }
    this.jobs.set(report.id, job)
    job.settled = this.run(job, context, parsed.checks)
    return this.read(report.id)
  }

  read(id: string): DoctorReport { return structuredClone(this.job(id).report) }
  cancel(id: string): DoctorReport {
    const job = this.job(id)
    if (job.report.state === 'running') {
      job.report.state = 'cancelled'
      job.report.endedAt = new Date().toISOString()
      job.abort.abort()
    }
    return this.read(id)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const id of this.jobs.keys()) this.cancel(id)
    await Promise.all([...this.jobs.values()].map(job => job.settled))
    this.jobs.clear()
  }
  private job(id: string): Job {
    const job = this.jobs.get(id)
    if (!job) throw notFound('Diagnostic job')
    return job
  }
  private async run(job: Job, context: DoctorContext, selected: string[]): Promise<void> {
    const { report, abort } = job
    try {
      const checks = await this.bounded(abort.signal, 10_000, () => this.options.checks(context))
      const ids = new Set<string>()
      for (const check of checks) {
        if (ids.has(check.id)) throw invalid(`Duplicate diagnostic check: ${check.id}`)
        ids.add(check.id)
      }
      const enabled = (check: DoctorCheck) => !check.tools?.length || check.tools.some(tool => context.tools.includes(tool))
      report.liveChecks = checks.filter(check => check.live && enabled(check)).map(check => ({ id: check.id, title: safe(check.title), notice: safe(check.live!.notice) }))
      if (selected.some(id => !ids.has(id))) throw invalid('An unknown diagnostic check was selected.')
      const wanted = selected.length ? checks.filter(check => selected.includes(check.id)) : checks
      report.total = wanted.length
      const execute = async (check: DoctorCheck) => {
        if (abort.signal.aborted) return
        const mode = report.mode
        const limits = this.options.timeout ?? { local: 10_000, live: 30_000, model: 60_000 }
        let result
        try {
          result = !enabled(check)
            ? { status: 'disabled' as const, evidence: 'This capability is disabled in the selected session.' }
            : await this.bounded(abort.signal, mode === 'local' ? limits.local : check.id === 'model' ? limits.model : limits.live, signal => {
              if (mode === 'local') return check.local(signal)
              if (!check.live) return Promise.resolve({ status: 'unverified' as const, evidence: 'This check has no live probe.' })
              return this.options.probe(context, signal, probe => check.live!.run(probe))
            })
        } catch (error) {
          const blocked = error && typeof error === 'object' && 'code' in error && error.code === 'doctor_blocked'
          result = { status: blocked ? 'blocked' as const : 'fail' as const, evidence: blocked ? 'The capability or tool policy refused this diagnostic call.' : 'The check failed or exceeded its time limit.', remedy: blocked ? 'Review the selected scope and tool permissions.' : 'Review the backend configuration and retry this check.' }
        }
        if (abort.signal.aborted) return
        const parsed = findingSchema.safeParse({ ...result, id: check.id, category: safe(check.category), title: safe(check.title), verification: mode, checkedAt: new Date().toISOString() })
        const finding = parsed.success ? parsed.data : {
          id: check.id, category: safe(check.category), title: safe(check.title), verification: mode,
          checkedAt: new Date().toISOString(), status: 'fail' as const,
          evidence: 'The diagnostic provider returned an invalid finding.', remedy: 'Review the provider implementation.'
        }
        finding.evidence = safe(finding.evidence)
        if (finding.remedy) finding.remedy = safe(finding.remedy)
        report.findings.push(finding)
        report.completed++
      }
      // Interaction probes are serial, so only one isolated surface can own input at a time.
      if (report.mode === 'live') { for (const check of wanted) await execute(check) }
      else {
        let index = 0
        await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => {
          while (!abort.signal.aborted && index < wanted.length) await execute(wanted[index++]!)
        }))
      }
    } catch {
      if (!abort.signal.aborted) report.findings.push({ id: 'doctor', title: 'Diagnostic setup', category: 'runtime', status: 'fail', verification: 'local', evidence: 'Diagnostic checks could not be prepared.', remedy: 'Check the selected scope, account, and data location.', checkedAt: new Date().toISOString() })
    } finally {
      if (report.state === 'running') report.state = 'completed'
      report.endedAt ??= new Date().toISOString()
    }
  }
  private async bounded<T>(parent: AbortSignal, ms: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    parent.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort()
    parent.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, ms)
    try {
      return await Promise.race([
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal) }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Diagnostic cancelled or timed out.')), { once: true }))
      ])
    } finally {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    }
  }
}
