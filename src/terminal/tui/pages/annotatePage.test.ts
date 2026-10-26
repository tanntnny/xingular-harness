import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { Note } from '../../../annotations/store'
import { parseAnnotate } from '../commands'
import { createHarnessTheme } from '../theme'
import { AnnotatePage, section, type AnnotateStart } from './annotatePage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

const note = (id: string, body: string, delivery: Note['delivery'] = undefined, status: Note['status'] = 'open'): Note => ({
  id, version: 1, body, tags: [], status, author: 'user', createdAt: '', updatedAt: '', grants: [], history: [],
  source: { url: 'http://localhost:5173/', title: 'Dev', capturedAt: '' },
  target: { kind: 'element', tag: 'button', role: 'button', name: 'Save', text: 'Save', context: '', selector: '#save' },
  ...(delivery !== undefined ? { delivery } : {})
})

function setup(start: AnnotateStart, notes: Note[], steps: Array<Record<string, unknown>> = []) {
  let inspecting = false
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'terminal.annotations.list') return { notes: structuredClone(notes), sessionId: 's1' }
    if (method === 'terminal.annotations.inspect') { inspecting = true; return { captureId: 'c' } }
    if (method === 'terminal.annotations.stopInspect') { inspecting = false; return {} }
    if (method === 'terminal.annotations.target') return { kind: start.kind, app: null, inspecting, windows: [{ id: 't1', url: 'http://localhost:5173/', title: 'Dev', current: true }] }
    if (method === 'terminal.annotations.next') return steps.shift() ?? { active: true, note: null, message: null }
    if (method === 'terminal.annotations.send') return { state: 'sent', ids: ['q1', 'q2'] }
    if (method === 'terminal.annotations.attach') return { bridge: { snippet: '<script src="http://127.0.0.1:1/page-notes.js?token=t"></script>' } }
    return {}
  }) as unknown as ConstructorParameters<typeof AnnotatePage>[0]['call']
  const ui = { select: vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined), confirm: vi.fn(async () => true), notify: vi.fn(), input: vi.fn(async () => undefined as string | undefined) }
  const page = new AnnotatePage({ theme: () => theme, call, ui, changed: vi.fn(), start, pollMs: 5 })
  page.focused = true
  return { page, calls, ui }
}

const text = (page: AnnotatePage) => page.render(120, 30).map(stripTerminalSequences).join('\n')

describe('/annotate:annotate arguments', () => {
  it('reads a page address, an app DevTools address, or the bridge', () => {
    expect(parseAnnotate('')).toEqual({ kind: 'web' })
    expect(parseAnnotate('localhost:5173')).toEqual({ kind: 'web', url: 'http://localhost:5173' })
    expect(parseAnnotate('example.com/page')).toEqual({ kind: 'web', url: 'https://example.com/page' })
    expect(parseAnnotate('--app 9229')).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229' })
    expect(parseAnnotate('--app http://127.0.0.1:9229 My App')).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229', name: 'My App' })
    expect(parseAnnotate('--bridge Desktop')).toEqual({ kind: 'bridge', name: 'Desktop' })
    expect(parseAnnotate('--app')).toContain('DevTools address')
    expect(parseAnnotate('a b')).toContain('/annotate:annotate')
  })
})

describe('the annotate pane', () => {
  it('sorts notes into the queue, what was sent or fixed, and what is saved', () => {
    expect(section(note('a', 'x', { state: 'queued', sessionId: 's1', queuedAt: '' }), 's1')).toBe('Queue')
    expect(section(note('a', 'x', { state: 'fixed', sessionId: 's1', queuedAt: '' }), 's1')).toBe('Sent and fixed')
    expect(section(note('a', 'x', { state: 'queued', sessionId: 'other', queuedAt: '' }), 's1')).toBeNull()
    expect(section(note('a', 'x'), 's1')).toBe('Saved')
    expect(section(note('a', 'x', undefined, 'resolved'), 's1')).toBeNull()
  })

  it('opens the page, turns the inspector on, shows each comment as it arrives, and lists the panel', async () => {
    const notes = [
      note('q1', 'Make it primary', { state: 'queued', sessionId: 's1', queuedAt: '1' }),
      note('q2', 'From the page', { state: 'queued', sessionId: 's1', queuedAt: '2', confirm: true }),
      note('f1', 'Bigger title', { state: 'fixed', sessionId: 's1', queuedAt: '0', summary: 'Raised to 24px' }),
      note('n1', 'Just a note')
    ]
    const { page, calls, ui } = setup({ kind: 'web', url: 'http://localhost:5173/' }, notes, [{ active: true, note: notes[0], message: 'Added to the agent\'s queue' }])
    page.activate()
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Added to the agent\'s queue', 'info'))
    expect(calls.map(([method]) => method)).toEqual(expect.arrayContaining(['terminal.annotations.open', 'terminal.annotations.inspect', 'terminal.annotations.next']))
    expect(calls.find(([method]) => method === 'terminal.annotations.open')![1]).toEqual({ url: 'http://localhost:5173/' })
    await vi.waitFor(() => expect(text(page)).toContain('Queue (2)'))
    const shown = text(page)
    expect(shown).toContain('Inspecting')
    expect(shown).toContain('confirm to send')
    expect(shown).toContain('fixed: Raised to 24px')
    expect(shown).toContain('Saved')
    expect(shown).toContain('Just a note')
    page.dispose()
  })

  it('sends the queue with s, confirming notes that came from the page first', async () => {
    const notes = [
      note('q1', 'Make it primary', { state: 'queued', sessionId: 's1', queuedAt: '1' }),
      note('q2', 'From the page', { state: 'queued', sessionId: 's1', queuedAt: '2', confirm: true })
    ]
    const { page, calls, ui } = setup({ kind: 'web', url: 'http://localhost:5173/' }, notes)
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Queue (2)'))
    page.handleInput('s')
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Sent 2 note(s) to the agent.', 'info'))
    expect(ui.confirm).toHaveBeenCalledWith('Send 2 note(s) to the agent?', expect.stringContaining('page'))
    const methods = calls.map(([method]) => method)
    expect(methods.indexOf('terminal.annotations.confirm')).toBeLessThan(methods.indexOf('terminal.annotations.send'))
    expect(calls.find(([method]) => method === 'terminal.annotations.confirm')![1]).toEqual({ id: 'q2', expectedVersion: 1 })
    page.handleInput('i')
    await vi.waitFor(() => expect(calls.map(([method]) => method)).toContain('terminal.annotations.stopInspect'))
    page.dispose()
  })

  it('attaches to an app over its DevTools port or shows the bridge script to load', async () => {
    const app = setup({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229' }, [])
    app.page.activate()
    await vi.waitFor(() => expect(app.calls.map(([method]) => method)).toContain('terminal.annotations.inspect'))
    expect(app.calls.find(([method]) => method === 'terminal.annotations.attach')![1]).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229' })
    app.page.dispose()

    const bridge = setup({ kind: 'bridge' }, [])
    bridge.page.activate()
    await vi.waitFor(() => expect(text(bridge.page)).toContain('page-notes.js'))
    bridge.page.dispose()
  })
})
