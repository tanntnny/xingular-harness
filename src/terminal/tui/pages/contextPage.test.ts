import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { ContextAttribution, ContextRow } from '../../../context/types'
import { createHarnessTheme } from '../theme'
import { PageOverlay } from '../pageOverlay'
import { ContextPage, allocateCells, contextBar } from './contextPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function row(overrides: Partial<ContextRow> & { id: string; title: string }): ContextRow {
  return { group: 'foundation', tokens: 1_000, chars: 4_000, share: 0.1, always: true, estimated: true, ...overrides }
}

const attribution: ContextAttribution = {
  runId: 'run-1',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  window: 1_000_000,
  used: 183_400,
  share: 18.34,
  source: 'measured',
  request: 3,
  compaction: { enabled: true, reserveTokens: 16_384 },
  free: 800_216,
  rows: [
    row({ id: 'harness-identity', title: 'Harness identity', tokens: 29, chars: 116, share: 0.0 }),
    row({ id: 'tools-harness', title: 'Tool schemas · 21 tools', tokens: 9_400, chars: 37_600, share: 0.9, tools: [{ group: 'Native', count: 6 }, { group: 'Wiki', count: 4 }] }),
    row({ id: 'framing', title: 'Prompt framing', tokens: 1_100, chars: 4_400, share: 0.1 }),
    row({ id: 'system', title: 'Instructions', group: 'variant', tokens: 8_200, chars: 32_800, share: 0.8, budget: 24_000 }),
    row({ id: 'guardrails', title: 'Guardrails', group: 'variant', tokens: 4_100, chars: 16_400, share: 0.4 }),
    row({ id: 'role', title: 'Role', group: 'application', tokens: 2_400, chars: 9_600, share: 0.2 }),
    row({ id: 'tools-application', title: 'Tool schemas · 7 tools', group: 'application', tokens: 6_300, chars: 25_200, share: 0.6 }),
    row({ id: 'wiki', title: 'Wiki', group: 'conversation', tokens: 400, chars: 1_600, share: 0.0, always: false }),
    row({ id: 'messages', title: 'Messages and tool results', group: 'conversation', tokens: 134_706, chars: null, share: 13.5, always: false, estimated: false, note: 'measured by subtraction' }),
    row({ id: 'compaction-reserve', title: 'Compaction reserve', group: 'reserved', tokens: 16_384, chars: null, share: 1.6, note: 'Pi, auto-compaction' })
  ],
  history: [
    { request: 1, used: 41_400, share: 4.1, at: '2026-03-09T10:00:00.000Z' },
    { request: 2, used: 88_600, share: 8.9, at: '2026-03-09T10:05:00.000Z' },
    { request: 3, used: 183_400, share: 18.3, at: '2026-03-09T10:09:00.000Z' }
  ],
  compactions: [{ at: '2026-03-09T10:07:00.000Z', before: 112_000, after: 44_200 }],
  onDemand: [{ id: 'skills', title: 'Skills (c6)', items: 12, tokensEach: 4_200, note: 'loaded when a situation matches' }],
  totals: { foundation: 10_529, variant: 12_300, application: 8_700, conversation: 135_106, reserved: 16_384 },
  recordedAt: '2026-03-09T10:00:00.000Z',
  note: 'Rows are estimated from recorded characters, four per token, and reconciled to the measured request.'
}

const plain = (lines: readonly string[]): string => lines.map(stripTerminalSequences).join('\n')

function setup(initialTab?: 'request' | 'growth') {
  const call = vi.fn(async (_method: string, params?: Record<string, unknown>) => params?.section === 'system'
    ? { attribution: structuredClone(attribution), text: { id: 'system', title: 'Instructions', text: 'You draft release notes.\n\nKeep them short.' } }
    : { attribution: structuredClone(attribution), text: null })
  const changed = vi.fn()
  const openVariant = vi.fn()
  const page = new ContextPage({ theme: () => theme, call, changed, openVariant, ...(initialTab ? { initialTab } : {}) })
  return { page, call, changed, openVariant }
}

describe('Context terminal page', () => {
  it('shows the reading, every owner group and each row', async () => {
    const { page, call } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('Harness identity'))
    expect(call).toHaveBeenCalledWith('terminal.context', {})
    const text = plain(page.render(100, 30))
    expect(page.presentation).toBe('fullscreen')
    expect(text).toContain('183.4K of 1M')
    expect(text).toContain('18.3% used · measured')
    expect(text).toContain('Foundation · harness')
    expect(text).toContain('Variant')
    expect(text).toContain('Your application')
    expect(text).toContain('Conversation')
    expect(text).toContain('Compaction reserve')
    expect(text).toContain('free 800.2K')
    expect(text).toContain('On demand')
    expect(text).toContain('Skills (c6)')
    expect(text).toContain('measured by subtraction')
    page.dispose()
  })

  it('fits the terminal and keeps the hint visible', async () => {
    const { page } = setup()
    const tui = { terminal: { columns: 80, rows: 24 }, centeredDialogs: true } as unknown as TUI
    const overlay = new PageOverlay({ page, tui, theme: () => theme, close: vi.fn(), changed: vi.fn() })
    overlay.mounted()
    await vi.waitFor(() => expect(plain(overlay.render(80))).toContain('Harness identity'))
    const rows = overlay.render(80).map(stripTerminalSequences)
    expect(rows).toHaveLength(24)
    expect(rows[0]).toContain('Run details')
    expect(rows[0]).toContain('Context usage')
    expect(rows[1]).toBe('─'.repeat(80))
    expect(rows.every((line) => visibleWidth(line) <= 80)).toBe(true)
    expect(rows.at(-1)).toContain('↑/↓ move')
  })

  it('opens the text a row contributed and closes it with escape', async () => {
    const { page, call } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('Harness identity'))
    page.handleInput('\u001b[B')
    page.handleInput('\u001b[B')
    page.handleInput('\u001b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('You draft release notes.'))
    expect(call).toHaveBeenCalledWith('terminal.context', { section: 'system' })
    expect(plain(page.render(100, 30))).toContain('Keep them short.')
    page.handleInput('\u001b')
    expect(plain(page.render(100, 30))).not.toContain('You draft release notes.')
    page.dispose()
  })

  it('regroups by kind with g, and folds a group with space', async () => {
    const { page } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('Foundation · harness'))
    page.handleInput('g')
    const kinds = plain(page.render(100, 40))
    expect(kinds).toContain('System prompt')
    expect(kinds).toContain('Tools')
    expect(kinds).toContain('Messages')
    expect(kinds).not.toContain('Foundation · harness')
    page.handleInput('g')
    page.handleInput(' ')
    expect(plain(page.render(100, 40))).not.toContain('Harness identity')
    page.dispose()
  })

  it('shows the window at each request on the growth tab', async () => {
    const { page } = setup('growth')
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('REQUEST'))
    const text = plain(page.render(100, 30))
    expect(text).toContain('3 requests · peak 183.4K')
    expect(text).toContain('compacted 112.0K → 44.2K')
    expect(text).toContain('18.3%')
    page.selectTab('request')
    expect(page.activeTab()).toBe('request')
    page.dispose()
  })

  it('selects older recorded runs and carries their exact id to trajectory', async () => {
    const openTrajectory = vi.fn()
    const readDetails = vi.fn(async (runId: string) => ({ runId, status: 'completed', mode: null, model: null, effort: null, variantScope: null, variantVersion: null, workspaceRoot: null, tools: [], connectors: null, skills: null, plugins: null }))
    const call = vi.fn(async () => ({ attribution: null }))
    const page = new ContextPage({ theme: () => theme, call, changed: vi.fn(), initialTab: 'details', runs: async () => [{ id: 'new' }, { id: 'old' }], readDetails, openTrajectory })
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(80, 24))).toContain('Run 1/2 · new'))
    expect(plain(page.render(80, 24))).toContain('Tools: None')
    expect(plain(page.render(80, 24))).toContain('Model: Unknown')
    page.handleInput('[')
    await vi.waitFor(() => expect(plain(page.render(80, 24))).toContain('Run 2/2 · old'))
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.context', { runId: 'old' }))
    page.handleInput('t')
    expect(openTrajectory).toHaveBeenCalledWith('old')
    page.dispose()
  })

  it('says so before the first reply', async () => {
    const call = vi.fn(async () => ({ attribution: null, text: null }))
    const page = new ContextPage({ theme: () => theme, call, changed: vi.fn() })
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(80, 24))).toContain('No reply yet'))
    page.dispose()
  })
})

describe('the context bar', () => {
  const SERIES = ['38;2;57;135;229', '38;2;217;89;38', '38;2;25;158;112', '38;2;201;133;0']

  it('gives every kind of context its own colour, in a fixed order', () => {
    const first = contextBar(attribution, 80, theme)
    for (const code of SERIES) expect(first.bar).toContain(code)
    expect(contextBar(attribution, 80, theme).bar).toBe(first.bar)
    const withoutApplication = contextBar({ ...attribution, totals: { ...attribution.totals, application: 0 }, rows: attribution.rows.filter((row) => row.group !== 'application') }, 80, theme)
    expect(withoutApplication.bar).not.toContain(SERIES[2])
    expect(withoutApplication.bar).toContain(SERIES[2 - 1])
  })

  it('fills exactly the room it is given, and the track takes the rest', () => {
    for (const width of [40, 80, 120]) {
      const { bar } = contextBar(attribution, width, theme)
      const inside = /\[([^\]]*)\]/.exec(stripTerminalSequences(bar))![1]!
      expect(visibleWidth(inside)).toBe(width - 2)
      const filled = [...inside].filter((cell) => cell === '█').length
      expect(filled).toBe(Math.round((attribution.share! / 100) * (width - 2)))
      expect([...inside].filter((cell) => cell === '░').length + filled + [...inside].filter((cell) => cell === '│').length).toBe(width - 2)
    }
  })

  it('marks where compaction starts only when a reserve is known', () => {
    const marked = contextBar(attribution, 80, theme)
    expect(stripTerminalSequences(marked.bar)).toContain('│')
    expect(marked.legend.join(' ')).toContain('compaction at')
    const unknown = contextBar({ ...attribution, compaction: null, free: 1_000_000 - attribution.used }, 80, theme)
    expect(stripTerminalSequences(unknown.bar)).not.toContain('│')
    expect(unknown.legend.join(' ')).not.toContain('compaction at')
  })

  it('draws the whole width as the request when the window is unknown', () => {
    const { bar } = contextBar({ ...attribution, window: null, share: null, free: null, compaction: null }, 60, theme)
    const inside = stripTerminalSequences(bar)
    expect(inside).not.toContain('░')
    expect(inside).not.toContain('│')
  })

  it('splits cells without inventing or losing one', () => {
    const cells = allocateCells([29, 6_000, 2_400, 174_971], 14)
    expect(cells.reduce((sum, value) => sum + value, 0)).toBe(14)
    expect(cells.every((value) => value >= 1)).toBe(true)
    expect(allocateCells([1_000], 0)).toEqual([0])
    expect(allocateCells([5, 5], 1)).toEqual([1, 0])
    expect(allocateCells([0, 3], 2)).toEqual([0, 2])
  })
})
