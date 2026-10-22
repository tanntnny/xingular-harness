import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { DoctorPage } from './doctorPage'
import { createHarnessTheme } from '../theme'
import type { DoctorReport } from '../../../doctor/types'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const completed: DoctorReport = {
  id: 'job', state: 'completed', startedAt: 'now', endedAt: 'now', mode: 'local',
  context: { accountId: 'account', model: 'provider/model' }, total: 1, completed: 1,
  findings: [{ id: 'model', category: 'account', title: 'Selected model', status: 'pass', verification: 'local', evidence: 'Configured; provider access is unverified.', checkedAt: 'now' }],
  liveChecks: [{ id: 'model', title: 'Selected model', notice: 'One provider request; charges may apply.' }]
}
function setup(report: DoctorReport = completed) {
  const call = vi.fn(async () => structuredClone(report))
  const confirm = vi.fn(async (_title: string, _message: string) => true)
  const select = vi.fn(async (_title: string, _items: string[]): Promise<string | undefined> => undefined)
  const page = new DoctorPage({ theme: () => theme, call, confirm, select, changed: vi.fn(), selection: () => ({ model: 'provider/model', tools: [] }) })
  const plain = (width = 90) => page.render(width, 20).map(stripTerminalSequences).join('\n')
  return { page, call, confirm, select, plain }
}

describe('Doctor terminal page', () => {
  it('starts local checks, renders evidence, and wraps at narrow widths', async () => {
    const { page, call, plain } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain()).toContain('provider access is unverified'))
    expect(call).toHaveBeenCalledWith('terminal.doctor.start', { model: 'provider/model', tools: [], mode: 'local', checks: [], confirmed: false })
    expect(plain(25)).toContain('local')
    page.dispose()
  })
  it('requires selection and confirmation before a live job', async () => {
    const { page, call, confirm, select, plain } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain()).toContain('unverified'))
    select.mockResolvedValueOnce('[ ] Selected model').mockResolvedValueOnce('Run selected checks')
    page.handleInput('l')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(confirm.mock.calls[0]?.[1]).toContain('charges may apply')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.doctor.start', expect.objectContaining({ mode: 'live', checks: ['model'], confirmed: true })))
    page.dispose()
  })
  it('does not start live work after declining confirmation', async () => {
    const { page, call, confirm, select, plain } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain()).toContain('unverified'))
    confirm.mockResolvedValueOnce(false)
    select.mockResolvedValueOnce('[ ] Selected model').mockResolvedValueOnce('Run selected checks')
    page.handleInput('l')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(call).toHaveBeenCalledTimes(1)
    page.dispose()
  })
  it('cancels outstanding work when the page is closed', async () => {
    const { page, call, plain } = setup({ ...completed, state: 'running', endedAt: null })
    page.activate()
    await vi.waitFor(() => expect(plain()).toContain('running'))
    page.dispose()
    expect(call).toHaveBeenCalledWith('terminal.doctor.cancel', { id: 'job' })
  })
})
