import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { Plugin } from '../../../plugins/types'
import { createHarnessTheme } from '../theme'
import { PluginsPage } from './pluginsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const attachment = (global: boolean) => ({ global, on: { agentIds: [], projectIds: [] }, off: { agentIds: [], projectIds: [] } })
const notes = {
  id: 'notes', title: 'Notes', description: 'Keeps short notes for the session.', trust: 'untrusted', runsCode: true,
  code: { files: ['index.js'], hash: 'abcdef0123456789abcdef' }, attachment: null,
  contributions: [{ id: 'notes/skill/summarize', kind: 'skill', name: 'summarize', state: 'on', attachment: attachment(true) }]
} as unknown as Plugin

function setup(plugins: Plugin[] = [notes], projectId: string | null = null) {
  const calls: Array<[string, unknown]> = []
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'plugins.session') return { projectId }
    if (method === 'plugins.list') return structuredClone(plugins)
    return undefined
  }) as unknown as ConstructorParameters<typeof PluginsPage>[0]['call']
  const ui = { select: vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined), confirm: vi.fn(async () => true), notify: vi.fn() }
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
  it('lists each plugin and its parts under the plugin, with on or off and trust at the right', async () => {
    const { page } = await ready()
    const rows = plain(page)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Plugins', 'Trust'])
    expect(rows.some(row => row.includes('1 item'))).toBe(true)
    expect(rows).toContain('Notes')
    expect(rows.some(row => row.startsWith('❯ summarize') && row.endsWith('on · skill'))).toBe(true)
    expect(rows.join('\n')).toContain('Keeps short notes for the session.')
    page.handleInput('\t')
    const trust = plain(page)
    expect(trust.some(row => row.startsWith('❯ Whole plugin') && row.endsWith('off · code not trusted'))).toBe(true)
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('says when there is nothing to switch or trust', async () => {
    const { page } = await ready([])
    expect(plain(page).join('\n')).toContain('There is nothing to switch or trust here yet.')
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
})
