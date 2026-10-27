import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { Note } from '../../../annotations/store'
import { parseAnnotate } from '../commands'
import { createHarnessTheme } from '../theme'
import { ANNOTATE_ACTIONS, AnnotatePage, section, type AnnotateStart, type AnnotateTab } from './annotatePage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

const note = (id: string, body: string, delivery: Note['delivery'] = undefined, status: Note['status'] = 'open', extra: Partial<Note> = {}): Note => ({
  id, version: 1, body, tags: [], status, author: 'user', createdAt: '', updatedAt: '', grants: [], history: [],
  source: { url: 'http://localhost:5173/', title: 'Dev', capturedAt: '' },
  target: { kind: 'element', tag: 'button', role: 'button', name: 'Save', text: 'Save', context: '', selector: '#save' },
  ...(delivery !== undefined ? { delivery } : {}),
  ...extra
})

const pending = (queuedAt: string, extra: Partial<NonNullable<Note['delivery']>> = {}): NonNullable<Note['delivery']> => ({ state: 'pending', sessionId: 's1', queuedAt, ...extra })

const BRIDGE_SNIPPET = '<script src="http://127.0.0.1:1/page-notes.js?token=t"></script>'

function setup(start: AnnotateStart, notes: Note[], options: { steps?: Array<Record<string, unknown>>; initialTab?: AnnotateTab; select?: string[]; live?: boolean; target?: { kind: 'web' | 'cdp' | 'bridge'; name?: string } } = {}) {
  let inspecting = false
  const steps = [...(options.steps ?? [])]
  const selects = [...(options.select ?? [])]
  const calls: Array<[string, unknown]> = []
  let target: { kind: string; name?: string } = options.target ?? { kind: start.kind === 'apps' ? 'web' : start.kind }
  let opened = options.live === true || start.kind !== 'web' || !!start.url
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'terminal.annotations.list') return { notes: structuredClone(notes), sessionId: 's1' }
    if (method === 'terminal.annotations.open') { opened = true; target = { kind: 'web' }; return {} }
    if (method === 'terminal.annotations.inspect') { inspecting = true; return { captureId: 'c' } }
    if (method === 'terminal.annotations.stopInspect') { inspecting = false; return {} }
    if (method === 'terminal.annotations.target') return { kind: target.kind, app: target.name ? { kind: target.kind, name: target.name } : null, inspecting, ...(target.kind === 'bridge' ? { bridge: { snippet: BRIDGE_SNIPPET } } : {}), windows: opened ? [{ id: 't1', url: 'http://localhost:5173/', title: 'Dev', current: true }] : [] }
    if (method === 'terminal.annotations.next') return steps.shift() ?? { active: true, note: null, message: null }
    if (method === 'terminal.annotations.send') return { state: 'sent', ids: ['q1', 'q2'] }
    if (method === 'terminal.annotations.discover') return { apps: [{ endpoint: 'http://127.0.0.1:9222', port: 9222, name: 'Slack', browser: 'Electron/31.0.0', electron: true, windows: 2 }] }
    if (method === 'terminal.annotations.attach') {
      opened = true
      target = { kind: String(params?.kind), name: typeof params?.name === 'string' ? params.name : 'App' }
      return params?.kind === 'bridge' ? { bridge: { snippet: BRIDGE_SNIPPET } } : {}
    }
    if (method === 'terminal.annotations.launch') { opened = true; target = { kind: 'cdp', name: 'MyApp' }; return { app: { kind: 'cdp', name: 'MyApp' } } }
    if (method === 'terminal.annotations.reveal') return { state: 'matched' }
    return {}
  }) as unknown as ConstructorParameters<typeof AnnotatePage>[0]['call']
  const ui = {
    select: vi.fn(async (_title: string, _options: string[]) => selects.shift()),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    input: vi.fn(async () => undefined as string | undefined)
  }
  const page = new AnnotatePage({ theme: () => theme, call, ui, changed: vi.fn(), start, pollMs: 5, ...(options.initialTab ? { initialTab: options.initialTab } : {}) })
  page.focused = true
  return { page, calls, ui, methods: () => calls.map(([method]) => method) }
}

const text = (page: AnnotatePage) => page.render(140, 30).map(stripTerminalSequences).join('\n')
const type = (page: AnnotatePage, value: string) => { for (const char of value) page.handleInput(char) }

describe('/annotate: arguments', () => {
  it('reads a page address, an app DevTools port, or the bridge', () => {
    expect(parseAnnotate('')).toEqual({ kind: 'web' })
    expect(parseAnnotate('localhost:5173')).toEqual({ kind: 'web', url: 'http://localhost:5173' })
    expect(parseAnnotate('example.com/page')).toEqual({ kind: 'web', url: 'https://example.com/page' })
    expect(parseAnnotate('--app')).toEqual({ kind: 'apps' })
    expect(parseAnnotate('--app 9229')).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229' })
    expect(parseAnnotate('--app localhost:9222')).toEqual({ kind: 'cdp', endpoint: 'http://localhost:9222' })
    expect(parseAnnotate('--app http://127.0.0.1:9229 My App')).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9229', name: 'My App' })
    expect(parseAnnotate('--bridge Desktop')).toEqual({ kind: 'bridge', name: 'Desktop' })
    expect(parseAnnotate('a b')).toContain('/annotate: [url]')
  })
})

describe('the annotate page', () => {
  it('puts this session\'s annotations under Unsent and Sent', () => {
    expect(section(note('a', 'x', pending('')), 's1')).toBe('Unsent')
    expect(section(note('a', 'x', { state: 'sent', sessionId: 's1', queuedAt: '' }), 's1')).toBe('Sent')
    expect(section(note('a', 'x', { ...pending(''), sessionId: 'other' }), 's1')).toBeNull()
    expect(section(note('a', 'x'), 's1')).toBeNull()
    expect(section(note('a', 'x', pending(''), 'resolved'), 's1')).toBeNull()
  })

  it('has one page with an Annotate tab and an All annotations tab', async () => {
    const { page } = setup({ kind: 'web', url: 'http://localhost:5173/' }, [note('n1', 'Old one', undefined, 'resolved')])
    expect(page.presentation).toBe('fullscreen')
    expect(page.tabs()).toEqual([{ id: 'annotate', title: 'Annotate' }, { id: 'all', title: 'All annotations' }])
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Inspecting'))
    page.handleInput('\t')
    expect(page.activeTab()).toBe('all')
    expect(text(page)).toContain('Old one')
    expect(text(page)).toContain('resolved')
    page.handleInput('\t')
    expect(page.activeTab()).toBe('annotate')
    page.dispose()
  })

  it('asks for the page address in the page itself, not in a dialog', async () => {
    const { page, calls, ui } = setup({ kind: 'web' }, [])
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Page address'))
    expect(ui.input).not.toHaveBeenCalled()
    type(page, 'localhost:5173')
    page.handleInput('\r')
    await vi.waitFor(() => expect(text(page)).toContain('Inspecting'))
    expect(calls.find(([method]) => method === 'terminal.annotations.open')![1]).toEqual({ url: 'http://localhost:5173' })
    page.dispose()
  })

  it('reopens on the window that is still open, with the inspector on, instead of asking for an address', async () => {
    const { page, methods } = setup({ kind: 'web' }, [], { live: true })
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Inspecting'))
    const shown = text(page)
    expect(shown).toContain('http://localhost:5173/')
    expect(shown).not.toContain('Page address')
    expect(methods()).toContain('terminal.annotations.inspect')
    expect(methods()).not.toContain('terminal.annotations.open')
    page.dispose()
  })

  it('reopens an app attached over its DevTools port', async () => {
    const { page, methods } = setup({ kind: 'web' }, [], { live: true, target: { kind: 'cdp', name: 'Slack' } })
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('App · Slack (DevTools)'))
    expect(text(page)).toContain('Inspecting')
    expect(methods()).toContain('terminal.annotations.inspect')
    page.dispose()
  })

  it('reopens the bridge and shows its script again while no window is connected', async () => {
    const { page, methods } = setup({ kind: 'web' }, [], { target: { kind: 'bridge', name: 'Desktop' } })
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('page-notes.js'))
    expect(text(page)).toContain('App · Desktop (page bridge)')
    expect(methods()).not.toContain('terminal.annotations.inspect')
    page.dispose()
  })

  it('shows each comment as it arrives and lists unsent and sent annotations', async () => {
    const notes = [
      note('q1', 'Make it primary', pending('1')),
      note('q2', 'From the page', pending('2', { confirm: true })),
      note('s1', 'Bigger title', { state: 'sent', sessionId: 's1', queuedAt: '0' }),
      note('n1', 'Someone else', { ...pending('3'), sessionId: 'other' })
    ]
    const { page, methods, ui } = setup({ kind: 'web', url: 'http://localhost:5173/' }, notes, { steps: [{ active: true, note: notes[0], message: 'Annotated — the agent can read it' }] })
    page.activate()
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Annotated — the agent can read it', 'info'))
    expect(methods()).toEqual(expect.arrayContaining(['terminal.annotations.open', 'terminal.annotations.inspect', 'terminal.annotations.next']))
    const shown = text(page)
    expect(shown).toContain('Unsent (2)')
    expect(shown).toContain('confirm before sending')
    expect(shown).toContain('Sent')
    expect(shown).not.toContain('Someone else')
    expect(shown).not.toContain('Queue')
    page.dispose()
  })

  it('sends every unsent annotation with s, confirming page-origin ones once', async () => {
    const notes = [note('q1', 'Make it primary', pending('1')), note('q2', 'From the page', pending('2', { confirm: true }))]
    const { page, methods, ui } = setup({ kind: 'web', url: 'http://localhost:5173/' }, notes)
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Unsent (2)'))
    page.handleInput('s')
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Sent 2 annotations to the agent.', 'info'))
    expect(ui.confirm).toHaveBeenCalledWith('Send 2 annotations to the agent?', expect.stringContaining('page scripts'))
    expect(methods().indexOf('terminal.annotations.confirmAll')).toBeLessThan(methods().indexOf('terminal.annotations.send'))
    page.dispose()
  })

  it('answers a key pressed while it is still busy instead of dropping it', async () => {
    const { page, ui } = setup({ kind: 'web', url: 'http://localhost:5173/' }, [])
    page.activate()
    page.handleInput('s')
    page.handleInput('s')
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Still working on the last step. Try again in a moment.', 'info'))
    page.dispose()
  })

  it('lists apps with a DevTools port and attaches to the one chosen', async () => {
    const { page, calls } = setup({ kind: 'apps' }, [])
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Slack'))
    const shown = text(page)
    expect(shown).toContain('Electron/31.0.0 · port 9222 · 2 windows')
    expect(shown).toContain('Start an app with a DevTools port')
    expect(shown).toContain('Type a DevTools port')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.map(([method]) => method)).toContain('terminal.annotations.inspect'))
    expect(calls.find(([method]) => method === 'terminal.annotations.attach')![1]).toEqual({ kind: 'cdp', endpoint: 'http://127.0.0.1:9222', name: 'Slack' })
    await vi.waitFor(() => expect(text(page)).toContain('App · Slack (DevTools)'))
    page.dispose()
  })

  it('takes a DevTools port or an app to start in the page', async () => {
    const port = setup({ kind: 'web', url: 'http://localhost:5173/' }, [])
    port.page.activate()
    await vi.waitFor(() => expect(text(port.page)).toContain('Inspecting'))
    port.page.handleInput('a')
    await vi.waitFor(() => expect(text(port.page)).toContain('Slack'))
    port.page.handleInput('\x1b[B')
    port.page.handleInput('\x1b[B')
    port.page.handleInput('\r')
    expect(text(port.page)).toContain('DevTools port')
    type(port.page, '9333')
    port.page.handleInput('\r')
    await vi.waitFor(() => expect(port.calls.find(([method, params]) => method === 'terminal.annotations.attach' && (params as { endpoint?: string }).endpoint === 'http://127.0.0.1:9333')).toBeTruthy())
    port.page.dispose()

    const launch = setup({ kind: 'apps' }, [])
    launch.page.activate()
    await vi.waitFor(() => expect(text(launch.page)).toContain('Slack'))
    launch.page.handleInput('\x1b[B')
    launch.page.handleInput('\r')
    expect(text(launch.page)).toContain('App to start')
    type(launch.page, '/Applications/MyApp.app')
    launch.page.handleInput('\r')
    await vi.waitFor(() => expect(launch.ui.notify).toHaveBeenCalledWith('Started MyApp and attached to its windows.', 'info'))
    expect(launch.calls.find(([method]) => method === 'terminal.annotations.launch')![1]).toEqual({ path: '/Applications/MyApp.app' })
    launch.page.dispose()
  })

  it('shows the bridge script to load', async () => {
    const bridge = setup({ kind: 'bridge' }, [])
    bridge.page.activate()
    await vi.waitFor(() => expect(text(bridge.page)).toContain('page-notes.js'))
    bridge.page.dispose()
  })

  it('reopens and shares an annotation from the All annotations tab', async () => {
    const { page, calls } = setup({ kind: 'web' }, [note('n1', 'Old one', undefined, 'resolved')], { initialTab: 'all', select: [ANNOTATE_ACTIONS.reopen] })
    page.activate()
    await vi.waitFor(() => expect(text(page)).toContain('Old one'))
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.find(([method]) => method === 'terminal.annotations.update')).toBeTruthy())
    expect(calls.find(([method]) => method === 'terminal.annotations.update')![1]).toEqual({ id: 'n1', expectedVersion: 1, patch: { status: 'open' } })
    page.dispose()
  })
})
