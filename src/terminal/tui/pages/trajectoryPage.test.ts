import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../../../sessions/contracts'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../../trajectory'
import { createHarnessTheme } from '../theme'
import { TrajectoryPage } from './trajectoryPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const event = (sequence: number, type: string, payload: unknown): RunEvent => ({
  id: `event-${sequence}`, runId: 'run-1', sessionId: 'terminal-1', sequence,
  timestamp: `2026-10-18T00:00:0${sequence}.000Z`, type: type as RunEvent['type'], payload
})
const run = (id: string, status = 'completed'): TerminalTrajectoryRun => ({
  id, mode: 'code', goal: 'Read the readme', startedAt: '2026-10-18T00:00:00.000Z', endedAt: status === 'completed' ? '2026-10-18T00:00:03.000Z' : null, status
})

function setup(options: { runs?: TerminalTrajectoryRun[]; snapshot?: TerminalTrajectorySnapshot; read?: (runId: string, afterSequence?: number) => Promise<TerminalTrajectorySnapshot>; initialRunId?: string } = {}) {
  const events = [
    event(0, 'context.snapshot', { systemPrompt: 'prompt', tools: [{ name: 'read' }] }),
    event(1, 'tool.started', { toolCallId: 'tool-1', name: 'read', input: '{"path":"README.md"}' }),
    event(2, 'tool.completed', { toolCallId: 'tool-1', name: 'read', output: 'file contents', ok: true })
  ]
  const runs = options.runs ?? [run('run-1')]
  const initial = options.snapshot ?? { run: runs[0]!, events }
  const read = options.read ?? vi.fn(async () => initial)
  const copy = vi.fn(async (_text: string) => {})
  const changed = vi.fn()
  const notify = vi.fn()
  const page = new TrajectoryPage({ theme: () => theme, runs: async () => runs, read, copy, notify, changed, initialRunId: options.initialRunId })
  return { page, read, copy, changed, notify }
}
const plain = (page: TrajectoryPage, rows = 24, width = 100) => page.render(width, rows).map(stripTerminalSequences).join('\n')
async function opened(options: Parameters<typeof setup>[0] = {}) {
  const made = setup(options)
  made.page.activate()
  await vi.waitFor(() => expect(made.page.selectedRunId).toBeDefined())
  return made
}

afterEach(() => vi.useRealTimers())

describe('the Trajectory page', () => {
  it('says it is loading, then shows run usage, a selectable event ledger and the selected payload', async () => {
    const { page } = setup()
    expect(plain(page)).toContain('Loading recorded runs…')
    page.activate()
    await vi.waitFor(() => expect(page.selectedRunId).toBe('run-1'))
    expect(page.tabs().map(tab => tab.title)).toEqual(['Runs', 'Events'])
    page.handleInput('\t')
    const text = plain(page)
    expect(text).toContain('Run 1/1 · run-1 · completed')
    expect(text).toContain('context.snapshot')
    expect(text).toContain('tool.completed')
    expect(text).toContain('file contents')
    expect(page.selectedEvent?.sequence).toBe(2)
    expect(text).not.toMatch(/[╭╮╰╯│├┤]/)
    const selectedRow = page.render(100, 24).find(line => stripTerminalSequences(line).includes('❯ '))
    expect(selectedRow).toContain(theme.getBgAnsi('selectedBg'))
    expect(selectedRow).not.toContain(theme.getFgAnsi('accent'))
    expect(page.handleInput('\x1b[A')).toBe(true)
    expect(page.selectedEvent?.sequence).toBe(1)
    expect(plain(page)).toContain('README.md')
    page.dispose()
  })

  it('moves between runs with [ and ], while the page owns run and event sections', async () => {
    const first = run('run-1')
    const second = run('run-2')
    const secondSnapshot = { run: second, events: [event(0, 'message.completed', { role: 'assistant', text: 'Second run' })] }
    const { page, read } = await opened({ runs: [first, second], read: vi.fn(async (id) => id === 'run-2' ? secondSnapshot : { run: first, events: [] }) })
    page.handleInput('\t')
    for (const key of ['\x1b[D', '\x1b[C', '\x1b']) expect(page.handleInput(key)).toBe(false)
    expect(page.handleInput('[')).toBe(true)
    await vi.waitFor(() => expect(page.selectedRunId).toBe('run-2'))
    expect(read).toHaveBeenCalledWith('run-2')
    await vi.waitFor(() => expect(page.selectedEvent?.type).toBe('message.completed'))
    page.handleInput(']')
    await vi.waitFor(() => expect(page.selectedRunId).toBe('run-1'))
    await vi.waitFor(() => expect(plain(page)).toContain('No recorded events'))
    page.dispose()
  })

  it('opens on the requested run, and says when it is not in this conversation', async () => {
    const first = run('run-1')
    const second = run('run-2')
    const secondSnapshot = { run: second, events: [event(0, 'message.completed', { role: 'assistant', text: 'Second run' })] }
    const { page } = await opened({ runs: [first, second], initialRunId: 'run-2', read: vi.fn(async () => secondSnapshot) })
    expect(page.selectedRunId).toBe('run-2')
    page.dispose()
    const missing = setup({ initialRunId: 'other-run' })
    missing.page.activate()
    await vi.waitFor(() => expect(plain(missing.page)).toContain('Read error: Run not found in this native session'))
    missing.page.dispose()
  })

  it('copies the selected event', async () => {
    const { page, copy, notify } = await opened()
    page.handleInput('\t')
    page.handleInput('c')
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(JSON.parse(copy.mock.calls[0]![0])).toMatchObject({ type: 'tool.completed', sequence: 2 })
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Copied selected trajectory event'))
    page.dispose()
  })

  it('refreshes an active run on the page and stops polling when it closes', async () => {
    vi.useFakeTimers()
    const active = run('run-1', 'running')
    const completed = run('run-1')
    const initial = { run: active, events: [event(0, 'started', {})] }
    const updated = { run: completed, events: [event(1, 'completed', {})] }
    const read = vi.fn(async (_id: string, afterSequence?: number) => afterSequence === 0 ? updated : initial)
    const { page } = setup({ snapshot: initial, read, runs: [active] })
    page.activate()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledWith('run-1', 0)
    expect(plain(page)).toContain('completed')
    page.deactivate()
    const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(read).toHaveBeenCalledTimes(calls)
    page.dispose()
  })

  it('says when there are no runs, and bounds output for small terminals and narrow widths', async () => {
    const { page } = setup({ runs: [] })
    page.activate()
    await vi.waitFor(() => expect(plain(page)).toContain('No runs recorded for this native session yet'))
    page.dispose()
    const { page: small } = await opened({ snapshot: { run: run('run-1'), events: [] } })
    small.handleInput('\t')
    expect(plain(small, 6)).toContain('No recorded events')
    for (const rows of [0, 1, 3, 6, 12, 30]) for (let width = 0; width <= 60; width++) {
      const lines = small.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
    small.dispose()
  })
})
