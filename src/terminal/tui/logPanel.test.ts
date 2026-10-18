import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../../sessions/contracts'
import type { TerminalTrajectorySnapshot } from '../trajectory'
import { formatRunEventLog, LogPanel } from './logPanel'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const event = (sequence: number, type: string, payload: unknown): RunEvent => ({
  id: `event-${sequence}`, runId: 'run-1', sessionId: 'terminal-1', sequence,
  timestamp: `2026-10-18T00:00:0${sequence}.000Z`, type: type as RunEvent['type'], payload
})

function plain(panel: LogPanel): string {
  return panel.render(80).map(stripTerminalSequences).join('\n')
}

describe('terminal log viewer', () => {
  it('shows diagnostic run events without prompt or successful response content', () => {
    const snapshot: TerminalTrajectorySnapshot = {
      run: { id: 'run-1', mode: 'code', goal: 'Private prompt', startedAt: '2026-10-18T00:00:00.000Z', endedAt: '2026-10-18T00:00:02.000Z', status: 'failed' },
      events: [
        event(0, 'context.snapshot', { systemPrompt: 'Private prompt' }),
        event(1, 'tool.completed', { name: 'web_fetch', ok: true, output: JSON.stringify({ url: 'https://example.com/?token=private', status: 404, error: 'Page missing', text: 'Private response body' }) }),
        event(2, 'failed', { code: 'network', message: 'Failed at https://example.com/path?token=private' })
      ]
    }
    const text = formatRunEventLog([snapshot])
    expect(text).toContain('HTTP 404: Page missing')
    expect(text).toContain('network')
    expect(text).not.toContain('Private prompt')
    expect(text).not.toContain('Private response body')
    expect(text).not.toContain('private')
  })

  it('opens at the newest lines, pages through the snapshot, switches sources, and closes on Escape', () => {
    const close = vi.fn()
    const changed = vi.fn()
    const panel = new LogPanel({
      tui: { terminal: { rows: 8 } } as unknown as TUI,
      theme,
      sections: [
        { title: 'Harness diagnostics', text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') },
        { title: 'Conversation run events', text: 'run event' }
      ],
      close, changed
    })

    expect(plain(panel)).toContain('line 20')
    panel.handleInput('\x1b[5~')
    expect(plain(panel)).toContain('line 11')
    expect(plain(panel)).not.toContain('line 20')
    panel.handleInput('\t')
    expect(plain(panel)).toContain('Conversation run events')
    panel.handleInput('\x1b')
    expect(close).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalled()
  })
})
