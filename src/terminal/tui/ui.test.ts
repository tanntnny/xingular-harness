import { type KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import { Input, KeybindingsManager as TuiKeybindingsManager, TuiMainScreen, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type AutocompleteProvider, type Component, type Terminal } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DialogPanel, SecretInput, type TerminalDialogOptions } from './dialogs'
import { createHarnessTheme } from './theme'
import { createTerminalUi, type TerminalUi } from './ui'

const open: TerminalUi[] = []
afterEach(() => { for (const ui of open.splice(0)) ui.dispose(); vi.useRealTimers() })
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
function setup() {
  const terminal = { columns: 80, rows: 30, kittyProtocolActive: false, write: vi.fn(), hideCursor: vi.fn(), setTitle: vi.fn(), start: vi.fn(), stop: vi.fn() } as unknown as Terminal
  const tui = new TuiMainScreen(terminal)
  vi.spyOn(tui, 'requestRender').mockImplementation(() => {})
  const originalInput = new Input()
  const original = Object.assign(originalInput, { getText: () => originalInput.getValue(), setText: (value: string) => originalInput.setValue(value) })
  tui.addChild(original)
  tui.setFocus(original)
  const callbacks = {
    changed: vi.fn(), notify: vi.fn(), setEditor: vi.fn(), getEditorText: vi.fn(() => 'draft'), setEditorText: vi.fn(),
    setStatus: vi.fn(), setWidget: vi.fn(), setHeader: vi.fn(), setFooter: vi.fn(), themeChanged: vi.fn(), setToolsExpanded: vi.fn()
  }
  const host = createTerminalUi({ tui, theme, keybindings: new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager, ...callbacks, getEditor: () => original })
  open.push(host)
  return { host, tui, terminal, original, callbacks }
}
function key(tui: TuiMainScreen, data: string): void { tui.getFocusedComponent()?.handleInput?.(data) }

function plain(component: Component, width = 80): string[] { return component.render(width).map(stripTerminalSequences) }

describe('the complete terminal extension UI host', () => {
  it('selects original option values and restores the actual TUI focus', async () => {
    const { host, tui, original } = setup()
    const promise = host.select('Choose account', ['First', 'Second\noriginal'])
    expect(tui.hasOverlay()).toBe(true)
    key(tui, '\x1b[B')
    key(tui, '\r')
    expect(await promise).toBe('Second\noriginal')
    expect(tui.getFocusedComponent()).toBe(original)
    expect(tui.hasOverlay()).toBe(false)
  })

  it('shows grouped selectors with headings and returns the original selected value', async () => {
    const { host, tui } = setup()
    const choice = host.selectGrouped('Account actions', [
      { label: 'Use for this session', group: 'Session' },
      { label: 'Rename', group: 'Account' },
      { label: 'Remove account', group: 'Remove' }
    ])
    const panel = tui.getFocusedComponent()!
    expect(plain(panel).join('\n')).toContain('Session')
    expect(plain(panel).join('\n')).toContain('Account')
    expect(plain(panel).join('\n')).toContain('Remove')
    key(tui, '\x1b[B')
    key(tui, '\x1b[B')
    key(tui, '\r')
    expect(await choice).toBe('Remove account')
  })

  it('resolves confirmation cancellation false, supports input and multiline editor values', async () => {
    const { host, tui } = setup()
    const confirmation = host.confirm('Delete credential?', 'Remove only this account')
    key(tui, '\x1b')
    expect(await confirmation).toBe(false)
    const input = host.input('Account label', 'Personal')
    key(tui, 'Work')
    key(tui, '\r')
    expect(await input).toBe('Work')
    const editor = host.editor('Edit prompt', 'Line 1')
    key(tui, '\n')
    key(tui, 'Line 2')
    key(tui, '\r')
    expect(await editor).toBe('Line 1\nLine 2')
  })

  it('dismisses aborted and timed dialogs, shows countdowns and removes every timer', async () => {
    vi.useFakeTimers()
    const { host, tui, original } = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await host.input('Already cancelled', undefined, { signal: controller.signal })).toBeUndefined()
    expect(tui.hasOverlay()).toBe(false)
    const active = new AbortController()
    const cancelled = host.select('Choice', ['One'], { signal: active.signal })
    active.abort()
    expect(await cancelled).toBeUndefined()
    expect(tui.getFocusedComponent()).toBe(original)
    const timed = host.input('Expires', undefined, { timeout: 1000 })
    expect(plain(tui.getFocusedComponent()!).join('\n')).toContain('1s')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await timed).toBeUndefined()
    expect(tui.getFocusedComponent()).toBe(original)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('masks credentials while retaining exact pasted and edited values', async () => {
    const { host, tui } = setup()
    const result = host.secretInput('API key')
    key(tui, '\x1b[200~secret_日本語_credential\x1b[201~')
    const component = tui.getFocusedComponent()!
    expect(plain(component).join('\n')).not.toContain('secret')
    expect(plain(component).join('\n')).not.toContain('credential')
    expect(plain(component).join('\n')).toContain('•')
    key(tui, '\r')
    expect(await result).toBe('secret_日本語_credential')
    const direct = new SecretInput({ prompt: '' })
    direct.setValue('private 🧠 secret')
    direct.focused = true
    for (let width = 1; width < 40; width++) {
      for (const row of direct.render(width)) {
        expect(row).not.toContain('private')
        expect(row).not.toContain('secret')
        expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('mounts trusted custom overlays and disposes them exactly once after done', async () => {
    const { host, tui, original, terminal } = setup()
    let finish: (value: string) => void = () => {}
    const custom = { render: () => ['Custom component'], invalidate() {}, dispose: vi.fn() }
    const onHandle = vi.fn()
    const factory = vi.fn((_tui, _theme, _keys, done) => { finish = done; return custom })
    const result = host.custom<string>(factory, { overlay: true, overlayOptions: () => ({ width: '50%', anchor: 'center' }), onHandle })
    await vi.waitFor(() => expect(onHandle).toHaveBeenCalledOnce())
    expect(factory.mock.calls[0][0]).toBe(tui)
    expect(factory.mock.calls[0][1]).toBe(theme)
    expect(tui.getFocusedComponent()).toBe(custom)
    finish('selected')
    finish('duplicate')
    expect(await result).toBe('selected')
    expect(custom.dispose).toHaveBeenCalledOnce()
    expect(tui.getFocusedComponent()).toBe(original)
    expect(terminal.start).not.toHaveBeenCalled()
    expect(terminal.stop).not.toHaveBeenCalled()
  })

  it('handles synchronous completion and async rejection without leaked focus or mounts', async () => {
    const { host, tui, original } = setup()
    const custom = { render: () => ['Custom'], invalidate() {}, dispose: vi.fn() }
    expect(await host.custom<string>((_tui, _theme, _keys, done) => { done('early'); return custom })).toBe('early')
    await Promise.resolve()
    expect(custom.dispose).toHaveBeenCalledOnce()
    await expect(host.custom(async () => { throw new Error('extension failed') })).rejects.toThrow('extension failed')
    expect(tui.getFocusedComponent()).toBe(original)
    expect(tui.hasOverlay()).toBe(false)
  })

  it('preserves trusted factories and forwards widgets, statuses, notifications and editor operations', () => {
    const { host, callbacks, original, terminal } = setup()
    const factory = vi.fn(() => original)
    host.setWidget('stats', factory, { placement: 'belowEditor' })
    host.setHeader(factory)
    host.setFooter(factory)
    host.setStatus('custom', 'Ready')
    host.notify('Loaded', 'info')
    host.pasteToEditor('inserted')
    host.setEditorText('replacement')
    host.setEditorComponent(factory)
    expect(host.getEditorComponent()).toBe(factory)
    expect(callbacks.setWidget).toHaveBeenCalledWith('stats', factory, 'belowEditor')
    expect(callbacks.setHeader).toHaveBeenCalledWith(factory)
    expect(callbacks.setFooter).toHaveBeenCalledWith(factory)
    expect(callbacks.setEditor).toHaveBeenCalledWith(factory)
    expect(callbacks.setStatus).toHaveBeenCalledWith('custom', 'Ready')
    expect(callbacks.notify).toHaveBeenCalledWith('Loaded', 'info')
    expect(original.getValue()).toBe('inserted')
    expect(callbacks.setEditorText).toHaveBeenCalledWith('replacement')
    expect(host.getEditorText()).toBe('draft')
    host.setTitle('Session\x1b]2;bad\x07\nname')
    expect(terminal.setTitle).toHaveBeenCalledWith('Session name')
  })

  it('retains theme, working indicator and output expansion state with actual callbacks', () => {
    const { host, callbacks } = setup()
    host.setWorkingMessage('Inspecting')
    host.setWorkingVisible(false)
    host.setWorkingIndicator({ frames: ['●'], intervalMs: 500 })
    host.setHiddenThinkingLabel('Reasoning')
    host.setToolsExpanded(true)
    expect(host.state).toMatchObject({ workingMessage: 'Inspecting', workingVisible: false, workingIndicator: { frames: ['●'], intervalMs: 500 }, hiddenThinkingLabel: 'Reasoning' })
    expect(host.getToolsExpanded()).toBe(true)
    expect(callbacks.setToolsExpanded).toHaveBeenCalledWith(true)
    expect(host.getAllThemes()).toEqual([{ name: 'harness-titanium', path: undefined }])
    expect(host.getTheme('harness-titanium')).toBe(theme)
    expect(host.setTheme('missing').success).toBe(false)
    expect(host.setTheme(theme)).toEqual({ success: true })
    expect(callbacks.themeChanged).toHaveBeenCalledWith(theme)
    expect(host.theme).toBe(theme)
  })

  it('stacks autocomplete wrappers over the original provider and preserves input listener cleanup', () => {
    const { host, tui } = setup()
    const provider: AutocompleteProvider = { getSuggestions: async () => null, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) }
    const first = vi.fn((base: AutocompleteProvider) => ({ ...base, triggerCharacters: ['@'] }))
    const second = vi.fn((base: AutocompleteProvider) => ({ ...base, triggerCharacters: [...base.triggerCharacters!, '#'] }))
    host.addAutocompleteProvider(first)
    host.addAutocompleteProvider(second)
    expect(host.wrapAutocomplete(provider).triggerCharacters).toEqual(['@', '#'])
    const remove = vi.fn()
    vi.spyOn(tui, 'addInputListener').mockReturnValue(remove)
    const unsubscribe = host.onTerminalInput(() => ({ consume: true }))
    unsubscribe()
    unsubscribe()
    host.dispose()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('resets session UI contributions and listeners while retaining a reusable UI object', async () => {
    const { host, tui, callbacks } = setup()
    const remove = vi.fn()
    vi.spyOn(tui, 'addInputListener').mockReturnValue(remove)
    host.onTerminalInput(() => undefined)
    host.setStatus('session-status', 'Busy')
    host.setWidget('session-widget', ['Temporary'])
    host.setWorkingMessage('Old session')
    host.setWorkingVisible(false)
    host.setWorkingIndicator({ frames: ['●'] })
    host.setHiddenThinkingLabel('Hidden')
    host.setToolsExpanded(true)
    host.addAutocompleteProvider(provider => provider)
    const pending = host.input('Old session question')
    host.reset()
    expect(await pending).toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
    expect(callbacks.setStatus).toHaveBeenLastCalledWith('session-status', undefined)
    expect(callbacks.setWidget).toHaveBeenLastCalledWith('session-widget', undefined)
    expect(callbacks.setHeader).toHaveBeenLastCalledWith(undefined)
    expect(callbacks.setFooter).toHaveBeenLastCalledWith(undefined)
    expect(callbacks.setEditor).toHaveBeenLastCalledWith(undefined)
    expect(host.state).toMatchObject({ workingVisible: true, toolsExpanded: false, autocompleteFactories: [] })
    expect(host.state.workingMessage).toBeUndefined()
    expect(host.state.workingIndicator).toBeUndefined()
    expect(host.state.hiddenThinkingLabel).toBeUndefined()
    const next = host.input('New session question')
    key(tui, 'new session')
    key(tui, '\r')
    expect(await next).toBe('new session')
  })

  it('refreshes loaded theme identities without retaining removed resource themes', () => {
    const { host } = setup()
    const loaded = Object.create(theme) as Theme
    Object.defineProperty(loaded, 'name', { value: 'plugin-theme' })
    Object.defineProperty(loaded, 'sourcePath', { value: '/trusted/theme.json' })
    host.setThemes([loaded])
    expect(host.getAllThemes()).toContainEqual({ name: 'plugin-theme', path: '/trusted/theme.json' })
    expect(host.getTheme('plugin-theme')).toBe(loaded)
    host.setThemes([])
    expect(host.getTheme('plugin-theme')).toBeUndefined()
    expect(host.getTheme('harness-titanium')).toBe(theme)
  })

  it('filters long selectors by their labels and preserves real selection across terminal resizes', async () => {
    const { host, tui, terminal } = setup()
    const options = Array.from({ length: 30 }, (_, index) => `Provider model ${index}`)
    options.push('Distinct 中文 model')
    const selected = host.select('Models', options)
    const panel = tui.getFocusedComponent()!
    expect(plain(panel).join('\n')).toContain('Type to search')
    key(tui, 'Distinct')
    expect(plain(panel).join('\n')).toContain('Distinct 中文 model')
    expect(plain(panel).join('\n')).not.toContain('Provider model')
    Object.defineProperty(terminal, 'rows', { value: 8 })
    for (let width = 0; width < 40; width++) {
      for (const row of panel.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
    key(tui, '\r')
    expect(await selected).toBe('Distinct 中文 model')
  })

  it('keeps CJK multiline editors responsive even in one-column overlays', async () => {
    const { host, tui } = setup()
    const editing = host.editor('中文', '日本語 🧠\nSecond line')
    const panel = tui.getFocusedComponent()!
    for (const width of [0, 1, 2, 3, 4, 5, 10, 80]) {
      for (const row of panel.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
    }
    key(tui, '\r')
    expect(await editing).toBe('日本語 🧠\nSecond line')
  })

  it('keeps approval choices and controls visible while every long action detail remains scrollable', async () => {
    const { host, tui, terminal } = setup()
    Object.defineProperty(terminal, 'rows', { value: 20 })
    const message = Array.from({ length: 50 }, (_, index) => `Action detail ${index}: /important/path/file-${index}.txt`).join('\n')
    const confirmation = host.confirm('Allow this action?', message)
    const panel = tui.getFocusedComponent()!
    const selected = panel.render(80).find(row => stripTerminalSequences(row).includes('❯ Yes'))
    expect(selected).toContain(theme.getBgAnsi('selectedBg'))
    expect(selected).not.toContain(theme.getFgAnsi('accent'))
    expect(visibleWidth(selected ?? '')).toBe(78)
    const observed: string[] = []
    for (let page = 0; page < 20; page++) {
      const rows = plain(panel, 40)
      expect(rows.length).toBeLessThanOrEqual(16)
      expect(rows.join('\n')).toContain('❯ Yes')
      expect(rows.join('\n')).toContain('No')
      expect(rows.some(row => row.includes('PgUp/PgDn details') && row.includes('Enter'))).toBe(true)
      observed.push(...rows)
      key(tui, '\x1b[6~')
    }
    expect(observed.join('\n')).toContain('file-0.txt')
    expect(observed.join('\n')).toContain('file-49.txt')
    key(tui, '\r')
    expect(await confirmation).toBe(true)
  })

  it('keeps the write-answer choice visible when a long question menu scrolls at 40 by 20', async () => {
    const { host, tui, terminal } = setup()
    Object.defineProperty(terminal, 'rows', { value: 20 })
    const choices = [...Array.from({ length: 20 }, (_, index) => `Choice ${index}: description ${'long '.repeat(20)}`), 'Write an answer']
    const selected = host.select('A question with long context', choices)
    for (let index = 1; index < choices.length; index++) key(tui, '\x1b[B')
    const rows = plain(tui.getFocusedComponent()!, 40)
    expect(rows.length).toBeLessThanOrEqual(16)
    expect(rows.join('\n')).toContain('❯ Write an answer')
    key(tui, '\r')
    expect(await selected).toBe('Write an answer')
  })

  it('docks a dialog as a block under an amber rule, with no box around it', async () => {
    const { host, tui } = setup()
    const choice = host.select('Choose one', ['Alpha', 'Beta'])
    const panel = tui.getFocusedComponent() as DialogPanel
    expect(panel.variant).toBe('block')
    const rows = plain(panel)
    expect(rows[0]).toBe('─'.repeat(80))
    expect(rows[1]).toContain('Choose one')
    expect(rows.some(row => row.includes('Type to search'))).toBe(true)
    expect(rows.join('\n')).toContain('❯ Alpha')
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
    expect(panel.render(80)[0]).toContain(theme.getFgAnsi('warning'))
    key(tui, '\r')
    expect(await choice).toBe('Alpha')
  })

  it('shows a page dialog full screen and still answers from it', async () => {
    const { host, tui, terminal } = setup()
    Object.defineProperty(terminal, 'rows', { value: 24 })
    const asPage: TerminalDialogOptions = { page: true }
    const choice = host.select('Accounts', ['Add account', 'Done'], asPage)
    const panel = tui.getFocusedComponent() as DialogPanel
    expect(panel.variant).toBe('page')
    const rows = plain(panel)
    expect(rows).toHaveLength(24)
    expect(rows[0]).toContain('Accounts')
    expect(rows[1]).toBe('─'.repeat(80))
    expect(rows.at(-2)).toBe('─'.repeat(80))
    expect(rows.join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
    key(tui, '\x1b[B')
    key(tui, '\r')
    expect(await choice).toBe('Done')
  })

  it('cancels all pending dialogs on shutdown and keeps every dialog row within the terminal width', async () => {
    const { host, tui } = setup()
    const input = host.input('中文title', 'Placeholder')
    const panel = tui.getFocusedComponent() as DialogPanel
    for (let width = 0; width < 100; width++) {
      for (const row of panel.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
    }
    host.dispose()
    expect(await input).toBeUndefined()
    expect(tui.hasOverlay()).toBe(false)
  })
})
