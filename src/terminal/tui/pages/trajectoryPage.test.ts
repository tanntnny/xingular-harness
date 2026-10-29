import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../../../sessions/contracts'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../../trajectory'
import { PageOverlay } from '../pageOverlay'
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
  it('fills the screen and shows searchable events beside selected-event JSON', async () => {
    const { page } = setup()
    expect(page.presentation).toBe('fullscreen')
    expect(plain(page)).toContain('Loading recorded runs…')
    page.activate()
    await vi.waitFor(() => expect(page.selectedRunId).toBe('run-1'))
    expect(page.tabs().map(tab => tab.title)).toEqual(['Runs', 'Events'])
    expect(plain(page)).toContain('Type to search')

    page.handleInput('\t')
    let text = plain(page)
    expect(text).toContain('Run 1/1 · run-1 · completed')
    expect(text).toContain('context.snapshot')
    expect(text).toContain('tool.completed')
    expect(text).toContain('Event JSON · tool.completed · #2')
    expect(text).toContain('file contents')
    expect(text).toContain('"type": "tool.completed"')
    expect(page.selectedEvent?.sequence).toBe(2)
    expect(text).toContain(' │ ')

    const lines = page.render(100, 24).map(stripTerminalSequences)
    const eventRow = lines.find(line => line.includes('❯ ') && line.includes('tool.completed'))!
    const jsonRow = lines.find(line => line.includes('"type": "tool.completed"'))!
    expect(jsonRow.indexOf('"type":')).toBeGreaterThan(eventRow.indexOf('tool.completed'))
    const selectedRow = page.render(100, 24).find(line => stripTerminalSequences(line).includes('❯ '))
    expect(selectedRow).toContain(theme.getBgAnsi('selectedBg'))
    expect(selectedRow).not.toContain(theme.getFgAnsi('accent'))

    expect(page.handleInput('\x1b[A')).toBe(true)
    expect(page.selectedEvent?.sequence).toBe(1)
    text = plain(page)
    expect(text).toContain('README.md')
    expect(text).toContain('"type": "tool.started"')
    page.dispose()
  })

  it('shows refusals and interrupted reasons or codes in the event list', async () => {
    const target = run('run-1', 'interrupted')
    const events = [
      event(0, 'tool.refused', { toolCallId: 't1', name: 'write', code: 'plan_mode', reason: 'Read only' }),
      event(1, 'status.changed', { status: 'interrupted', reason: 'Budget reached', code: 'slice_budget' }),
      event(2, 'status.changed', { status: 'interrupted', code: 'stalled' })
    ]
    const { page } = await opened({ runs: [target], snapshot: { run: target, events } })
    page.handleInput('\t')
    const text = plain(page, 30, 160)
    expect(text).toContain('write refused (plan_mode) · Read only')
    expect(text).toContain('interrupted · Budget reached')
    expect(text).toContain('interrupted · stalled')
    page.dispose()
  })

  it('never prints a mouse report from recorded text', async () => {
    const target = { ...run('run-1'), goal: 'goal\x1b[<0;40;8M' }
    const events = [event(0, 'message.completed', { role: 'user', text: 'before\x1b[<65;56;29Mafter' })]
    const { page } = await opened({ runs: [target], snapshot: { run: target, events } })
    page.handleInput('\t')
    const text = plain(page)
    expect(text).not.toContain('65;56;29')
    expect(text).not.toContain('40;8')
    expect(text).toContain('beforeafter')
    page.dispose()
  })

  it('keeps a bare mouse tail, which was recorded content', async () => {
    const events = [event(0, 'message.completed', { role: 'user', text: 'why <65;56;29M here' })]
    const { page } = await opened({ snapshot: { run: run('run-1'), events } })
    page.handleInput('\t')
    expect(plain(page)).toContain('why <65;56;29M here')
    page.dispose()
  })

  it('filters runs and events by goal, type, timestamp, summary, and payload text', async () => {
    const first = run('run-1')
    const second = { ...run('run-2'), goal: 'Ship the search feature' }
    const { page } = await opened({ runs: [first, second] })
    page.handleInput('search')
    expect(plain(page)).toContain('run-2')
    expect(plain(page)).not.toContain('run-1')

    page.handleInput('\t')
    page.handleInput('context.snapshot')
    expect(page.selectedEvent?.type).toBe('context.snapshot')
    let text = plain(page)
    expect(text).toContain('"systemPrompt": "prompt"')
    expect(text).not.toContain('tool.completed')

    page.handleInput('\x1b')
    page.handleInput('00:00:01')
    expect(page.selectedEvent?.sequence).toBe(1)
    page.handleInput('\x1b')
    page.handleInput('README.md')
    expect(page.selectedEvent?.sequence).toBe(1)
    page.handleInput('\x1b')
    page.handleInput('Recorded prompt')
    expect(page.selectedEvent?.type).toBe('context.snapshot')
    page.handleInput('\x1b')
    text = plain(page)
    expect(text).toContain('tool.completed')
    page.dispose()
  })

  it('renders full-screen through the page overlay, including on a centered-dialog host', async () => {
    const { page } = await opened()
    const terminal = { columns: 120, rows: 40 }
    const overlay = new PageOverlay({
      page,
      tui: { terminal, centeredDialogs: true } as unknown as TUI,
      theme: () => theme,
      close: vi.fn(),
      changed: vi.fn()
    })
    const lines = overlay.render(terminal.columns).map(stripTerminalSequences)
    expect(lines).toHaveLength(40)
    expect(lines[0]).toContain('Runs')
    expect(lines[1]).toContain('─')
    expect(lines.at(-1)).toContain('Esc close')
    overlay.dispose()
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

  it('copies the selected event JSON', async () => {
    const { page, copy, notify } = await opened()
    page.handleInput('\t')
    page.handleInput('C')
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(JSON.parse(copy.mock.calls[0]![0])).toMatchObject({ type: 'tool.completed', sequence: 2 })
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Copied selected trajectory event'))
    page.dispose()
  })

  it('refreshes an active run and follows its newest event until the page closes', async () => {
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
    expect(page.selectedEvent?.sequence).toBe(1)
    page.deactivate()
    const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(read).toHaveBeenCalledTimes(calls)
    page.dispose()
  })

  it('says when there are no runs and bounds narrow and compact layouts', async () => {
    const { page } = setup({ runs: [] })
    page.activate()
    await vi.waitFor(() => expect(plain(page)).toContain('No runs recorded for this native session yet'))
    page.dispose()
    const { page: small } = await opened({ snapshot: { run: run('run-1'), events: [] } })
    small.handleInput('\t')
    expect(plain(small, 6)).toContain('No recorded events')
    for (const rows of [0, 1, 3, 6, 12, 30]) for (let width = 0; width <= 100; width++) {
      const lines = small.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
    small.dispose()
  })
})
