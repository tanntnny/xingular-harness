import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { HubOverview } from '../../../hub/schema'
import { createHarnessTheme } from '../theme'
import { HubPage } from './hubPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const entry = (id: string, title: string, category: string, kind: 'registry' | 'document' = 'registry') => ({
  id, title, description: `${title} helps with ${category}.`, publisher: 'Xingular', license: 'MIT', version: '1.0.0', category, channel: 'official', tags: [], requires: {},
  sourceUrl: 'https://example.com/source', delivery: kind === 'document' ? { kind, url: 'https://example.com/a', sha256: 'a'.repeat(64) } : { kind, registryKind: 'skills', url: 'https://example.com/a', sha256: 'a'.repeat(64) }
})
const catalog = (entries = [entry('x/review', 'Code review', 'skills'), entry('x/notes', 'Meeting notes', 'documents', 'document')]) =>
  ({ entries, installed: [], origin: 'bundled', refreshedAt: null, error: null, dataRoot: null, stateDir: '/tmp' }) as unknown as HubOverview

function setup(overview = catalog()) {
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'hub.list') return structuredClone(params?.refresh ? { ...overview, error: 'offline', origin: 'cached' } : overview)
    if (method === 'hub.install') return { entry: overview.entries[0], installedAt: 'now', resourceIds: [], document: null }
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
  it('lists the catalog by category with each version at the right, and the selected entry below', async () => {
    const { page } = await ready()
    const rows = plain(page)
    expect(rows.some(row => row.includes('3 entries'))).toBe(true)
    expect(rows).toContain('skills')
    expect(rows).toContain('documents')
    expect(rows.indexOf('documents')).toBeLessThan(rows.indexOf('skills'))
    expect(rows.some(row => row.startsWith('❯ Meeting notes') && row.endsWith('1.0.0'))).toBe(true)
    expect(rows.some(row => row.startsWith('  Code review') && row.endsWith('1.0.0'))).toBe(true)
    expect(rows.join('\n')).toContain('Meeting notes helps with documents.')
    expect(rows.join('\n')).toContain('Xingular · MIT · x/notes')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('opens an Installed tab with receipts and version details', async () => {
    const overview = {
      ...catalog(),
      installed: [{ entry: entry('x/review', 'Code review', 'skills'), installedAt: '2026-10-20T08:00:00.000Z', resourceIds: ['skills/review'], document: null, state: 'installed' as const }]
    } as unknown as HubOverview
    const { page } = await ready(overview)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Catalog', 'Installed'])
    page.handleInput('\t')
    const rows = plain(page)
    expect(rows.some(row => row.startsWith('❯ Code review') && row.endsWith('installed · 1.0.0'))).toBe(true)
    expect(rows.join('\n')).toContain('Installed 2026-10-20T08:00:00.000Z · installed')
  })

  it('installs only the listed version, and only after asking with what installing does', async () => {
    const { page, ui, calls } = await ready()
    page.handleInput('\x1b[B')
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Install Code review 1.0.0?', expect.stringContaining('Installed switched off.')))
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'hub.install')).toBe(true))
    expect(calls.find(([method]) => method === 'hub.install')![1]).toEqual({ id: 'x/review', version: '1.0.0' })
  })

  it('does not install when the person declines', async () => {
    const { page, ui, calls } = await ready()
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
