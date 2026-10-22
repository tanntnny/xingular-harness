import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../harness'
import { memorySecretStore } from '../accounts/secrets'
import { methods } from '../server/methods'
import { doctorReportSchema, type DoctorReport } from './types'
import { listRuns, readEvents } from '../sessions/runStore'
import { diagnosticProbe } from './probe'

const resources: { harness: Harness; root: string }[] = []
afterEach(async () => { for (const { harness, root } of resources.splice(0)) { await harness.close(); rmSync(root, { recursive: true, force: true }) } })
function setup(policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-test-'))
  const data = join(root, 'data')
  mkdirSync(data)
  const harness = createHarness({ stateDir: join(root, 'state'), secrets: memorySecretStore(), policy })
  harness.open(data)
  resources.push({ harness, root })
  const context = { caller: {}, cwd: root, accountId: null as string | null, model: null as string | null, tools: ['web_fetch', 'web_search'] }
  return { harness, context, table: methods(harness) }
}
async function wait(harness: Harness, report: DoctorReport) {
  await vi.waitFor(() => expect(harness.doctor.read(report.id).state).not.toBe('running'), { timeout: 5000 })
  return harness.doctor.read(report.id)
}

describe('Harness diagnostics integration', () => {
  it('exposes the same reports through Node and protocol without requesting a model', async () => {
    const { harness, context, table } = setup()
    const runtime = vi.spyOn(harness.accounts, 'runtime').mockRejectedValue(new Error('No requests allowed'))
    const initial = await table['doctor.start']({ context, checks: ['account', 'model', 'web.search', 'variant', 'runtime.storage'] }) as DoctorReport
    const report = await wait(harness, initial)
    expect(doctorReportSchema.parse(await table['doctor.read']({ id: report.id }))).toEqual(report)
    expect(report.findings.find(item => item.id === 'account')?.status).toBe('fail')
    expect(report.findings.find(item => item.id === 'model')?.status).toBe('fail')
    expect(report.findings.find(item => item.id === 'web.search')?.status).toBe('fail')
    expect(report.findings.find(item => item.id === 'runtime.storage')?.status).toBe('pass')
    expect(runtime).not.toHaveBeenCalled()
    expect(listRuns(harness.env.root, {})).toHaveLength(0)
    expect(await table['doctor.cancel']({ id: report.id })).toEqual(report)
  })
  it('inspects model availability offline and never switches the pinned account', async () => {
    const { harness, context } = setup()
    const account = harness.accounts.create('Doctor test', 'apiKey').accounts[0]
    const inspect = vi.spyOn(harness.accounts, 'inspect').mockResolvedValue({ credentials: 1, models: [{ id: 'test/model', name: 'Test', provider: 'test', supportsImages: true, reasoning: false }] })
    const runtime = vi.spyOn(harness.accounts, 'runtime').mockRejectedValue(new Error('Must not refresh authentication'))
    const report = await wait(harness, harness.doctor.start({ context: { ...context, accountId: account.id, model: 'test/model' }, checks: ['account', 'model'] }))
    expect(report.findings.every(item => item.status === 'pass')).toBe(true)
    expect(inspect).toHaveBeenCalledWith(account.id, expect.any(AbortSignal))
    expect(runtime).not.toHaveBeenCalled()
  })
  it('uses the existing policy gate and frozen capabilities for tool probes', async () => {
    const scope = vi.fn(async () => ({ allowed: false, reason: 'Refused for this test' }))
    const { harness, context } = setup({ scope })
    const execute = vi.fn(async () => 'never')
    harness.sessions.provide(() => [{ name: 'diagnostic_test', label: 'Test', description: 'Test', readOnly: true, parameters: Type => Type.Object({}), execute }])
    await expect(diagnosticProbe(harness, { ...context, tools: ['diagnostic_test'] }, new AbortController().signal, probe => probe.call('diagnostic_test', {}))).rejects.toMatchObject({ code: 'doctor_blocked' })
    expect(scope).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    await expect(diagnosticProbe(harness, { ...context, tools: [] }, new AbortController().signal, probe => probe.call('diagnostic_test', {}))).rejects.toMatchObject({ code: 'doctor_blocked' })
    expect(scope).toHaveBeenCalledOnce()
    expect(harness.runs.activeRunIds()).toEqual([])
  })
  it('executes real registered tools in separate runs and records no tool payloads', async () => {
    const { harness, context } = setup()
    const execute = vi.fn(async () => ({ text: 'private-secret-result' }))
    harness.sessions.provide(() => [{ name: 'diagnostic_test', label: 'Test', description: 'Test', readOnly: true, parameters: Type => Type.Object({}), execute }])
    await diagnosticProbe(harness, { ...context, tools: ['diagnostic_test'] }, new AbortController().signal, probe => probe.call('diagnostic_test', {}))
    expect(execute).toHaveBeenCalledOnce()
    const [run] = listRuns(harness.env.root, {})
    expect(run).toMatchObject({ status: 'completed', trigger: 'doctor' })
    expect(JSON.stringify(readEvents(harness.env.root, run.id))).not.toContain('private-secret-result')
  })
  it('makes one bounded synthetic model request and records usage in its own run', async () => {
    const { harness, context } = setup()
    const account = harness.accounts.create('Doctor model', 'apiKey').accounts[0]
    const completeSimple = vi.fn(async () => ({ provider: 'test', model: 'model', stopReason: 'stop', usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }))
    vi.spyOn(harness.accounts, 'runtime').mockResolvedValue({ getAvailable: async () => [{ provider: 'test', id: 'model' }], completeSimple } as never)
    const report = await wait(harness, harness.doctor.start({ context: { ...context, accountId: account.id, model: 'test/model' }, mode: 'live', checks: ['model'], confirmed: true }))
    expect(report.findings[0].status).toBe('pass')
    expect(completeSimple).toHaveBeenCalledExactlyOnceWith(
      { provider: 'test', id: 'model' },
      { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: expect.any(Number) }] },
      { maxTokens: 64, signal: expect.any(AbortSignal) }
    )
    const [run] = listRuns(harness.env.root, {})
    expect(run.accountId).toBe(account.id)
    expect(readEvents(harness.env.root, run.id).find(event => event.type === 'usage.updated')?.payload).toMatchObject({ requests: 1, inputTokens: 4, outputTokens: 1, costUsd: 0.01 })
  })
  it('inspects real stored credentials without writes or network fetches', async () => {
    const { harness } = setup()
    const account = harness.accounts.create('Offline', 'apiKey').accounts[0]
    await harness.accounts.writeCredential(account.id, 'openai', { type: 'api_key', key: 'diagnostic-placeholder' })
    const write = vi.spyOn(harness.accounts, 'writeCredential')
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden'))
    try {
      const result = await harness.accounts.inspect(account.id)
      expect(result.credentials).toBe(1)
      expect(result.models.some(model => model.provider === 'openai')).toBe(true)
      expect(write).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    } finally { request.mockRestore() }
  })

  it('still reports missing storage when no data root is open', async () => {
    const { harness, context } = setup()
    harness.env.dataRoot = null
    const report = await wait(harness, harness.doctor.start({ context, checks: ['runtime.storage', 'plugins', 'variant'] }))
    expect(report.findings.map(item => item.id).sort()).toEqual(['plugins', 'runtime.storage', 'variant'])
    expect(report.findings.find(item => item.id === 'runtime.storage')?.status).toBe('fail')
    expect(report.findings.find(item => item.id === 'plugins')?.status).toBe('blocked')
  })
  it('contains a failed provider inspector without losing other findings', async () => {
    const { harness, context } = setup()
    const provider = Object.assign(() => [], { diagnostics: async () => { throw new Error('Bad provider') } })
    harness.sessions.provide(provider)
    const report = await wait(harness, harness.doctor.start({ context }))
    expect(report.findings.some(item => item.id.startsWith('provider.') && item.status === 'fail')).toBe(true)
    expect(report.findings.find(item => item.id === 'runtime.storage')?.status).toBe('pass')
  })

})
