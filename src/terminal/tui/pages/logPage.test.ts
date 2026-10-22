import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../../../sessions/contracts'
import type { TerminalTrajectorySnapshot } from '../../trajectory'
import { createHarnessTheme } from '../theme'
import { formatRunEventLog, LogPage, type LogSection } from './logPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const event = (sequence: number, type: string, payload: unknown): RunEvent => ({
  id: `event-${sequence}`, runId: 'run-1', sessionId: 'terminal-1', sequence,
  timestamp: `2026-10-18T00:00:0${sequence}.000Z`, type: type as RunEvent['type'], payload
})

function setup(sections: LogSection[] = [
  { title: 'Harness diagnostics', text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') },
  { title: 'Conversation run events', text: 'run event' }
]) {
  const changed = vi.fn()
  const page = new LogPage({ theme: () => theme, load: async () => sections, changed })
  return { page, changed }
}
const plain = (page: LogPage, rows = 12, width = 80) => page.render(width, rows).map(stripTerminalSequences).join('\n')

describe('the Log page', () => {
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

  it('reads its sources when first shown, says so meanwhile, and asks for a redraw when they arrive', async () => {
    const { page, changed } = setup()
    expect(plain(page)).toContain('Reading logs…')
    page.activate()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(page.tabs().map(tab => tab.title)).toEqual(['Harness diagnostics', 'Conversation run events'])
    page.activate()
    expect(plain(page)).toContain('line 20')
  })

  it('reports a source that cannot be read', async () => {
    const changed = vi.fn()
    const page = new LogPage({ theme: () => theme, load: async () => { throw new Error('no log file') }, changed })
    page.activate()
    await vi.waitFor(() => expect(plain(page)).toContain('Could not read logs: no log file'))
  })

  it('opens at the newest lines, pages through them, and switches sources with Tab, Shift+Tab and brackets', async () => {
    const { page, changed } = setup()
    page.activate()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(plain(page)).toContain('line 20')
    expect(page.activeTab()).toBe('0')
    expect(page.handleInput('\x1b[5~')).toBe(true)
    expect(plain(page)).not.toContain('line 20')
    page.handleInput('\t')
    expect(plain(page)).toContain('run event')
    page.handleInput('\x1b[Z')
    expect(plain(page)).toContain('line 20')
    expect(page.handleInput(']')).toBe(false)
    page.handleInput('\t')
    expect(plain(page)).toContain('run event')
    page.handleInput('\x1b[Z')
    page.handleInput('\x1b[H')
    expect(plain(page)).toContain('line 1')
    expect(plain(page)).not.toContain('line 20')
  })

  it('leaves Escape and left/right navigation to the overlay, and never overflows', async () => {
    const { page, changed } = setup()
    page.activate()
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    for (const key of ['\x1b', '\x1b[D', '\x1b[C']) expect(page.handleInput(key)).toBe(false)
    for (const rows of [0, 1, 3, 8, 30]) for (let width = 0; width <= 100; width++) {
      const lines = page.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })
})
