import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalSubagentActivity } from '../../subagentMonitor'
import { createHarnessTheme } from '../theme'
import { SubagentsPage } from './subagentsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function fixture(overrides: Partial<TerminalSubagentActivity> = {}): TerminalSubagentActivity {
  return {
    id: 'child', parentRunId: 'parent', relation: 'subagent', goal: 'Inspect auth flow', status: 'running',
    startedAt: '2026-10-23T00:00:00.000Z', endedAt: null, activity: 'read', ...overrides
  }
}

function plain(page: SubagentsPage, rows = 24): string {
  return page.render(100, rows).map(stripTerminalSequences).join('\n')
}

describe('SubagentsPage', () => {
  it('shows a flat roster and selected task/activity details without event payloads', () => {
    const snapshot = vi.fn(() => [
      fixture(),
      fixture({ id: 'nested', parentRunId: 'child', goal: 'Check tokens', status: 'completed', endedAt: '2026-10-23T00:00:03.000Z', activity: 'Completed' })
    ])
    const page = new SubagentsPage({ theme: () => theme, snapshot, changed: vi.fn() })
    const output = plain(page)

    expect(output).toContain('Inspect auth flow')
    expect(output).toContain('Check tokens')
    expect(output).toContain('Task')
    expect(output).toContain('Current activity')
    expect(output).toContain('read')
    expect(output).not.toContain('raw tool arguments')
  })

  it('renders an empty state when this parent has no children', () => {
    const page = new SubagentsPage({ theme: () => theme, snapshot: () => [], changed: vi.fn() })
    expect(plain(page)).toContain('No subagents have started in this turn')
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
