import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { TerminalMouseInput } from './mouse'
import type { TerminalPage } from './page'
import { PageOverlay } from './pageOverlay'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'

function setup(options: { rows?: number; columns?: number; centered?: boolean; consumed?: string[] } = {}) {
  const state = { active: 'overview', inputs: [] as string[], mouse: [] as { type: string; x: number; y: number }[], focused: false, activated: 0, disposed: 0 }
  const mouse = (type: 'move' | 'click', x: number, y: number): TerminalMouseInput => ({
    type, button: type === 'click' ? 'left' : 'none', x, y, screenX: x, screenY: y,
    width: options.columns ?? 80, height: options.rows ?? 24, shift: false, alt: false, ctrl: false
  })
  const page: TerminalPage = {
    tabs: () => [{ id: 'overview', title: 'Overview' }, { id: 'tools', title: 'Tools' }],
    activeTab: () => state.active,
    render: (width, rows) => [`body ${width}x${rows}`],
    handleMouse: event => { state.mouse.push({ type: event.type, x: event.x, y: event.y }); return { handled: true, render: true } },
    handleInput: data => {
      state.inputs.push(data)
      if (options.consumed?.includes(data) && (data !== '\x1b' || state.inputs.filter(input => input === data).length === 1)) return true
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { state.active = state.active === 'overview' ? 'tools' : 'overview'; return true }
      return false
    },
    hint: () => '↑/↓ select · Enter open',
    activate: () => { state.activated++ },
    dispose: () => { state.disposed++ },
    get focused() { return state.focused }, set focused(value) { state.focused = value }
  }
  const close = vi.fn()
  const changed = vi.fn()
  const tui = {
    terminal: { columns: options.columns ?? 80, rows: options.rows ?? 24 },
    centeredDialogs: options.centered
  } as unknown as TUI
  const overlay = new PageOverlay({ page, tui, theme: () => theme, close, changed })
  overlay.focused = true
  return { overlay, page, state, close, changed, mouse, plain: (width = 80) => overlay.render(width).map(stripTerminalSequences) }
}

describe('independent terminal page overlays', () => {
  it('fills the screen with only this command page and its own tabs', () => {
    const { plain } = setup()
    const rows = plain()
    expect(rows).toHaveLength(24)
    expect(rows[0]).toContain('Overview')
    expect(rows[0]).toContain('Tools')
    expect(rows[0]).not.toContain('Accounts')
    expect(rows[1]).toBe('─'.repeat(80))
    expect(rows[2]).toContain('body 76x20')
    expect(rows.at(-2)).toBe('─'.repeat(80))
    expect(rows.at(-1)).toBe('  ↑/↓ select · Enter open · Tab/Shift+Tab sections · Esc close')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('renders a padded centered dialog with only the Escape hint in its header', () => {
    const { plain } = setup({ columns: 80, rows: 24, centered: true })
    const rows = plain(64)
    expect(rows).toHaveLength(8)
    expect(rows.slice(0, 2)).toEqual(Array(2).fill(''))
    expect(rows[2]).toMatch(/^ {4}Overview +Esc$/)
    expect(rows[3]).toBe('')
    expect(rows[4]).toContain('Overview')
    expect(rows[5]).toContain('body 56x12')
    expect(rows.slice(6)).toEqual(Array(2).fill(''))
    expect(rows.at(-1)).toBe('')
    expect(rows.join('\n')).not.toContain('Esc close')
    expect(rows.join('\n')).not.toContain('─')
  })

  it('keeps the full screen when the terminal is too small for a readable dialog', () => {
    const { plain } = setup({ columns: 30, rows: 20, centered: true })
    expect(plain(30)).toHaveLength(20)
  })

  it('delegates left and right to this page and changes only its local tab', () => {
    const { overlay, state, plain } = setup()
    overlay.handleInput(RIGHT)
    expect(state.active).toBe('overview')
    overlay.handleInput(LEFT)
    expect(state.active).toBe('overview')
    expect(state.inputs).toEqual([RIGHT, LEFT])
    overlay.handleInput('\t')
    expect(state.active).toBe('tools')
    expect(plain()[0]).toContain('Tools')
  })

  it('uses Left and Right to navigate centered page tabs', () => {
    const { overlay, state } = setup({ centered: true })
    overlay.handleInput(RIGHT)
    expect(state.active).toBe('tools')
    overlay.handleInput(LEFT)
    expect(state.active).toBe('overview')
  })

  it('routes centered pointer coordinates to page rows and changes tabs on click', () => {
    const { overlay, state, mouse } = setup({ columns: 80, rows: 24, centered: true })
    overlay.render(64)

    expect(overlay.handleMouse(mouse('move', 5, 5))).toMatchObject({ handled: true })
    expect(state.mouse).toEqual([{ type: 'move', x: 1, y: 0 }])
    expect(overlay.handleMouse(mouse('click', 16, 4))).toMatchObject({ handled: true })
    expect(state.active).toBe('tools')
  })

  it('uses full terminal geometry and direct tab selection for pages that own focus', () => {
    const { overlay, page, state, mouse, plain } = setup({ columns: 120, rows: 40, centered: true })
    page.presentation = 'fullscreen'
    page.ownsNavigation = true
    page.selectTab = id => { state.active = id }
    expect(plain(120)).toHaveLength(40)
    expect(plain(120)[2]).toContain('body 116x36')
    overlay.handleMouse(mouse('click', 16, 0))
    expect(state.active).toBe('tools')
    expect(state.inputs).toEqual([])
    overlay.handleMouse(mouse('click', 4, 2))
    expect(state.mouse).toEqual([{ type: 'click', x: 2, y: 0 }])
    expect(plain(120).at(-1)).not.toContain('Tab/Shift+Tab sections')
  })

  it('selects previous and next tabs from a compact full-screen strip', () => {
    const { overlay, page, state, mouse } = setup({ columns: 16, rows: 20, centered: true })
    page.presentation = 'fullscreen'
    page.selectTab = id => { state.active = id }
    overlay.render(16)
    overlay.handleMouse(mouse('click', 12, 0))
    expect(state.active).toBe('tools')
    overlay.render(16)
    overlay.handleMouse(mouse('click', 2, 0))
    expect(state.active).toBe('overview')
  })

  it('offers Escape to the page first and closes only when the page leaves it', () => {
    const { overlay, close, state } = setup({ consumed: ['\x1b'] })
    overlay.handleInput('\x1b')
    expect(close).not.toHaveBeenCalled()
    expect(state.inputs).toEqual(['\x1b'])
    overlay.handleInput('\x1b')
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes on Ctrl+C, and disposes the page once', () => {
    const { overlay, close, state } = setup({ consumed: ['\x03'] })
    overlay.handleInput('\x03')
    expect(close).toHaveBeenCalledOnce()
    expect(state.inputs).not.toContain('\x03')
    overlay.dispose(); overlay.dispose()
    expect(state.disposed).toBe(1)
    expect(overlay.render(80)).toEqual([])
  })

  it('never writes past the terminal width, including a collapsed strip', () => {
    const { overlay } = setup()
    for (let width = 0; width <= 120; width++) {
      for (const row of overlay.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
    }
  })
})
