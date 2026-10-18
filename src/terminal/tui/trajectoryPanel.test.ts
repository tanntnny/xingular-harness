import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../../sessions/contracts'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'
import { TrajectoryPanel } from './trajectoryPanel'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const run = (id: string, status = 'completed'): TerminalTrajectoryRun => ({
  id, mode: 'code', goal: `Goal for ${id}`, startedAt: '2026-10-18T00:00:00.000Z', endedAt: status === 'running' ? null : '2026-10-18T00:00:02.000Z', status
})
const event = (sequence: number, type: string, payload: unknown): RunEvent => ({
  id: `event-${sequence}`, runId: 'run-1', sessionId: 'terminal-1', sequence,
  timestamp: `2026-10-18T00:00:0${sequence}.000Z`, type: type as RunEvent['type'], payload
})
function setup(options: { runs?: TerminalTrajectoryRun[]; snapshot?: TerminalTrajectorySnapshot; read?: (runId: string, afterSequence?: number) => Promise<TerminalTrajectorySnapshot>; rows?: number } = {}) {
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
  const close = vi.fn()
  const panel = new TrajectoryPanel({
    tui: { terminal: { rows: options.rows ?? 28 } } as unknown as TUI,
    theme, runs, initialIndex: 0, initial, read, copy, changed, notify, close
  })
  return { panel, events, runs, read, copy, changed, notify, close }
}

afterEach(() => vi.useRealTimers())

describe('the terminal Trajectory panel', () => {
  it('shows run usage, a selectable event ledger, and the selected event payload', () => {
    const { panel } = setup()
    const text = panel.render(100).map(stripTerminalSequences).join('\n')
    expect(text).toContain('Run 1/1 · run-1 · completed')
    expect(text).toContain('context.snapshot')
    expect(text).toContain('tool.completed')
    expect(text).toContain('file contents')
    expect(panel.selectedEvent?.sequence).toBe(2)

    panel.handleInput('\x1b[A')
    expect(panel.selectedEvent?.sequence).toBe(1)
    expect(panel.render(100).map(stripTerminalSequences).join('\n')).toContain('README.md')
  })

  it('moves between runs, closes, and copies the selected event', async () => {
    const first = run('run-1')
    const second = run('run-2')
    const secondSnapshot = { run: second, events: [event(0, 'message.completed', { role: 'assistant', text: 'Second run' })] }
    const { panel, read, copy, close } = setup({ runs: [first, second], read: vi.fn(async (id) => id === 'run-2' ? secondSnapshot : { run: first, events: [] }) })
    panel.handleInput('\x1b[D')
    await vi.waitFor(() => expect(panel.selectedRunId).toBe('run-2'))
    expect(read).toHaveBeenCalledWith('run-2')
    expect(panel.selectedEvent?.type).toBe('message.completed')
    panel.handleInput('c')
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(JSON.parse(copy.mock.calls[0]![0])).toMatchObject({ type: 'message.completed', sequence: 0 })
    panel.handleInput('\x1b')
    expect(close).toHaveBeenCalledOnce()
    panel.dispose()
  })

  it('refreshes active runs and stops polling when disposed', async () => {
    vi.useFakeTimers()
    const active = run('run-1', 'running')
    const completed = run('run-1')
    const initial = { run: active, events: [event(0, 'started', {})] }
    const updated = { run: completed, events: [event(1, 'completed', {})] }
    const read = vi.fn(async (_id: string, afterSequence?: number) => afterSequence === 0 ? updated : initial)
    const { panel } = setup({ snapshot: initial, read })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledWith('run-1', 0)
    expect(panel.render(100).map(stripTerminalSequences).join('\n')).toContain('completed')
    const calls = read.mock.calls.length
    panel.dispose()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(read).toHaveBeenCalledTimes(calls)
  })

  it('bounds output to narrow terminals and handles runs without recorded events', () => {
    const { panel } = setup({ snapshot: { run: run('run-1'), events: [] }, rows: 10 })
    const rows = panel.render(24)
    expect(rows.length).toBeLessThanOrEqual(5)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(24)
    expect(rows.map(stripTerminalSequences).join('\n')).toContain('No recorded events')
    panel.handleInput('\x1b[B')
    expect(panel.selectedEvent).toBeUndefined()
    panel.dispose()
  })
})
