import { CustomEditor, type ExtensionUIContext, type Theme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../control', () => ({ controlCall: vi.fn(async () => ({})) }))
import { controlCall } from '../control'
import { TerminalApplication } from './application'
import { terminalKeybindings } from './keybindings'
import { createHarnessTheme } from './theme'

function setup() {
  const application = new TerminalApplication([])
  const app = application as unknown as {
    ui: ExtensionUIContext & { wrapAutocomplete<T>(value: T): T; dispose(): void }
    keybindings: ReturnType<typeof terminalKeybindings>
    editor: CustomEditor
    runtime: { interrupt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; session: unknown; snapshot(): { hasUserMessages: boolean } }
    commands: { execute: ReturnType<typeof vi.fn> }
    notices: { message: string }[]
    initialized: boolean
    commandBusy: boolean
    mountEditor(factory?: Parameters<ExtensionUIContext['setEditorComponent']>[0]): void
    dispatchInput(data: string): { consume?: boolean } | undefined
    submit(text: string): void
  }
  vi.spyOn(application.tui, 'requestRender').mockImplementation(() => {})
  vi.spyOn(application.tui, 'stop').mockImplementation(() => {})
  vi.spyOn(application.terminal, 'drainInput').mockResolvedValue()
  const ui = { theme: createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme), wrapAutocomplete: <T>(value: T) => value,
    setToolsExpanded: vi.fn(), dispose: vi.fn() } as unknown as typeof app.ui
  app.ui = ui
  app.keybindings = terminalKeybindings('/unused/isolated-account')
  app.initialized = true
  const context = {}
  app.runtime = { interrupt: vi.fn(async () => {}), dispose: vi.fn(async () => {}), snapshot: () => ({ hasUserMessages: false }), session: {
    extensionRunner: { getShortcuts: () => new Map(), createContext: () => context },
    state: { messages: [] }, settingsManager: {}
  } }
  return { application, app, ui }
}

describe('the owned terminal application', () => {
  it('lets trusted custom editor modes consume Escape before delegating host actions', async () => {
    const { application, app } = setup()
    let normalMode = false
    class ModalEditor extends CustomEditor {
      override handleInput(data: string) {
        if (data === '\x1b') { normalMode = true; return }
        super.handleInput(data)
      }
    }
    app.mountEditor((tui, theme, keys) => new ModalEditor(tui, theme, keys))
    expect(app.dispatchInput('\x1b')).toBeUndefined()
    app.editor.handleInput('\x1b')
    expect(normalMode).toBe(true)
    expect(app.runtime.interrupt).not.toHaveBeenCalled()
    expect(app.dispatchInput('\x0f')).toBeUndefined()
    app.editor.handleInput('\x0f')
    expect(app.ui.setToolsExpanded).toHaveBeenCalledWith(true)
    await application.shutdown()
  })

  it('preserves custom editor change callbacks and reports actual draft contents', async () => {
    const { application, app } = setup()
    const changed = vi.fn()
    app.mountEditor((tui, theme, keys) => { const editor = new CustomEditor(tui, theme, keys); editor.onChange = changed; return editor })
    app.dispatchInput('draft')
    app.editor.handleInput('draft')
    await vi.waitFor(() => expect(controlCall).toHaveBeenCalledWith('terminal.draft', { dirty: true }))
    expect(changed).toHaveBeenCalledWith('draft')
    expect(app.editor.getText()).toBe('draft')
    await application.shutdown()
  })

  it('opens the keyboard list on ? over an empty prompt, and types ? into a draft', async () => {
    const { application, app } = setup()
    app.mountEditor()
    expect(app.dispatchInput('?')).toEqual({ consume: true })
    expect(app.editor.getText()).toBe('')
    expect(app.notices.map(notice => notice.message).join('\n')).toContain('PgUp/PgDn: scroll transcript')
    app.editor.setText('draft')
    expect(app.dispatchInput('?')).toBeUndefined()
    await application.shutdown()
  })

  it('routes leading-space commands and serializes command dialogs', async () => {
    const { application, app } = setup()
    app.mountEditor()
    let resolve!: (value: boolean) => void
    app.commands = { execute: vi.fn(() => new Promise<boolean>(done => { resolve = done })) }
    app.submit('   /settings')
    await vi.waitFor(() => expect(app.commands.execute).toHaveBeenCalledWith('   /settings'))
    app.submit('/model')
    await Promise.resolve(); await Promise.resolve()
    expect(app.commands.execute).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.waitFor(() => expect(app.commandBusy).toBe(false))
    await application.shutdown()
  })

  it('restores terminal modes and finishes even when runtime and plugin cleanup fail', async () => {
    const { application, app } = setup()
    const header = { dispose: vi.fn(() => { throw new Error('header cleanup failed') }) }
    const footer = { dispose: vi.fn() }
    Object.assign(app, { header, footer })
    app.ui.dispose = vi.fn(() => { throw new Error('dialog cleanup failed') })
    app.runtime.dispose.mockRejectedValue(new Error('runtime cleanup failed'))
    await expect(application.shutdown()).resolves.toBeUndefined()
    expect(header.dispose).toHaveBeenCalledOnce()
    expect(footer.dispose).toHaveBeenCalledOnce()
    expect(app.runtime.dispose).toHaveBeenCalledOnce()
    expect(application.terminal.drainInput).toHaveBeenCalledOnce()
    expect(application.tui.stop).toHaveBeenCalledOnce()
  })

  it('has one shutdown that disposes the runtime and restores the terminal', async () => {
    const { application, app } = setup()
    const first = application.shutdown()
    expect(application.shutdown()).toBe(first)
    await first
    expect(app.ui.dispose).toHaveBeenCalledOnce()
    expect(app.runtime.dispose).toHaveBeenCalledOnce()
    expect(application.terminal.drainInput).toHaveBeenCalledOnce()
    expect(application.tui.stop).toHaveBeenCalledOnce()
  })
})
