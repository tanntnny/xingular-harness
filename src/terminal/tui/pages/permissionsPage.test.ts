import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { TerminalPermissionState } from '../runtime'
import { createHarnessTheme } from '../theme'
import { PermissionsPage } from './permissionsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function setup(initial: TerminalPermissionState = { full: false, globalTools: [] }, active = ['read', 'bash', 'edit'], confirmed = true) {
  const state = { ...initial, globalTools: [...initial.globalTools] }
  const options = {
    theme: () => theme,
    permissions: vi.fn(async () => ({ full: state.full, globalTools: [...state.globalTools] })),
    setFullPermission: vi.fn(async (enabled: boolean) => { state.full = enabled }),
    setGlobalTool: vi.fn(async (tool: string, allowed: boolean) => {
      const at = state.globalTools.indexOf(tool)
      if (allowed && at < 0) state.globalTools.push(tool)
      if (!allowed && at >= 0) state.globalTools.splice(at, 1)
    }),
    activeTools: () => active,
    confirm: vi.fn(async () => confirmed),
    notify: vi.fn(),
    changed: vi.fn()
  }
  const page = new PermissionsPage(options)
  page.focused = true
  return { page, options, state }
}
const plain = (page: PermissionsPage, rows = 24, width = 80) => page.render(width, rows).map(stripTerminalSequences)
async function ready(...args: Parameters<typeof setup>) {
  const made = setup(...args)
  made.page.activate()
  await vi.waitFor(() => expect(plain(made.page).join('\n')).toContain('Full Permission'))
  return made
}

describe('the Permissions page', () => {
  it('says it is reading, then lists Full Permission first and each tool with its policy at the right', async () => {
    const { page } = setup()
    expect(plain(page).join('\n')).toContain('Reading permissions…')
    page.activate()
    await vi.waitFor(() => expect(plain(page).some(row => row.includes('Type to search'))).toBe(true))
    const rows = plain(page)
    expect(page.tabs().map(tab => tab.title)).toEqual(['Overview', 'Tools'])
    expect(rows.some(row => row.includes('1 tool'))).toBe(true)
    expect(rows).toContain('Mode')
    expect(rows.some(row => row.startsWith('❯ Full Permission') && row.endsWith('OFF'))).toBe(true)
    expect(rows.join('\n')).toContain('Applies to future approvals only.')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('lists a grant for a tool this session no longer has under its own heading', async () => {
    const { page } = await ready({ full: false, globalTools: ['bash', 'web_fetch'] })
    page.handleInput('\t')
    const rows = plain(page)
    expect(rows).toContain('Granted, not active here')
    expect(rows.some(row => row.startsWith('  web_fetch') && row.endsWith('● allowed everywhere'))).toBe(true)
    expect(rows.some(row => row.startsWith('❯ bash') && row.endsWith('● allowed everywhere'))).toBe(true)
  })

  it('toggles a tool grant with Enter and with Space, and shows the new policy', async () => {
    const { page, options } = await ready()
    page.handleInput('\t')
    page.handleInput('\r')
    await vi.waitFor(() => expect(options.setGlobalTool).toHaveBeenCalledWith('bash', true))
    await vi.waitFor(() => expect(plain(page).some(row => row.startsWith('❯ bash') && row.endsWith('● allowed everywhere'))).toBe(true))
    page.handleInput(' ')
    await vi.waitFor(() => expect(options.setGlobalTool).toHaveBeenLastCalledWith('bash', false))
    await vi.waitFor(() => expect(plain(page).some(row => row.startsWith('❯ bash') && row.endsWith('○ asks each time'))).toBe(true))
  })

  it('asks before turning Full Permission on, does nothing when declined, and turns it off without asking', async () => {
    const declined = await ready(undefined, undefined, false)
    declined.page.handleInput('\r')
    await vi.waitFor(() => expect(declined.options.confirm).toHaveBeenCalledWith('Enable Full Permission?', expect.stringContaining('Hard denials')))
    expect(declined.options.setFullPermission).not.toHaveBeenCalled()

    const accepted = await ready()
    accepted.page.handleInput('\r')
    await vi.waitFor(() => expect(accepted.options.setFullPermission).toHaveBeenCalledWith(true))
    await vi.waitFor(() => expect(plain(accepted.page).some(row => row.startsWith('❯ Full Permission') && row.endsWith('ON'))).toBe(true))
    accepted.options.confirm.mockClear()
    accepted.page.handleInput('\r')
    await vi.waitFor(() => expect(accepted.options.setFullPermission).toHaveBeenLastCalledWith(false))
    expect(accepted.options.confirm).not.toHaveBeenCalled()
  })

  it('searches the tools, types a space into the search instead of toggling, and clears with Escape first', async () => {
    const { page, options } = await ready()
    page.handleInput('\t')
    page.handleInput('ba')
    expect(plain(page).some(row => row.includes('1 of 3'))).toBe(true)
    page.handleInput(' ')
    expect(options.setGlobalTool).not.toHaveBeenCalled()
    expect(page.handleInput('\x1b')).toBe(true)
    expect(page.handleInput('\x1b')).toBe(false)
  })

  it('reports a failed change and a state that cannot be read', async () => {
    const { page, options } = await ready()
    page.handleInput('\t')
    options.setGlobalTool.mockRejectedValueOnce(new Error('Not allowed'))
    page.handleInput('\r')
    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledWith('Not allowed', 'error'))
    const broken = setup()
    broken.options.permissions.mockRejectedValue(new Error('socket closed'))
    broken.page.activate()
    await vi.waitFor(() => expect(plain(broken.page).join('\n')).toContain('Could not read permissions: socket closed'))
  })

  it('never writes past the width', async () => {
    const { page } = await ready({ full: true, globalTools: ['日本語のツール'] }, ['日本語のツール', 'bash'])
    for (const rows of [0, 1, 4, 9, 24]) for (let width = 0; width <= 80; width++) {
      const lines = page.render(width, rows)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })
})
