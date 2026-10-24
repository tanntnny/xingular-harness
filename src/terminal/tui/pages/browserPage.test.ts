import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserRuntime, BrowserSnapshot } from '../../browser'
import { createHarnessTheme } from '../theme'
import { PageOverlay } from '../pageOverlay'
import { BrowserPage, type BrowserPageOptions } from './browserPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
function setup(overrides: Partial<BrowserPageOptions> = {}) {
  const snapshot: BrowserSnapshot = { items: [
    { id: 'review', section: 'skills', name: 'Review', description: 'Inspect the diff.', owner: 'Project', origin: 'project', path: '/p/review/SKILL.md', status: 'Enabled for future sessions', read: true },
    { id: 'library', section: 'skills', name: 'Library skill', description: 'Reusable workflow.', owner: 'Library', origin: 'local', status: 'Library only', componentId: 'skills/local' }
  ], plugins: [], connections: [], variant: { scope: 'scope', pinned: 'old', latest: 'new', writable: true },
  hub: { entries: [{ id: 'example/community', title: 'Community review', description: 'From community', publisher: 'Someone', channel: 'community', category: 'skill', version: '1.0.0', license: 'MIT', tags: [], requires: {}, sourceUrl: 'https://example.com/source', delivery: { kind: 'registry', registryKind: 'skills', url: 'https://example.com/payload', sha256: 'a'.repeat(64) } }],
    installed: [], origin: 'bundled', error: null, refreshedAt: null, dataRoot: '/data', stateDir: '/state' } }
  const runtime: BrowserRuntime = { skills: [{ name: 'review', description: 'Inspect the diff.', filePath: '/p/review/SKILL.md' }], tools: [], activeTools: [], skillCommands: true }
  const call = vi.fn(async (method: string) => method === 'terminal.browser.snapshot' ? snapshot : method === 'terminal.browser.read' ? { content: 'FIRST\nSECOND' } : {})
  const ui = { select: vi.fn(), confirm: vi.fn(async () => true), input: vi.fn(), secretInput: vi.fn(), notify: vi.fn() }
  const useSkill = vi.fn()
  const page = new BrowserPage({ theme: () => theme, call: call as BrowserPageOptions['call'], runtime: () => runtime,
    permissions: async () => ({ full: false, globalTools: [] }), setGlobalTool: async () => {}, useSkill, ui, changed: vi.fn(), section: 'skills', ...overrides })
  page.activate()
  return { page, snapshot, runtime, call, ui, useSkill }
}
const plain = (page: BrowserPage, width = 80, rows = 24) => page.render(width, rows).map(stripTerminalSequences).join('\n')
async function ready(overrides: Partial<BrowserPageOptions> = {}) {
  const result = setup(overrides)
  await vi.waitFor(() => expect(plain(result.page)).toContain('Review'))
  return result
}

describe('unified Harness browser', () => {
  it('shows actual skills, inspects before acting and inserts an invocation only when Use is chosen', async () => {
    const { page, useSkill } = await ready()
    expect(plain(page)).toContain('Available now')
    page.handleInput('\r')
    expect(plain(page)).toContain('Use $review in draft')
    expect(useSkill).not.toHaveBeenCalled()
    page.handleInput('\r')
    await vi.waitFor(() => expect(useSkill).toHaveBeenCalledWith('review'))
  })

  it('keeps skills inspectable with shortcuts off', async () => {
    const { page, runtime, useSkill } = await ready()
    runtime.skillCommands = false
    page.handleInput('\r')
    expect(plain(page)).not.toContain('Use $review')
    page.handleInput('\r')
    await vi.waitFor(() => expect(plain(page)).toContain('FIRST'))
    expect(useSkill).not.toHaveBeenCalled()
  })

  it('preserves search across Installed / Discover and shows real community entries', async () => {
    const { page } = await ready()
    page.handleInput('review')
    page.handleInput('\t')
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    expect(plain(page)).toContain('Community review')
    expect(plain(page)).toContain('review')
    page.handleInput('\x1b[D')
    expect(plain(page)).toContain('Available now')
    expect(plain(page)).not.toContain('Library skill')
  })

  it('offers keyboard access to importing and cancels without mutation', async () => {
    const { page, call, ui } = await ready()
    ui.select.mockResolvedValueOnce('Import skill')
    ui.input.mockResolvedValueOnce(undefined)
    page.handleInput('\x1b[Z')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.input).toHaveBeenCalled())
    expect(call.mock.calls.some(([method]) => method === 'terminal.browser.importSkill')).toBe(false)
  })

  it.each([[24, 10], [56, 13], [92, 26]])('bounds its layout at %s columns and %s rows', async (width, rows) => {
    const { page } = await ready()
    const rendered = page.render(width, rows)
    expect(rendered.length).toBeLessThanOrEqual(rows)
    expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true)
    page.handleInput('\r')
    expect(page.render(width, rows).every(line => visibleWidth(line) <= width)).toBe(true)
    page.handleInput('\x1b')
    expect(page.activeTab()).toBe('skills')
    expect(plain(page, width, rows)).toContain('Available now')
  })

  it('does not label saved connections as live or start them during browsing', async () => {
    const { page, snapshot, call } = await ready()
    snapshot.items.push({ id: 'mcp', section: 'connections', name: 'Local server', description: 'Last checked yesterday', owner: 'Connected apps', origin: 'Local', status: 'Last check passed' })
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    page.handleInput('\x1b[C')
    expect(plain(page)).toContain('Local server')
    expect(plain(page)).not.toContain('Connected ✓')
    expect(call.mock.calls.every(([method]) => method === 'terminal.browser.snapshot')).toBe(true)
  })

  it('keeps inventory beside inspection and content on wide terminals and survives resizing', async () => {
    const { page } = await ready()
    expect(plain(page, 116, 36)).toContain('Read content')
    page.handleInput('\r')
    expect(plain(page, 116, 36)).toContain('Library skill')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(plain(page, 116, 36)).toContain('FIRST'))
    expect(plain(page, 116, 36)).toContain('Library skill')
    expect(plain(page, 36, 16)).toContain('FIRST')
    expect(plain(page, 36, 16)).not.toContain('Library skill')
    expect(plain(page, 116, 36)).toContain('FIRST')
    page.handleInput('\x1b')
    expect(plain(page, 116, 36)).toContain('Read content')
    page.handleInput('\x1b')
    expect(page.handleInput('\x1b')).toBe(false)
  })

  it('switches tabs directly from content and restores each section search and selection', async () => {
    const { page } = await ready()
    page.handleInput('library')
    page.selectTab('tools')
    expect(page.activeTab()).toBe('tools')
    page.selectTab('skills')
    expect(plain(page)).toContain('library')
    expect(plain(page)).toContain('Library skill')
    page.handleInput('\r')
    page.handleInput('\r')
    await vi.waitFor(() => expect(plain(page)).toContain('Owner: Library'))
    page.selectTab('foundation')
    expect(page.activeTab()).toBe('foundation')
    expect(plain(page)).not.toContain('Content ·')
    page.selectTab('skills')
    expect(plain(page)).toContain('library')
    page.selectTab('invalid')
    expect(page.activeTab()).toBe('skills')
  })

  it('changes focused tabs with arrows while Tab continues through controls', async () => {
    const { page } = await ready()
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    expect(page.activeTab()).toBe('plugins')
    page.handleInput('\x1b[D')
    expect(page.activeTab()).toBe('skills')
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    expect(page.activeTab()).toBe('skills')
    expect(plain(page)).toContain('[Discover]')
  })

  it('uses inspector mouse coordinates to read content without losing the inventory', async () => {
    const { page } = await ready()
    const lines = page.render(116, 36).map(stripTerminalSequences)
    const y = lines.findIndex(line => line.includes('Read content'))
    const x = lines[y]!.indexOf('Read content')
    page.handleMouse({ type: 'click', button: 'left', x, y, screenX: x, screenY: y, width: 116, height: 36, shift: false, alt: false, ctrl: false })
    await vi.waitFor(() => expect(plain(page, 116, 36)).toContain('FIRST'))
    expect(plain(page, 116, 36)).toContain('Library skill')
  })

  it('retains full-screen tabs through inspection, content, and compact resizing', async () => {
    const { page } = await ready()
    const terminal = { columns: 120, rows: 40 }
    const tui = { terminal, centeredDialogs: true } as unknown as TUI
    const overlay = new PageOverlay({ page, tui, theme: () => theme, close: vi.fn(), changed: vi.fn() })
    const render = () => overlay.render(terminal.columns).map(stripTerminalSequences)
    expect(render()).toHaveLength(40)
    expect(render()[0]).toContain('Foundation')
    page.handleInput('\r')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(render().join('\n')).toContain('FIRST'))
    expect(render()[0]).toContain('Skills')
    expect(render().join('\n')).toContain('Library skill')
    terminal.columns = 40
    terminal.rows = 20
    expect(render()).toHaveLength(20)
    expect(render()[0]).toContain('Skills 4/8')
    expect(render().at(-1)).toContain('Esc back/close')
    expect(render().join('\n')).toContain('FIRST')
    overlay.handleMouse({ type: 'click', button: 'left', x: 30, y: 0, screenX: 30, screenY: 0, width: 40, height: 20, shift: false, alt: false, ctrl: false })
    expect(page.activeTab()).toBe('plugins')
    expect(render().join('\n')).not.toContain('FIRST')
    overlay.dispose()
  })

  it('keeps tabs usable while the initial snapshot is pending', () => {
    const { page } = setup({ call: () => new Promise(() => {}) })
    page.handleInput('\t')
    page.handleInput('\x1b[C')
    expect(page.activeTab()).toBe('plugins')
    expect(plain(page)).toContain('Reading Harness resources')
    page.selectTab('foundation')
    expect(page.activeTab()).toBe('foundation')
    page.dispose()
  })

  it('saves a local MCP definition disabled with masked environment input and no test call', async () => {
    const { page, ui, call } = setup({ section: 'connections' })
    await vi.waitFor(() => expect(plain(page)).toContain('Add connection'))
    ui.select.mockResolvedValueOnce('Add connection').mockResolvedValueOnce('Local command (stdio)').mockResolvedValueOnce('Everywhere')
    ui.input.mockResolvedValueOnce('Local fixture').mockResolvedValueOnce('node').mockResolvedValueOnce('["server.mjs"]')
      .mockResolvedValueOnce('').mockResolvedValueOnce('ACCESS_KEY')
    ui.secretInput.mockResolvedValueOnce('private-value')
    page.handleInput('\x1b[Z')
    page.handleInput('\r')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.browser.connections.save', {
      input: expect.objectContaining({ name: 'Local fixture', kind: 'local', enabled: false, command: 'node', args: ['server.mjs'], global: true, env: { ACCESS_KEY: 'private-value' } })
    }))
    expect(ui.secretInput).toHaveBeenCalledWith('Value for ACCESS_KEY')
    expect(call.mock.calls.some(([method]) => method === 'terminal.browser.connections.test')).toBe(false)
  })

  it('cancels local MCP setup when the transport selection is dismissed', async () => {
    const { page, ui, call } = setup({ section: 'connections' })
    await vi.waitFor(() => expect(plain(page)).toContain('Add connection'))
    ui.select.mockResolvedValueOnce('Add connection').mockResolvedValueOnce(undefined)
    page.handleInput('\x1b[Z')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledTimes(2))
    expect(ui.input).not.toHaveBeenCalled()
    expect(call.mock.calls.some(([method]) => method === 'terminal.browser.connections.save')).toBe(false)
  })

  it('does not detach a plugin when Back is selected in its management menu', async () => {
    const { page, snapshot, ui, call } = setup({ section: 'plugins' })
    snapshot.plugins.push({ id: 'example', title: 'Example plugin', description: '', source: 'package', version: '1.0.0', path: '/example', runsCode: false,
      trust: 'none', code: null, install: null, extends: [], required: null, manage: 'files', settings: [], connectorTemplates: [], contributions: [],
      attachment: { global: true, on: { agentIds: [], projectIds: [] }, off: { agentIds: [], projectIds: [] } } })
    snapshot.items.push({ id: 'plugin:example', section: 'plugins', name: 'Example plugin', description: '', owner: 'Example plugin', origin: 'package', status: 'Saved configuration', pluginId: 'example' })
    await vi.waitFor(() => expect(plain(page)).toContain('Example plugin'))
    ui.select.mockResolvedValueOnce('Back')
    page.handleInput('\r')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledWith('Example plugin', ['Switch off everywhere', 'Back']))
    expect(call.mock.calls.some(([method]) => ['plugins.attach', 'plugins.detach', 'plugins.trust'].includes(method))).toBe(false)
  })
})
