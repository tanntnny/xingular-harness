import type { Theme } from '@earendil-works/pi-coding-agent'
import { parseColor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalSubagentActivity } from '../../subagentMonitor'
import { createHarnessTheme } from '../theme'
import { profileColor, opentuiTheme } from '../../opentui/theme'
import { SubagentsPage } from './subagentsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function fixture(overrides: Partial<TerminalSubagentActivity> = {}): TerminalSubagentActivity {
  return {
    id: 'child', parentRunId: 'parent', relation: 'subagent', goal: 'Inspect auth flow', status: 'running',
    startedAt: '2026-10-23T00:00:00.000Z', endedAt: null, activity: 'read', title: 'Inspect auth flow', checklist: null,
    accountLabel: 'Main', model: 'openai/gpt-5', effort: 'low', usage: null, ...overrides
  }
}

function plain(page: SubagentsPage, rows = 24): string {
  return page.render(100, rows).map(stripTerminalSequences).join('\n')
}

describe('SubagentsPage', () => {
  it('shows a flat roster and selected task/activity details without event payloads', () => {
    const snapshot = vi.fn(() => [
      fixture(),
      fixture({ id: 'nested', parentRunId: 'child', title: 'Check tokens', goal: 'Check tokens', status: 'completed', endedAt: '2026-10-23T00:00:03.000Z', activity: 'Completed' })
    ])
    const page = new SubagentsPage({ theme: () => theme, snapshot, changed: vi.fn() })
    const output = plain(page)

    expect(output).toContain('Inspect auth flow')
    expect(output).toContain('Check tokens')
    expect(output).toContain('Task')
    expect(output).toContain('Current activity')
    expect(output).toContain('read')
    const lines = output.split('\n')
    const taskHeading = lines.findIndex(line => line.includes('Task'))
    const activityHeading = lines.findIndex(line => line.includes('Current activity'))
    expect(lines[taskHeading]).toBe('  Task')
    expect(lines[taskHeading + 1]).toBe('    Inspect auth flow')
    expect(lines[activityHeading]).toBe('  Current activity')
    expect(lines[activityHeading + 1]).toBe('    read')
    expect(output).not.toContain('raw tool arguments')
  })

  it('shows an animated status glyph, a normal-color title, and runtime details', () => {
    const page = new SubagentsPage({
      theme: () => theme,
      snapshot: () => [fixture({ profile: { name: 'explorer', color: 'cyan' }, title: 'Map the auth flow', checklist: { done: 2, total: 5 }, usage: {
        provider: 'openai', model: 'gpt-5', inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 500, costUsd: 0.004, costSource: 'estimate'
      } })],
      changed: vi.fn()
    })
    const output = plain(page)
    expect(output).toContain('explorer  Map the auth flow')
    const lines = output.split('\n')
    const titleIndex = lines.findIndex(line => line.includes('explorer  Map the auth flow'))
    const subtitle = lines[titleIndex + 1] ?? ''
    expect(subtitle).not.toContain('Task:')
    expect(subtitle).not.toContain('Inspect auth flow')
    expect(subtitle).toContain('acct Main')
    expect(output).toContain('model openai/gpt-5')
    expect(output).toContain('eff low')
    expect(output).toContain('↑1K')
    expect(output).toContain('↓300')
    expect(output).toContain('c500')
    expect(output).toContain('~$0.004')
    expect(output).toContain('2 of 5 tasks')
    expect(output).toContain('Profile: explorer')
  })

  it('animates the running mark and colors each profile label with its configured color', () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z')
    const page = new SubagentsPage({
      theme: () => theme,
      snapshot: () => [
        fixture({ profile: { name: 'explorer', color: 'cyan' }, title: 'Animated title' }),
        fixture({ id: 'done', status: 'completed', profile: { name: 'explorer', color: 'cyan' }, title: 'Completed title', endedAt: '2026-10-23T00:00:01.000Z' })
      ],
      changed: vi.fn(), now: () => now
    })
    const line = () => plain(page).split('\n').find(value => value.includes('Animated title'))!
    expect(line()).toContain('❯ · explorer  Animated title')
    now += 80
    expect(line()).toContain('❯ ✢ explorer  Animated title')

    const colored = theme.style('explorer', { fg: parseColor(profileColor(opentuiTheme, 'cyan')) })
    expect(page.render(100, 24).join('\n')).toContain(colored)
  })

  it('keeps the title visible and each rendered line within narrow, standard, and wide layouts', () => {
    const page = new SubagentsPage({
      theme: () => theme,
      snapshot: () => [fixture({
        profile: { name: 'worker', color: 'green' }, title: 'Map the auth flow', goal: 'Trace the login route and inspect token handling',
        usage: { provider: 'openai', model: 'gpt-5', inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 500, costUsd: 0.004 }
      })],
      changed: vi.fn()
    })

    for (const [width, height] of [[40, 20], [80, 24], [120, 40]]) {
      const rendered = page.render(width, height)
      expect(rendered.every(line => visibleWidth(line) <= width), `${width}×${height}`).toBe(true)
      expect(rendered.some(line => stripTerminalSequences(line).includes('Map the auth flow')), `${width}×${height}`).toBe(true)
      if (width >= 80) {
        const lines = rendered.map(stripTerminalSequences)
        const titleIndex = lines.findIndex(line => line.includes('Map the auth flow'))
        const subtitle = lines[titleIndex + 1] ?? ''
        expect(subtitle).not.toContain('Trace the login route')
        expect(subtitle).toContain('↑1K')
        expect(subtitle).toContain('↓300')
        expect(subtitle).toContain('c500')
      }
    }
  })

  it('separates each two-line subagent entry with one blank row', () => {
    const page = new SubagentsPage({
      theme: () => theme,
      snapshot: () => [fixture(), fixture({ id: 'next', title: 'Check tokens', goal: 'Inspect token flow', status: 'completed' })],
      changed: vi.fn()
    })
    const lines = page.render(100, 30).map(stripTerminalSequences)
    const firstTitle = lines.findIndex(line => line.includes('Inspect auth flow'))

    expect(lines[firstTitle + 1]).not.toContain('Task:')
    expect(lines[firstTitle + 1]).toContain('acct Main')
    expect(lines[firstTitle + 2]).toBe('')
    expect(lines[firstTitle + 3]).toContain('Check tokens')
  })

  it('renders an empty state when the latest parent has no children', () => {
    const page = new SubagentsPage({ theme: () => theme, snapshot: () => [], changed: vi.fn() })
    expect(plain(page)).toContain('No subagents have started in the latest run')
  })

  it('refreshes selection details as the snapshot changes', () => {
    let current = fixture()
    const changed = vi.fn()
    const page = new SubagentsPage({ theme: () => theme, snapshot: () => [current], changed })
    page.handleInput('\x1b[B')
    current = fixture({ activity: 'Waiting for approval', status: 'waiting_for_approval' })

    expect(plain(page)).toContain('Waiting for approval')
    expect(changed).toHaveBeenCalled()
  })
})
