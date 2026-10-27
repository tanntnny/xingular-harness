import type { Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { HubEntry, HubOverview } from '../../../hub/schema'
import { PageOverlay } from '../pageOverlay'
import { createHarnessTheme } from '../theme'
import { HubPage } from './hubPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const entry = (id: string, title: string, category: string, kind: 'registry' | 'document' = 'registry', channel: 'community' | 'official' = 'community'): HubEntry => ({
  id, title, description: `${title} helps with ${category}.`, publisher: 'Xingular', license: 'MIT', version: '1.0.0', category, channel, tags: [], requires: {},
  sourceUrl: 'https://example.com/source', delivery: kind === 'document' ? { kind, url: 'https://example.com/a', sha256: 'a'.repeat(64) } : { kind, registryKind: 'skills', url: 'https://example.com/a', sha256: 'a'.repeat(64) }
})
const catalog = (entries = [entry('x/review', 'Code review', 'skills'), entry('x/notes', 'Meeting notes', 'documents', 'document')]) =>
  ({ entries, installed: [], origin: 'bundled', refreshedAt: null, error: null, dataRoot: null, stateDir: '/tmp' }) as unknown as HubOverview

function setup(overview = catalog(), remoteRefresh?: () => Promise<HubOverview>) {
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'hub.list') return structuredClone(params?.refresh ? remoteRefresh ? await remoteRefresh() : { ...overview, error: 'offline', origin: 'cached' } : overview)
    if (method === 'hub.install') return { entry: overview.entries[0], installedAt: 'now', resourceIds: [], document: null }
    if (method === 'terminal.browser.hubPreview') {
      const selected = overview.entries.find(entry => entry.id === params?.id && entry.version === params?.version) ?? overview.entries[0]
      const content = Array.from({ length: 30 }, (_, index) => `PREVIEW_ROW_${index + 1}`).join('\n')
      return { entry: selected, content, offset: 0, nextOffset: content.length, totalBytes: content.length, done: false }
    }
    if (method === 'hub.uninstall') {
      const { id, version } = params as { id: string; version: string }
      overview.installed = overview.installed.filter(receipt => receipt.entry.id !== id || receipt.entry.version !== version)
      return undefined
    }
    return undefined
  }) as unknown as ConstructorParameters<typeof HubPage>[0]['call']
  const ui = { select: vi.fn(async () => undefined as string | undefined), confirm: vi.fn(async () => true), notify: vi.fn() }
  const page = new HubPage({ theme: () => theme, call, ui, changed: vi.fn() })
  page.focused = true
  return { page, calls, ui }
}
const plain = (page: HubPage, rows = 24, width = 80) => page.render(width, rows).map(stripTerminalSequences)
async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args)
  made.page.activate()
  await vi.waitFor(() => expect(plain(made.page).some(row => row.includes('Type to search'))).toBe(true))
  return made
}

describe('the Hub page', () => {
  it('lists Community entries by category with the selected entry below and a refresh status', async () => {
    const data = catalog()
    data.entries.push(entry('official/tools', 'Official tool', 'skills', 'registry', 'official'))
    const { page } = await ready(data)
    const rows = plain(page)
    expect(rows.some(row => row.includes('3 entries'))).toBe(true)
    expect(rows.some(row => row.includes('cached catalog · refresh failed: offline'))).toBe(true)
    expect(rows).toContain('skills')
    expect(rows).toContain('documents')
    expect(rows.indexOf('documents')).toBeLessThan(rows.indexOf('skills'))
    expect(rows.some(row => row.startsWith('❯ Meeting notes') && row.endsWith('1.0.0'))).toBe(true)
    expect(rows.some(row => row.startsWith('  Code review') && row.endsWith('1.0.0'))).toBe(true)
    expect(rows.join('\n')).toContain('Meeting notes helps with documents.')
    expect(rows.join('\n')).toContain('Xingular · MIT · x/notes')
    expect(rows.join('\n')).not.toContain('Official tool')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('fills the terminal with catalog status, a responsive inventory, and entry details', async () => {
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
    expect(wide[0]).toContain('Catalog')
    expect(wide.at(-1)).toContain('Esc close')
    expect(wide.join('\n')).toContain('cached catalog · refresh failed: offline')
    const description = wide.find(line => line.includes('Meeting notes helps with documents.'))
    expect(description?.indexOf(' │ ')).toBeGreaterThanOrEqual(0)
    expect(description?.indexOf('Meeting notes helps')).toBeGreaterThan(description?.indexOf(' │ ') ?? -1)
    expect(wide.every(line => visibleWidth(line) <= 120)).toBe(true)
    const ignoredInspectorClick = page.handleMouse({ type: 'click', button: 'left', x: 90, y: 3, screenX: 90, screenY: 5, width: 120, height: 40, shift: false, alt: false, ctrl: false })
    expect(ignoredInspectorClick).toEqual({ handled: true, render: false })
    expect(ui.select).not.toHaveBeenCalled()

    terminal.columns = 40
    terminal.rows = 20
    const compact = render()
    expect(compact).toHaveLength(20)
    expect(compact[0]).toContain('Catalog')
    expect(compact.join('\n')).toContain('Meeting notes helps with documents.')
    expect(compact.at(-1)).toContain('Esc close')
    expect(compact.every(line => visibleWidth(line) <= 40)).toBe(true)
    overlay.dispose()
  })

  it('shows cached entries while the automatic remote refresh is in flight', async () => {
    let finish!: (value: HubOverview) => void
    const remote = new Promise<HubOverview>(resolve => { finish = resolve })
    const initial = { ...catalog(), origin: 'cached' } as unknown as HubOverview
    const made = setup(initial, () => remote)
    made.page.activate()
    await vi.waitFor(() => expect(made.calls.some(([method, params]) => method === 'hub.list' && (params as { refresh?: boolean })?.refresh)).toBe(true))
    const pending = plain(made.page).join('\n')
    expect(pending).toContain('Code review')
    expect(pending).toContain('cached catalog · refreshing')
    finish({ ...catalog(), origin: 'remote', refreshedAt: '2026-10-27T12:00:00.000Z' } as unknown as HubOverview)
    await vi.waitFor(() => expect(plain(made.page).join('\n')).toContain('remote catalog · refreshed'))
  })

  it('shows all receipt channels in Installed with version details and exact uninstallation', async () => {
    const community = entry('x/review', 'Code review', 'skills')
    const official = entry('x/legacy', 'Legacy tool', 'skills', 'registry', 'official')
    const overview = {
      ...catalog(),
      installed: [
        { entry: community, installedAt: '2026-10-20T08:00:00.000Z', resourceIds: ['skills/review'], document: null, state: 'installed' as const },
        { entry: official, installedAt: '2026-10-21T08:00:00.000Z', resourceIds: ['skills/legacy'], document: null, state: 'installed' as const }
      ]
    } as unknown as HubOverview
    const { page, ui, calls } = await ready(overview)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Catalog', 'Installed'])
    page.handleInput('\t')
    const rows = plain(page)
    expect(rows.some(row => row.startsWith('❯ Code review') && row.endsWith('community · installed · 1.0.0'))).toBe(true)
    expect(rows.some(row => row.startsWith('  Legacy tool') && row.endsWith('official · installed · 1.0.0'))).toBe(true)
    expect(rows.join('\n')).toContain('Installed 2026-10-20T08:00:00.000Z · community · installed')
    ui.select.mockResolvedValueOnce('Uninstall this version')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Uninstall Code review?', expect.stringContaining('x/review@1.0.0')))
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'hub.uninstall' && JSON.stringify(params) === JSON.stringify({ id: 'x/review', version: '1.0.0' }))).toBe(true))
  })

  it('previews reviewed payload content, scrolls it, and returns to the catalog', async () => {
    const { page, ui, calls } = await ready()
    ui.select.mockResolvedValueOnce('Preview reviewed content')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'terminal.browser.hubPreview' && JSON.stringify(params) === JSON.stringify({ id: 'x/review', version: '1.0.0' }))).toBe(true))
    expect(plain(page).join('\n')).toContain('Preview · Code review · 1/32')
    expect(plain(page).join('\n')).toContain('PREVIEW_ROW_1')
    expect(page.hint()).toContain('Esc back')
    page.handleInput('\x1b[B')
    expect(plain(page).join('\n')).toContain('PREVIEW_ROW_2')
    for (let index = 0; index < 8; index += 1) page.handleInput('\x1b[B')
    expect(plain(page).join('\n')).toContain('[Preview limited to first page.]')
    page.handleInput('\x1b')
    expect(plain(page).join('\n')).toContain('Code review')
    expect(plain(page).join('\n')).not.toContain('PREVIEW_ROW_')
  })

  it('does not offer payload preview for Pi packages', async () => {
    const packageEntry = { ...entry('x/package', 'Package entry', 'packages'), delivery: { kind: 'pi-package' as const, source: 'npm:@xingular/test@1.0.0' } }
    const { page, ui, calls } = await ready(catalog([packageEntry]))
    ui.select.mockResolvedValueOnce('Back')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.select).toHaveBeenCalledWith('Package entry · 1.0.0', ['Install exact version 1.0.0', 'Back']))
    expect(calls.some(([method]) => method === 'terminal.browser.hubPreview')).toBe(false)
  })

  it('installs only the listed version, and only after asking with what installing does', async () => {
    const { page, ui, calls } = await ready()
    ui.select.mockResolvedValueOnce('Install exact version 1.0.0')
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Install Code review 1.0.0?', expect.stringContaining('Installed switched off.')))
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'hub.install')).toBe(true))
    expect(calls.find(([method]) => method === 'hub.install')![1]).toEqual({ id: 'x/review', version: '1.0.0' })
  })

  it('does not install when the person declines', async () => {
    const { page, ui, calls } = await ready()
    ui.select.mockResolvedValueOnce('Install exact version 1.0.0')
    ui.confirm.mockResolvedValueOnce(false)
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalled())
    expect(calls.some(([method]) => method === 'hub.install')).toBe(false)
  })

  it('refreshes the catalog and warns when it had to fall back to other content', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\x1b[B'); page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(calls.some(([method, params]) => method === 'hub.list' && (params as { refresh?: boolean })?.refresh)).toBe(true))
    await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith('offline Using cached content.', 'warning'))
  })

  it('searches the catalog and clears with Escape first', async () => {
    const { page } = await ready()
    page.handleInput('meeting')
    expect(plain(page).some(row => row.includes('1 of 3'))).toBe(true)
    expect(page.handleInput('\x1b')).toBe(true)
    expect(page.handleInput('\x1b')).toBe(false)
  })

  it('says it is reading, and reports a catalog that cannot be read', async () => {
    const { page } = setup()
    expect(plain(page).join('\n')).toContain('Reading the catalog…')
    const broken = setup()
    ;(broken.page as unknown as { options: { call: ReturnType<typeof vi.fn> } }).options.call.mockRejectedValue(new Error('offline'))
    broken.page.activate()
    await vi.waitFor(() => expect(plain(broken.page).join('\n')).toContain('Could not read the catalog: offline'))
  })

  it('never writes past the width', async () => {
    const { page } = await ready()
    for (const rows of [0, 1, 4, 9, 24]) for (let width = 0; width <= 90; width++) {
      const lines = page.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })
})
