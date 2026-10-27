import type { Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { HubOverview } from '../../../hub/schema'
import type { Plugin } from '../../../plugins/types'
import { PageOverlay } from '../pageOverlay'
import { createHarnessTheme } from '../theme'
import { PluginsPage } from './pluginsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const attachment = (global: boolean) => ({ global, on: { agentIds: [], projectIds: [] }, off: { agentIds: [], projectIds: [] } })
const notes = {
  id: 'notes', title: 'Notes', description: 'Keeps short notes for the session.', trust: 'untrusted', runsCode: true,
  code: { files: ['index.js'], hash: 'abcdef0123456789abcdef' }, attachment: null,
  contributions: [{ id: 'notes/skill/summarize', kind: 'skill', name: 'summarize', state: 'on', attachment: attachment(true) }]
} as unknown as Plugin
const web = {
  id: 'web', title: 'Web', description: 'Searches the web.', trust: 'none', runsCode: false, code: null,
  attachment: attachment(true), contributions: [],
  settings: [
    { key: 'keylessSearch', label: 'Search without a key', description: 'Reads a public results page when no key is saved.', default: 0, min: 0, max: 1, value: 0 },
    { key: 'maxCalls', label: 'Most searches', description: 'Searches in one reply.', default: 20, min: 1, max: 200, value: 20 }
  ]
} as unknown as Plugin

const emptyHub = () => ({ entries: [], installed: [], origin: 'bundled', refreshedAt: null, error: null, dataRoot: null, stateDir: '/tmp' }) as unknown as HubOverview
const packagePlugin = {
  id: 'package:review-kit', title: 'Review Kit', description: 'Review helpers.', source: 'package', version: '1.0.0', trust: 'trusted', runsCode: true,
  code: { files: ['index.js'], hash: 'abcdef0123456789abcdef' }, attachment: null, contributions: [], install: { kind: 'settings', source: 'npm:review-kit@1.0.0' }
} as unknown as Plugin

function setup(plugins: Plugin[] = [notes], projectId: string | null = null, hub = emptyHub()) {
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'plugins.session') return { projectId }
    if (method === 'plugins.list') return structuredClone(plugins)
    if (method === 'plugins.proposals.list') return []
    if (method === 'hub.list') return structuredClone(hub)
    if (method === 'plugins.install' || method === 'plugins.update' || method === 'plugins.remove') return structuredClone(plugins)
    if (method === 'plugins.configure') {
      const { pluginId, settings } = params as { pluginId: string; settings: Record<string, number> }
      for (const setting of plugins.find(plugin => plugin.id === pluginId)!.settings) if (setting.key in settings) setting.value = settings[setting.key]!
      return structuredClone(plugins)
    }
    return undefined
  }) as unknown as ConstructorParameters<typeof PluginsPage>[0]['call']
  const ui = { select: vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined), confirm: vi.fn(async () => true), notify: vi.fn(), input: vi.fn(async (_title: string, _placeholder?: string) => undefined as string | undefined) }
  const page = new PluginsPage({ theme: () => theme, call, ui, changed: vi.fn() })
  page.focused = true
  return { page, calls, ui }
}
const plain = (page: PluginsPage, rows = 24, width = 80) => page.render(width, rows).map(stripTerminalSequences)
async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args)
  made.page.activate()
  await vi.waitFor(() => expect(plain(made.page).some(row => row.includes('Type to search'))).toBe(true))
  return made
}

describe('the Plugins page', () => {
  it('previews proposal contents and submits only the preview hash after confirmation', async () => {
    const proposal = { id: 'p1', name: 'review-kit', description: 'Review me', status: 'pending', hash: 'a'.repeat(64), manifest: '{"name":"review-kit"}', files: { 'README.md': 'inspect this content\n\x1b[31mvisible' }, createdAt: 'now' }
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'plugins.session') return { projectId: null }
      if (method === 'plugins.list') return []
      if (method === 'plugins.proposals.list') return [proposal]
      if (method === 'plugins.proposals.preview') return proposal
      if (method === 'hub.list') return emptyHub()
      return undefined
    }) as unknown as ConstructorParameters<typeof PluginsPage>[0]['call']
    const ui = { select: vi.fn(async () => 'Accept proposal'), confirm: vi.fn(async () => true), notify: vi.fn(), input: vi.fn(async () => undefined) }
    const page = new PluginsPage({ theme: () => theme, call, ui, changed: vi.fn() })
    page.focused = true
    page.activate()
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'plugins.proposals.list')).toBe(true))
    page.handleInput('\t'); page.handleInput('\t'); page.handleInput('\t')
    page.handleInput('\r')
    await vi.waitFor(() => expect(plain(page).join('\n')).toContain('inspect this content'))
    expect(plain(page).join('\n')).toContain(proposal.hash)
    expect(plain(page).join('\n')).toContain('\\u001b[31mvisible')
    ui.confirm.mockResolvedValueOnce(false)
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    expect(calls.some(([method]) => method === 'plugins.proposals.accept')).toBe(false)
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls).toContainEqual(['plugins.proposals.accept', { id: proposal.id, hash: proposal.hash }]))
  })
  it('lists each plugin and its parts under the plugin, with on or off and trust at the right', async () => {
    const { page } = await ready()
    const rows = plain(page)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Plugins', 'Trust', 'Packages', 'Proposals'])
    expect(rows.some(row => row.includes('1 item'))).toBe(true)
    expect(rows).toContain('Notes')
    expect(rows.some(row => row.startsWith('❯ summarize') && row.endsWith('on · skill'))).toBe(true)
    expect(rows.join('\n')).toContain('Keeps short notes for the session.')
    page.handleInput('\t')
    const trust = plain(page)
    expect(trust.some(row => row.startsWith('❯ Whole plugin') && row.endsWith('off · code not trusted'))).toBe(true)
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('shows empty switch/trust states and keeps package installation on its own tab', async () => {
    const { page } = await ready([])
    expect(plain(page).join('\n')).toContain('There is nothing to switch or trust here yet.')
    page.handleInput('\t')
    expect(plain(page).join('\n')).toContain('There is nothing to switch or trust here yet.')
    page.handleInput('\t')
    expect(plain(page).join('\n')).toContain('Install package…')
  })

  it('fills the terminal with a responsive inventory and inspector', async () => {
    const { page, ui } = await ready()
    expect(page.presentation).toBe('fullscreen')
    const terminal = { columns: 120, rows: 40 }
    const overlay = new PageOverlay({
      page,
      tui: { terminal, centeredDialogs: true } as unknown as TUI,
      theme: () => theme,
      close: vi.fn(),
      changed: vi.fn()
    })
    const render = () => overlay.render(terminal.columns).map(stripTerminalSequences)
    const wide = render()
    expect(wide).toHaveLength(40)
    expect(wide[0]).toContain('Plugins')
    expect(wide.at(-1)).toContain('Esc close')
    const description = wide.find(line => line.includes('Keeps short notes for the session.'))
    expect(description?.indexOf(' │ ')).toBeGreaterThanOrEqual(0)
    expect(description?.indexOf('Keeps short notes')).toBeGreaterThan(description?.indexOf(' │ ') ?? -1)
    expect(wide.every(line => visibleWidth(line) <= 120)).toBe(true)
    page.handleInput('\t')
    expect(render().join('\n')).toContain('Code not trusted')
    page.handleInput('\x1b[Z')
    expect(render()[0]).toContain('Plugins')
    const ignoredInspectorClick = page.handleMouse({ type: 'click', button: 'left', x: 90, y: 0, screenX: 90, screenY: 2, width: 120, height: 40, shift: false, alt: false, ctrl: false })
    expect(ignoredInspectorClick).toEqual({ handled: true, render: false })
    expect(ui.select).not.toHaveBeenCalled()

    terminal.columns = 40
    terminal.rows = 20
    const compact = render()
    expect(compact).toHaveLength(20)
    expect(compact[0]).toContain('Plugins')
    expect(compact.join('\n')).toContain('Keeps short notes for the session.')
    expect(compact.at(-1)).toContain('Esc close')
    expect(compact.every(line => visibleWidth(line) <= 40)).toBe(true)
    overlay.dispose()
  })

  it('opens the actions for a row and switches it off everywhere, then says changes wait for a restart', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\x1b[B')
    ui.select.mockResolvedValueOnce('Switch off everywhere')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'plugins.detach')).toBe(true))
    expect(ui.select.mock.calls[0]![1]).toEqual(['Switch off everywhere', 'Back'])
    expect(calls.find(([method]) => method === 'plugins.detach')![1]).toEqual({ id: 'notes/skill/summarize', everywhere: true })
    await vi.waitFor(() => expect(plain(page).join('\n')).toContain('Saved. Changes apply when this session restarts.'))
  })

  it('installs a local package only after confirmation', async () => {
    const { page, ui, calls } = await ready()
    ui.input.mockResolvedValueOnce('npm:review-kit@1.0.0')
    page.handleInput('\t')
    page.handleInput('\t')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Install package?', expect.stringContaining('switched off')))
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'plugins.install' && JSON.stringify(params) === JSON.stringify({ source: 'npm:review-kit@1.0.0' }))).toBe(true))
  })

  it('offers update and removal for local packages, but keeps Hub packages pinned to receipts', async () => {
    const local = await ready([packagePlugin])
    local.page.handleInput('\t')
    local.page.handleInput('\t')
    local.ui.select.mockResolvedValueOnce('Update package')
    local.page.handleInput('\r')
    await vi.waitFor(() => expect(local.calls.some(([method]) => method === 'plugins.update')).toBe(true))
    expect(local.ui.select.mock.calls[0]![1]).toEqual(['Update package', 'Remove package', 'Back'])

    const entry = { id: 'community/review-kit', title: 'Review Kit', description: 'Review helpers.', publisher: 'Community', license: 'MIT', version: '1.0.0', category: 'plugin', channel: 'community', tags: [], requires: {}, sourceUrl: 'https://example.com/source', delivery: { kind: 'pi-package', source: 'npm:review-kit@1.0.0' } }
    const hub = { ...emptyHub(), entries: [entry], installed: [{ entry, installedAt: '2026-10-20T08:00:00.000Z', resourceIds: [packagePlugin.id], document: null, state: 'installed' }] } as unknown as HubOverview
    const managed = await ready([packagePlugin], null, hub)
    managed.page.handleInput('\t')
    managed.page.handleInput('\t')
    managed.ui.select.mockResolvedValueOnce('Uninstall Hub version')
    managed.page.handleInput('\r')
    await vi.waitFor(() => expect(managed.calls.some(([method]) => method === 'plugins.remove')).toBe(true))
    expect(managed.ui.select.mock.calls[0]![1]).toEqual(['Uninstall Hub version', 'Back'])
    expect(managed.calls.some(([method]) => method === 'plugins.update')).toBe(false)
  })

  it('offers the project switch only when there is a project', async () => {
    const { page, ui } = await ready([notes], 'project-1')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalled())
    expect(ui.select.mock.calls[0]![1]).toEqual(['Switch off for this project', 'Switch off everywhere', 'Back'])
  })

  it('asks with the files in view before trusting code', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\t')
    ui.select.mockResolvedValueOnce('Trust its code')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Trust this code?', expect.stringContaining('index.js')))
    expect(ui.select.mock.calls[0]![1]).toEqual(['Trust its code', 'Back'])
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'plugins.trust')).toBe(true))
    expect(calls.find(([method]) => method === 'plugins.trust')![1]).toEqual({ hash: 'abcdef0123456789abcdef' })
  })

  it('changes nothing when the person declines trust or backs out', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\t')
    ui.select.mockResolvedValueOnce('Trust its code')
    ui.confirm.mockResolvedValueOnce(false)
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalled())
    ui.select.mockResolvedValueOnce('Back')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledTimes(2))
    expect(calls.some(([method]) => /plugins\.(trust|attach|detach)/.test(method))).toBe(false)
  })

  it('searches, clears with Escape first, and reports a plugin list that cannot be read', async () => {
    const { page } = await ready()
    page.handleInput('summ')
    expect(plain(page).some(row => row.includes('1 of 1'))).toBe(true)
    expect(page.handleInput('\x1b')).toBe(true)
    expect(page.handleInput('\x1b')).toBe(false)
    const broken = setup()
    ;(broken.page as unknown as { options: { call: ReturnType<typeof vi.fn> } }).options.call.mockRejectedValue(new Error('socket closed'))
    broken.page.activate()
    await vi.waitFor(() => expect(plain(broken.page).join('\n')).toContain('Could not read plugins: socket closed'))
  })

  it('never writes past the width', async () => {
    const { page } = await ready()
    for (const rows of [0, 1, 4, 9, 24]) for (let width = 0; width <= 90; width++) {
      const lines = page.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })

  describe('settings', () => {
    const withWeb = () => ready([notes, structuredClone(web)])
    const openWebSettings = async (page: PluginsPage) => {
      page.handleInput('Settings')
      page.handleInput('\r')
      await vi.waitFor(() => expect(page.activeTab()).toBe('settings'))
    }

    it('shows a Settings row only under a plugin that has settings, and not on the Trust tab', async () => {
      const { page } = await withWeb()
      const rows = plain(page)
      expect(rows.filter(row => row.includes('Settings'))).toHaveLength(1)
      expect(rows.findIndex(row => row === 'Web')).toBeLessThan(rows.findIndex(row => row.includes('Settings')))
      expect(rows.find(row => row.includes('Settings'))).toMatch(/2 settings ›$/)
      page.handleInput('\t')
      expect(plain(page).some(row => row.includes('Settings'))).toBe(false)
    })

    it('opens the settings as a subpage and flips a switch', async () => {
      const { page, calls } = await withWeb()
      await openWebSettings(page)
      expect(page.tabs().map(tab => tab.title)).toEqual(['Plugins › Web'])
      expect(page.hint()).toBe('Enter change · Esc back')
      const rows = plain(page)
      expect(rows.some(row => row.startsWith('❯ Search without a key') && row.endsWith('off'))).toBe(true)
      expect(rows.some(row => row.includes('Most searches') && row.endsWith('20 · default'))).toBe(true)
      page.handleInput('\r')
      await vi.waitFor(() => expect(calls.some(([method]) => method === 'plugins.configure')).toBe(true))
      expect(calls.find(([method]) => method === 'plugins.configure')![1]).toEqual({ pluginId: 'web', settings: { keylessSearch: 1 } })
      await vi.waitFor(() => expect(plain(page).some(row => row.startsWith('❯ Search without a key') && row.endsWith('on'))).toBe(true))
      expect(plain(page).join('\n')).toContain('Saved.')
    })

    it('shows Escape as back on the full-screen settings subpage', async () => {
      const { page } = await withWeb()
      await openWebSettings(page)
      const terminal = { columns: 80, rows: 24 }
      const overlay = new PageOverlay({
        page,
        tui: { terminal, centeredDialogs: true } as unknown as TUI,
        theme: () => theme,
        close: vi.fn(),
        changed: vi.fn()
      })
      const footer = overlay.render(terminal.columns).map(stripTerminalSequences).at(-1)!
      expect(footer).toContain('Esc back')
      expect(footer).not.toContain('Esc close')
      overlay.dispose()
    })

    it('asks for a number, refuses one outside the range, and saves one inside it', async () => {
      const { page, ui, calls } = await withWeb()
      await openWebSettings(page)
      page.handleInput('\x1b[B')
      expect(plain(page).join('\n')).toContain('From 1 to 200 · default 20')
      ui.input.mockResolvedValueOnce('500')
      page.handleInput('\r')
      await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Most searches must be a whole number from 1 to 200.', 'error'))
      expect(ui.input.mock.calls[0]).toEqual(['Most searches (1–200)', '20'])
      expect(calls.some(([method]) => method === 'plugins.configure')).toBe(false)
      ui.input.mockResolvedValueOnce('50')
      page.handleInput('\r')
      await vi.waitFor(() => expect(calls.some(([method]) => method === 'plugins.configure')).toBe(true))
      expect(calls.find(([method]) => method === 'plugins.configure')![1]).toEqual({ pluginId: 'web', settings: { maxCalls: 50 } })
      await vi.waitFor(() => expect(plain(page).some(row => row.includes('Most searches') && row.endsWith('50'))).toBe(true))
    })

    it('goes back to the list on Escape without closing the page, and reports a refused save', async () => {
      const { page, ui } = await withWeb()
      await openWebSettings(page)
      ;(page as unknown as { options: { call: ReturnType<typeof vi.fn> } }).options.call.mockRejectedValueOnce(new Error('Search without a key must be a number from 0 to 1.'))
      page.handleInput('\r')
      await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('Search without a key must be a number from 0 to 1.', 'error'))
      expect(page.handleInput('\x1b')).toBe(true)
      expect(page.activeTab()).toBe('plugins')
      expect(page.tabs().map(tab => tab.title)).toEqual(['Plugins', 'Trust', 'Packages', 'Proposals'])
    })

    it('never writes past the width in the subpage', async () => {
      const { page } = await withWeb()
      await openWebSettings(page)
      for (const rows of [0, 1, 4, 9, 24]) for (let width = 0; width <= 90; width++) {
        const lines = page.render(width, rows)
        expect(lines.length).toBeLessThanOrEqual(rows)
        for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
      }
    })
  })
})
