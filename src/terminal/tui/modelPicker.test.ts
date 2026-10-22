import type { AgentSession, Theme } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { ModelPicker } from './modelPicker'
import { createHarnessTheme } from './theme'

type PiModel = NonNullable<AgentSession['model']>
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const model = (provider: string, id: string, name = id): PiModel => ({ provider, id, name } as unknown as PiModel)
const sonnet = model('anthropic', 'claude-sonnet', 'Claude Sonnet')
const opus = model('anthropic', 'claude-opus', 'Claude Opus')
const gpt = model('openai', 'gpt-5', 'GPT 5')
const local = model('local', 'llama', 'Llama')

function setup(extra: Partial<ConstructorParameters<typeof ModelPicker>[0]> = {}, refresh: () => Promise<{ aborted: boolean; errors: Map<string, Error> }> = async () => ({ aborted: false, errors: new Map() })) {
  const runtime = {
    getAvailableSnapshot: () => [gpt, local, sonnet, opus],
    getModel: (provider: string, id: string) => [gpt, local, sonnet, opus].find(item => item.provider === provider && item.id === id),
    getError: () => undefined as string | undefined,
    refresh: vi.fn(async (_options?: unknown) => refresh())
  }
  const select = vi.fn()
  const cancel = vi.fn()
  const changed = vi.fn()
  const picker = new ModelPicker({
    theme: () => theme, tui: { terminal: { rows: 24 } } as unknown as TUI, runtime: runtime as never,
    current: sonnet, scoped: [], select, cancel, changed, ...extra
  })
  picker.focused = true
  return { picker, runtime, select, cancel, changed }
}
const plain = (picker: ModelPicker, width = 80) => picker.render(width).map(stripTerminalSequences)

describe('the model picker', () => {
  it('lists models with the current one first and marked, the provider at the right, and the search in the standard place', async () => {
    const { picker } = setup({ defaultModel: { provider: 'openai', id: 'gpt-5' } })
    const rows = plain(picker)
    expect(rows).toHaveLength(24)
    expect(rows[0]).toMatch(/^ {2}Model +Refreshing model catalogs…$/)
    expect(rows[0]).toHaveLength(78)
    expect(rows[1]).toBe('─'.repeat(80))
    expect(rows.some(row => row.includes('Type to search') && row.includes('4 models'))).toBe(true)
    expect(rows.some(row => /^ {2}❯ ✓ claude-sonnet +anthropic$/.test(row))).toBe(true)
    expect(rows.some(row => /^ {6}gpt-5 +openai · default$/.test(row))).toBe(true)
    expect(rows.join('\n')).toContain('Model name: Claude Sonnet')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
    await vi.waitFor(() => expect(plain(picker)[0]).not.toContain('Refreshing'))
  })

  it('fits its content inside a padded dialog for a host that centers pages', () => {
    const { picker } = setup({ tui: { terminal: { columns: 80, rows: 24 }, centeredDialogs: true } as unknown as TUI })
    const rows = plain(picker, 64)
    expect(rows.length).toBeLessThan(19)
    expect(rows.slice(0, 2)).toEqual(Array(2).fill(''))
    expect(rows[2]).toMatch(/^ {4}Model +Esc$/)
    expect(rows[3]).toBe('')
    expect(rows.slice(-2)).toEqual(Array(2).fill(''))
    expect(rows.join('\n')).not.toContain('Esc cancel')
    expect(rows.filter(row => row.includes('─'))).toHaveLength(2)
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯]/)
  })

  it('uses the model for this session with Enter, and saves it as the default with Ctrl+S', () => {
    const { picker, select } = setup()
    picker.handleInput('\x1b[B')
    picker.handleInput('\r')
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-opus' }), false)
    const second = setup()
    second.picker.handleInput('\x1b[B')
    second.picker.handleInput('\x13')
    expect(second.select).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-opus' }), true)
  })

  it('searches by provider, id or name, starts from a given filter, and shows the cursor', () => {
    const { picker } = setup({ initialSearch: 'gpt' })
    expect(plain(picker).some(row => row.includes('gpt') && row.includes('1 of 4'))).toBe(true)
    expect(plain(picker).join('\n')).toContain('gpt-5')
    expect(picker.render(80).join('')).toContain(CURSOR_MARKER)
    const byName = setup()
    byName.picker.handleInput('llama')
    expect(plain(byName.picker).join('\n')).toContain('local')
    expect(plain(byName.picker).join('\n')).not.toContain('gpt-5')
  })

  it('clears a search with Escape first, then cancels; Ctrl+C cancels at once', () => {
    const { picker, cancel } = setup()
    picker.handleInput('opus')
    picker.handleInput('\x1b')
    expect(cancel).not.toHaveBeenCalled()
    picker.handleInput('\x1b')
    expect(cancel).toHaveBeenCalledOnce()
    const other = setup()
    other.picker.handleInput('\x03')
    expect(other.cancel).toHaveBeenCalledOnce()
  })

  it('moves between all models and the scoped set with Tab when there is one', () => {
    const { picker } = setup({ scoped: [{ model: opus }, { model: gpt }] })
    expect(plain(picker).some(row => row.includes('All models · Scoped models'))).toBe(true)
    expect(plain(picker).join('\n')).toContain('claude-opus')
    expect(plain(picker).join('\n')).not.toContain('llama')
    picker.handleInput('\t')
    expect(plain(picker).join('\n')).toContain('llama')
    picker.handleInput('\x1b[Z')
    expect(plain(picker).join('\n')).not.toContain('llama')
    expect(plain(setup()['picker'])[3]).not.toContain('All models')
  })

  it('moves between model scopes with Left and Right', () => {
    const { picker } = setup({ scoped: [{ model: opus }, { model: gpt }], tui: { terminal: { columns: 80, rows: 24 }, centeredDialogs: true } as unknown as TUI })
    expect(plain(picker).join('\n')).not.toContain('llama')
    picker.handleInput('\x1b[C')
    expect(plain(picker).join('\n')).toContain('llama')
    picker.handleInput('\x1b[D')
    expect(plain(picker).join('\n')).not.toContain('llama')
  })

  it('refreshes catalogs on the account, says so, and reports what could not be refreshed', async () => {
    const ok = setup()
    await vi.waitFor(() => expect(ok.runtime.refresh).toHaveBeenCalledWith({ allowNetwork: true, signal: expect.any(AbortSignal) }))
    await vi.waitFor(() => expect(plain(ok.picker)[0]).toContain('Model catalogs refreshed.'))
    const failing = setup({}, async () => ({ aborted: false, errors: new Map([['openai', new Error('401')]]) }))
    await vi.waitFor(() => expect(plain(failing.picker).join('\n')).toContain('Could not refresh openai; showing cached models.'))
    const slow = setup({}, async () => ({ aborted: true, errors: new Map() }))
    await vi.waitFor(() => expect(plain(slow.picker).join('\n')).toContain('Model refresh timed out; showing cached models.'))
    const thrown = setup({}, async () => { throw new Error('offline') })
    await vi.waitFor(() => expect(plain(thrown.picker).join('\n')).toContain('Could not refresh model catalogs: offline'))
  })

  it('stops refreshing once closed', async () => {
    const { picker, runtime } = setup({}, () => new Promise(() => {}))
    const signal = (runtime.refresh.mock.calls[0]![0] as { signal: AbortSignal }).signal
    picker.dispose()
    expect(signal.aborted).toBe(true)
  })

  it('says when no model is available, and never writes past the width', () => {
    const { picker } = setup()
    picker.handleInput('zzzzzz')
    expect(plain(picker).join('\n')).toContain('No matches')
    const fresh = setup()
    for (const rows of [0, 1, 4, 9, 24]) for (let width = 0; width <= 100; width++) {
      Object.assign(fresh.picker, { options: { ...(fresh.picker as unknown as { options: object }).options, tui: { terminal: { rows } } } })
      const lines = fresh.picker.render(width)
      expect(lines.length).toBeLessThanOrEqual(rows)
      for (const line of lines) expect(visibleWidth(line), `${width}x${rows}`).toBeLessThanOrEqual(width)
    }
  })
})
