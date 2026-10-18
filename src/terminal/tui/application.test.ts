import { CustomEditor, type AgentSessionEvent, type ExtensionUIContext, type Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../control', () => ({ controlCall: vi.fn(async () => ({})) }))
import { controlCall } from '../control'
import { TerminalApplication } from './application'
import { createTerminalCommands } from './commands'
import type { TerminalDecision } from './runtime'
import { terminalKeybindings } from './keybindings'
import { autocompleteRuleColor, createHarnessTheme } from './theme'
import { TerminalTranscript } from './transcript'

function setup() {
  const application = new TerminalApplication([])
  const app = application as unknown as {
    theme: Theme
    ui: ExtensionUIContext & {
      wrapAutocomplete<T>(value: T): T
      dispose(): void
      state: { workingVisible: boolean; workingMessage?: string; workingIndicator?: { frames?: string[]; intervalMs?: number } }
    }
    keybindings: ReturnType<typeof terminalKeybindings>
    editor: CustomEditor
    runtime: { interrupt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn>; submitPlan: ReturnType<typeof vi.fn>; session: object; snapshot(): { hasUserMessages: boolean; cwd?: string; model?: { name: string; reasoning: boolean; contextWindow: number }; thinkingLevel?: string; account?: { label: string } | null; context?: { percent: number | null; window: number }; costUsd?: number; subscription?: boolean } }
    commands: ReturnType<typeof createTerminalCommands> | { execute: ReturnType<typeof vi.fn>; expandSkill(text: string): string }
    masthead: { render(width: number): string[] }
    header?: { render(width: number): string[]; invalidate(): void }
    branch: string | null
    transcript: TerminalTranscript
    initialized: boolean
    commandBusy: boolean
    mountEditor(factory?: Parameters<ExtensionUIContext['setEditorComponent']>[0]): void
    dispatchInput(data: string): { consume?: boolean } | undefined
    submit(text: string): void
    accept(event: AgentSessionEvent): void
    band(width: number): string
    titleLines(width: number): string[]
    resetWorkingStatus(): void
    phase?: string
  }
  vi.spyOn(application.tui, 'requestRender').mockImplementation(() => {})
  vi.spyOn(application.tui, 'stop').mockImplementation(() => {})
  vi.spyOn(application.terminal, 'drainInput').mockResolvedValue()
  vi.spyOn(application.terminal, 'setProgress').mockImplementation(() => {})
  const ui = { theme: createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme), state: { workingVisible: true }, wrapAutocomplete: <T>(value: T) => value,
    setToolsExpanded: vi.fn(), dispose: vi.fn() } as unknown as typeof app.ui
  app.ui = ui
  app.transcript = new TerminalTranscript(application.tui, () => ui.theme, () => undefined)
  app.keybindings = terminalKeybindings('/unused/isolated-account')
  app.initialized = true
  const context = {}
  app.runtime = { interrupt: vi.fn(async () => {}), dispose: vi.fn(async () => {}), submit: vi.fn(async () => {}), submitPlan: vi.fn(async () => {}), snapshot: () => ({
    hasUserMessages: false, cwd: '/work/project', model: { name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200_000 },
    thinkingLevel: 'high', account: { label: 'Tanny' }, context: { percent: null, window: 0 }, costUsd: 0, subscription: false
  }), session: {
    extensionRunner: { getShortcuts: () => new Map(), createContext: () => context },
    state: { messages: [] }, settingsManager: { getShowTerminalProgress: () => false },
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  } }
  return { application, app, ui }
}

describe('the owned terminal application', () => {
  it('shows a stable animated verb, then keeps completion status until the next turn', async () => {
    const { application, app } = setup()
    let now = 1000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)

    app.accept({ type: 'agent_start' } as AgentSessionEvent)
    const initialStatus = app.titleLines(100)[0] ?? ''
    expect(initialStatus).toContain(app.theme.fg('warning', '· Accomplishing'))
    const orangeRgb = autocompleteRuleColor(app.theme).slice(1).match(/.{2}/g)?.map(value => Number.parseInt(value, 16)) ?? []
    expect(initialStatus).toContain(`38;2;${orangeRgb.join(';')}`)
    expect(stripTerminalSequences(initialStatus).trim()).toContain('· Accomplishing')
    now = 1080
    const nextFrameStatus = app.titleLines(100)[0] ?? ''
    expect(nextFrameStatus).toContain(app.theme.fg('warning', '✢ Accomplishing'))
    expect(stripTerminalSequences(nextFrameStatus).trim()).toContain('✢ Accomplishing')

    now = 2450
    app.accept({ type: 'agent_settled' } as AgentSessionEvent)
    const completed = stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()
    expect(completed).toMatch(/^✻ (Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for 1s$/)
    expect(stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()).toBe(completed)

    now = 3000
    app.accept({ type: 'agent_start' } as AgentSessionEvent)
    expect(stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()).toContain('· Accomplishing')
    app.resetWorkingStatus()
    expect(app.titleLines(100)).toEqual([])

    random.mockRestore()
    dateNow.mockRestore()
    await application.shutdown()
  })

  it('keeps extension working overrides and phase labels ahead of the default verb', async () => {
    const { application, app, ui } = setup()
    ui.state.workingMessage = 'Inspecting'
    ui.state.workingIndicator = { frames: ['●'], intervalMs: 500 }

    app.accept({ type: 'agent_start' } as AgentSessionEvent)
    expect(stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()).toContain('● Inspecting')
    app.accept({ type: 'compaction_start' } as AgentSessionEvent)
    expect(stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()).toContain('● Compacting context…')
    ui.state.workingVisible = false
    expect(stripTerminalSequences(app.titleLines(100)[0] ?? '').trim()).toContain('● Compacting context…')
    app.phase = undefined
    expect(app.titleLines(100)).toEqual([])

    await application.shutdown()
  })

  it('shows current-conversation input plus cache-read totals and the last completed response rate', async () => {
    const { application, app } = setup()
    app.branch = 'main'
    Object.assign(app.runtime.session, { getSessionStats: () => ({ tokens: { input: 1200, output: 540, cacheRead: 300, cacheWrite: 100 } }) })
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(3000).mockReturnValueOnce(4000).mockReturnValueOnce(6000)
    app.accept({ type: 'turn_start' } as AgentSessionEvent)
    expect(stripTerminalSequences(app.band(160))).toContain('— tok/s in 1,500 out 540')
    app.accept({ type: 'message_end', message: { role: 'assistant', content: [], usage: { output: 60 } } } as unknown as AgentSessionEvent)
    expect(stripTerminalSequences(app.band(160))).toBe('project | main | Tanny · Sonnet 4.6 · high | 30 tok/s in 1,500 out 540')
    app.accept({ type: 'turn_start' } as AgentSessionEvent)
    expect(stripTerminalSequences(app.band(160))).toContain('30 tok/s in 1,500 out 540')
    app.accept({ type: 'message_end', message: { role: 'assistant', content: [], usage: { output: 40 } } } as unknown as AgentSessionEvent)
    expect(stripTerminalSequences(app.band(160))).toContain('20 tok/s in 1,500 out 540')
    now.mockRestore()
    await application.shutdown()
  })

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
    expect(app.transcript.render(120).join('\n')).toContain('PgUp/PgDn: scroll transcript')
    app.editor.setText('draft')
    expect(app.dispatchInput('?')).toBeUndefined()
    await application.shutdown()
  })

  it('offers Allow once, a tool-wide grant only when eligible, and Deny in the approval prompt', async () => {
    const { application, app } = setup()
    let shown = ''
    let chooseGlobal = true
    const ui = app.ui as unknown as { custom: (factory: (...args: unknown[]) => unknown) => Promise<string | undefined> }
    ui.custom = factory => new Promise(resolve => {
      const panel = factory(application.tui, app.ui.theme, app.keybindings, (value: unknown) => resolve(typeof value === 'string' ? value : undefined)) as {
        handleInput(data: string): void
        render(width: number): string[]
      }
      shown = stripTerminalSequences(panel.render(100).join('\n'))
      if (chooseGlobal) panel.handleInput('\x1b[B')
      panel.handleInput('\r')
    })
    const choose = (application as unknown as { chooseApproval(request: TerminalDecision, signal: AbortSignal): Promise<{ decision: string; alwaysAllow: boolean }> }).chooseApproval.bind(application)
    const remembered = await choose({ type: 'approval', requestId: 'r1', target: 'bash', rememberable: true, action: '{"command":"git status"}' } as TerminalDecision, new AbortController().signal)
    expect(shown).toContain('Always allow bash everywhere')
    expect(shown).toContain('Allow once')
    expect(shown).toContain('Deny')
    expect(remembered).toEqual({ decision: 'approved', alwaysAllow: true })

    chooseGlobal = false
    const oneTime = await choose({ type: 'approval', requestId: 'r2', target: 'bash', rememberable: false, action: '{}' } as TerminalDecision, new AbortController().signal)
    expect(shown).not.toContain('Always allow bash everywhere')
    expect(oneTime).toEqual({ decision: 'approved', alwaysAllow: false })
    await application.shutdown()
  })

  it('hides the product lockup once the chat has a user message', async () => {
    const { application, app } = setup()
    expect(app.masthead.render(80).join('\n')).toContain('Xingular Harness')
    app.runtime.snapshot = () => ({ hasUserMessages: true })
    expect(app.masthead.render(80)).toEqual([])
    app.runtime.snapshot = () => ({ hasUserMessages: false })
    expect(app.masthead.render(80).join('\n')).toContain('Xingular Harness')
    await application.shutdown()
  })

  it('keeps an extension header after the chat starts', async () => {
    const { application, app } = setup()
    vi.spyOn(application.terminal, 'write').mockImplementation(() => {})
    app.header = { render: () => ['custom header'], invalidate: () => {} }
    app.runtime.snapshot = () => ({ hasUserMessages: true })
    expect(app.masthead.render(80)).toContain('custom header')
    await application.shutdown()
  })

  it('routes leading-space commands and serializes command dialogs', async () => {
    const { application, app } = setup()
    app.mountEditor()
    let resolve!: (value: boolean) => void
    app.commands = { execute: vi.fn(() => new Promise<boolean>(done => { resolve = done })), expandSkill: text => text }
    app.submit('   /settings')
    await vi.waitFor(() => expect(app.commands.execute).toHaveBeenCalledWith('   /settings'))
    app.submit('/model')
    await Promise.resolve(); await Promise.resolve()
    expect(app.commands.execute).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.waitFor(() => expect(app.commandBusy).toBe(false))
    await application.shutdown()
  })

  it('keeps a queued plan isolated and sends later messages after it settles', async () => {
    const { application, app } = setup()
    const session = app.runtime.session as { isIdle: boolean }
    Object.assign(session, { isIdle: false })
    const sent: string[] = []
    app.runtime.submitPlan = vi.fn(async brief => { sent.push(`plan:${brief}`) })
    app.runtime.submit = vi.fn(async text => { sent.push(`prompt:${text}`) })
    const enqueuePlan = (application as unknown as { enqueuePlan(brief: string): void }).enqueuePlan.bind(application)
    app.mountEditor()
    app.commands = {
      execute: vi.fn(async text => {
        if (text.trimStart().startsWith('/plan ')) { enqueuePlan(text.trimStart().slice('/plan '.length)); return true }
        return false
      }),
      expandSkill: text => text
    }

    app.submit('/plan inspect the source')
    await vi.waitFor(() => expect(app.commandBusy).toBe(false))
    app.submit('then implement it')
    await vi.waitFor(() => expect((application as unknown as { deferredInputs: unknown[] }).deferredInputs).toHaveLength(2))
    expect(sent).toEqual([])

    session.isIdle = true
    app.accept({ type: 'agent_settled' } as AgentSessionEvent)
    await vi.waitFor(() => expect(sent).toEqual(['plan:inspect the source', 'prompt:then implement it']))
    expect(app.runtime.submitPlan).toHaveBeenCalledOnce()
    await application.shutdown()
  })

  it('steps thinking effort with shift arrows and stops at the ends of the model levels', async () => {
    const { application, app } = setup()
    const session = app.runtime.session as { thinkingLevel: string; getAvailableThinkingLevels(): string[]; supportsThinking(): boolean; setThinkingLevel(level: string): void }
    const setThinkingLevel = vi.fn((level: string) => { session.thinkingLevel = level })
    Object.assign(session, { thinkingLevel: 'low', getAvailableThinkingLevels: () => ['off', 'minimal', 'low', 'medium', 'high'], supportsThinking: () => true, setThinkingLevel })
    expect(app.dispatchInput('\x1b[1;2A')).toEqual({ consume: true })
    expect(app.dispatchInput('\x1b[1;2A')).toEqual({ consume: true })
    expect(app.dispatchInput('\x1b[1;2A')).toEqual({ consume: true })
    expect(setThinkingLevel.mock.calls).toEqual([['medium'], ['high']])
    expect(app.dispatchInput('\x1b[1;2B')).toEqual({ consume: true })
    expect(setThinkingLevel).toHaveBeenLastCalledWith('medium')
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
