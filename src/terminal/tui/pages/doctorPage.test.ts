import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
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
const joinLines = (lines: string[]) => lines.join('\n')
function plainReport(page: DoctorPage): string {
  return joinLines(page.render(110, 30).map(stripTerminalSequences))
}

function setup(report: DoctorReport = completed) {
  const call = vi.fn(async () => structuredClone(report))
  const confirm = vi.fn(async (_title: string, _message: string) => true)
  const select = vi.fn(async (_title: string, _items: string[]): Promise<string | undefined> => undefined)
  const page = new DoctorPage({ theme: () => theme, call, confirm, select, changed: vi.fn(), selection: () => ({ model: 'provider/model', tools: [] }) })
  const plain = (width = 90) => joinLines(page.render(width, 20).map(stripTerminalSequences))
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
  it('renders aligned status columns with theme colors and stacks cleanly when narrow', async () => {
    const statuses: DoctorReport['findings'][number]['status'][] = ['pass', 'warning', 'fail', 'disabled', 'blocked', 'unverified']
    const findings: DoctorReport['findings'] = statuses.map((status, index) => ({
      id: `check-${index}`, category: 'readiness', title: `Check ${status}`, status,
      verification: index % 2 ? 'live' : 'local', evidence: `Evidence for ${status}.`, checkedAt: 'now',
      remedy: `Review ${status}.`
    }))
    const { page } = setup({ ...completed, findings, total: findings.length, completed: findings.length })
    page.activate()
    await vi.waitFor(() => expect(plainReport(page)).toContain('Check unverified'))

    const wide = joinLines(page.render(110, 30))
    const wideText = stripTerminalSequences(wide)
    expect(wideText).toContain('STATUS')
    expect(wideText).toContain('CATEGORY')
    expect(wideText).toContain('VERIFY')
    expect(wideText).toContain('Evidence: Evidence for pass.')
    expect(wideText).toContain('Next step: Review pass.')
    for (const [status, tone] of [['pass', 'success'], ['warning', 'warning'], ['fail', 'error'], ['disabled', 'dim'], ['blocked', 'warning'], ['unverified', 'muted']] as const) {
      expect(wide).toContain(theme.fg(tone, status.toUpperCase()))
    }

    const narrow = page.render(32, 20)
    expect(joinLines(narrow.map(stripTerminalSequences))).toContain('PASS · Check pass')
    expect(narrow.every(line => visibleWidth(line) <= 32)).toBe(true)
    page.dispose()
  })
  it('scrolls findings by line and page and supports Home/End', async () => {
    const findings: DoctorReport['findings'] = Array.from({ length: 8 }, (_, index) => ({
      id: `check-${index}`, category: 'runtime', title: `Check ${index}`, status: 'pass',
      verification: 'local', evidence: `Evidence for check ${index}.`, checkedAt: 'now'
    }))
    const { page } = setup({ ...completed, findings, total: findings.length, completed: findings.length })
    page.activate()
    await vi.waitFor(() => expect(plainReport(page)).toContain('Check 7'))

    const initial = joinLines(page.render(80, 8).map(stripTerminalSequences))
    expect(initial).toContain('Check 0')
    const escape = String.fromCharCode(27)
    expect(page.handleInput(`${escape}[6~`)).toBe(true)
    const afterPage = joinLines(page.render(80, 8).map(stripTerminalSequences))
    expect(afterPage).not.toContain('Check 0')
    expect(page.handleInput(`${escape}[F`)).toBe(true)
    expect(joinLines(page.render(80, 8).map(stripTerminalSequences))).toContain('Check 7')
    expect(page.handleInput(`${escape}[H`)).toBe(true)
    expect(joinLines(page.render(80, 8).map(stripTerminalSequences))).toContain('Check 0')
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
