import { afterEach, describe, expect, it, vi } from 'vitest'
import { Doctor } from './service'
import { doctorReportSchema, type DoctorCheck, type DoctorProbeContext } from './types'

const context = { caller: {}, cwd: '/tmp', accountId: 'account', model: 'provider/model', tools: ['web_fetch'] }
const created: Doctor[] = []
afterEach(async () => { await Promise.all(created.splice(0).map(doctor => doctor.close())) })
const check = (id: string, local: DoctorCheck['local'] = async () => ({ status: 'pass', evidence: 'Configured, not live.' })): DoctorCheck => ({ id, category: 'tools', title: id, local })
function service(checks: DoctorCheck[]) {
  const probe = vi.fn()
  const doctor = new Doctor({ checks: async () => checks, probe: async (_context, signal, action) => { probe(); return action({ context, signal } as unknown as DoctorProbeContext) }, timeout: { local: 200, live: 200, model: 200 } })
  created.push(doctor)
  return { doctor, probe }
}
async function settled(doctor: Doctor, id: string) {
  await vi.waitFor(() => expect(doctor.read(id).state).not.toBe('running'))
  return doctorReportSchema.parse(doctor.read(id))
}

describe('Doctor jobs', () => {
  it('runs local checks without live probes and keeps disabled tools distinct', async () => {
    const live = vi.fn()
    const enabled = { ...check('fetch'), tools: ['web_fetch'], live: { notice: 'Network request', run: live } }
    const disabled = { ...check('computer'), tools: ['computer_click'], live: { notice: 'Input', run: live } }
    const { doctor, probe } = service([enabled, disabled])
    const result = await settled(doctor, doctor.start({ context }).id)
    expect(result.findings.find(item => item.id === 'computer')?.status).toBe('disabled')
    expect(result.findings.find(item => item.id === 'fetch')?.verification).toBe('local')
    expect(result.liveChecks.map(item => item.id)).toEqual(['fetch'])
    expect(probe).not.toHaveBeenCalled()
    expect(live).not.toHaveBeenCalled()
  })
  it('requires selection and confirmation for live calls', () => {
    const { doctor } = service([])
    expect(() => doctor.start({ context, mode: 'live' })).toThrow('Select live checks')
    expect(() => doctor.start({ context, mode: 'live', confirmed: true })).toThrow('Select live checks')
  })
  it('runs only selected live checks serially', async () => {
    let active = 0
    const live = vi.fn(async () => { expect(active++).toBe(0); await Promise.resolve(); active--; return { status: 'pass' as const, evidence: 'Verified.' } })
    const { doctor, probe } = service(['a', 'b', 'c'].map(id => ({ ...check(id), live: { notice: 'Test', run: live } })))
    const result = await settled(doctor, doctor.start({ context, mode: 'live', checks: ['a', 'b'], confirmed: true }).id)
    expect(result.findings.map(item => item.id)).toEqual(['a', 'b'])
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('preserves partial results on cancellation and ignores late results', async () => {
    let aborted = false
    let finish: () => void = () => undefined
    const hanging = check('pending', signal => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true }); finish = () => resolve({ status: 'pass', evidence: 'Late' }) }))
    const { doctor } = service([check('done'), hanging])
    const id = doctor.start({ context }).id
    await vi.waitFor(() => expect(doctor.read(id).completed).toBe(1))
    // This check has a longer timeout so cancellation owns its result.
    expect(doctor.cancel(id).state).toBe('cancelled')
    expect(aborted).toBe(true)
    finish()
    await Promise.resolve()
    expect(doctor.read(id).findings.map(item => item.id)).toEqual(['done'])
  })
  it('times out an unresponsive check while retaining successful findings', async () => {
    const { doctor } = service([check('timeout', async () => new Promise(() => undefined)), check('good')])
    const report = await settled(doctor, doctor.start({ context }).id)
    expect(report.findings.find(item => item.id === 'timeout')?.status).toBe('fail')
    expect(report.completed).toBe(2)
  })
  it('redacts credentials and terminal controls', async () => {
    const { doctor } = service([check('secret', async () => ({ status: 'warning', evidence: '\x1b[31mAuthorization: Bearer secret-value https://user:password@example.com/?token=secret' }))])
    const result = await settled(doctor, doctor.start({ context }).id)
    const text = JSON.stringify(result.findings)
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('password')
    expect(text).not.toContain('token=secret')
    expect(text).not.toContain('\\u001b')
  })
  it('classifies scope refusals and contains setup errors', async () => {
    const blocked = Object.assign(new Error('Private detail'), { code: 'doctor_blocked' })
    const { doctor } = service([check('blocked', async () => { throw blocked })])
    const result = await settled(doctor, doctor.start({ context }).id)
    expect(result.findings[0].status).toBe('blocked')
    expect(result.findings[0].evidence).not.toContain('Private detail')
    const invalid = await settled(doctor, doctor.start({ context, checks: ['missing'] }).id)
    expect(invalid.findings[0].id).toBe('doctor')
  })
  it('returns snapshots and rejects unknown jobs', async () => {
    const { doctor } = service([check('a')])
    const report = await settled(doctor, doctor.start({ context }).id)
    report.findings.splice(0)
    expect(doctor.read(report.id).findings).toHaveLength(1)
    expect(() => doctor.read('missing')).toThrow()
  })
})
