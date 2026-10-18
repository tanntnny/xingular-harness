import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import manifest from '../../../package.json'
import { promisify } from 'node:util'
import { CustomEditor, copyToClipboard, initTheme, type AgentSessionEvent, type ExtensionUIContext, type KeybindingsManager, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent'
import { CombinedAutocompleteProvider, Container, ProcessTerminal, Text, matchesKey, setKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteProvider, type Component, type EditorComponent, type ScrollView } from '@earendil-works/pi-tui'

import { controlCall } from '../control'
import { createTerminalCommands } from './commands'
import { DialogPanel, SearchableSelect } from './dialogs'
import { COMPOSER_SUGGESTIONS, HarnessEditor } from './editor'
import { HARNESS_KEYBINDINGS, terminalKeybindings } from './keybindings'
import { loadPiAdapter, setPiTheme } from './piAdapter'
import { createTerminalRuntime, type TerminalDecision, type TerminalRuntime } from './runtime'
import { createDock, createTerminalScreen, mountTerminalLayout, readScreenPreferences, scrollbackLines, writeScrollback, type ScreenHooks, type ScreenPreferences, type TerminalScreen } from './screen'
import { planModeTools } from './planMode'
import { renderStatusBand, singleLine } from './status'
import { skillCompletions } from './skillInvocation'
import { createHarnessLightTheme, createHarnessTheme } from './theme'
import { TerminalTranscript } from './transcript'
import { createTerminalUi, type TerminalUi } from './ui'
import { chooseWorkingVerb, createCompletionStatus, getWorkingSpinnerFrames, SPINNER_INTERVAL_MS, spinnerFrameAt } from './workingStatus'
import { HarnessWelcome } from './welcome'
import { answerTerminalQuestion } from './questions'
import type { QuestionAnswer } from '../../sessions/registry'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'

const exec = promisify(execFile)
type Mounted = Component & { dispose?(): void }
type EditorFactory = Parameters<ExtensionUIContext['setEditorComponent']>[0]
type HeaderFactory = Parameters<ExtensionUIContext['setHeader']>[0]
type FooterFactory = Parameters<ExtensionUIContext['setFooter']>[0]

/** The transcript document refreshes the thinking display from application state before each frame. */
class ChatDocument extends Container {
  constructor(private readonly beforeRender: () => void) { super() }
  override render(width: number): string[] {
    this.beforeRender()
    return super.render(width)
  }
}

async function openExternal(url: string): Promise<void> {
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
  await exec(program, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url])
}

/** Sole owner of terminal lifecycle, layout, input dispatch, focus and screen transitions. */
export class TerminalApplication {
  readonly terminal = new ProcessTerminal()
  readonly tui: TerminalScreen
  private readonly preferences: ScreenPreferences
  private readonly chat = new ChatDocument(() => this.syncThinking())
  private readonly above = new Container()
  private readonly editorSlot = new Container()
  private readonly below = new Container()
  private readonly footerSlot = new Container()
  private readonly dock: Component
  private readonly hooks: ScreenHooks = {
    theme: () => this.theme,
    latestKey: () => this.keybindings?.getKeys('tui.altScreen.bottom')[0],
    openUrl: url => this.attempt(() => openExternal(url)),
    pasteClipboard: () => this.attempt(() => this.pasteClipboard())
  }
  private readonly masthead: Component = {
    render: width => {
      // A trusted extension's header owns the top of the transcript and is never hidden here.
      if (this.header) return ['', ...this.header.render(width), '', '']
      if (!this.showsMasthead) return []
      return ['', ...new HarnessWelcome(this.theme, process.env.XINGULAR_HARNESS_NAME).render(width), '', '']
    },
    invalidate: () => this.header?.invalidate()
  }
  private readonly titleRow: Component = { render: width => this.titleLines(width), invalidate: () => {} }
  private readonly queueRows: Component = { render: width => this.queuedMessages(width), invalidate: () => {} }
  private readonly statusRow: Component = { render: width => this.statusLines(width), invalidate: () => {} }
  private runtime?: TerminalRuntime
  private ui!: TerminalUi
  private keybindings!: KeybindingsManager
  private editor!: EditorComponent
  private transcript!: TerminalTranscript
  private commands!: ReturnType<typeof createTerminalCommands>
  private header?: Mounted
  private footer?: Mounted
  private headerFactory?: HeaderFactory
  private footerFactory?: FooterFactory
  private editorFactory?: EditorFactory
  private widgets = new Map<string, { component: Mounted; placement: string }>()
  private statuses = new Map<string, string>()
  private branch: string | null = null
  private branchListeners = new Set<() => void>()
  private baseAutocomplete?: AutocompleteProvider
  private startedAt: number | null = null
  private activeVerb?: string
  private activeTurnId?: string
  private completionStatus?: string
  private requestStartedAt: number | null = null
  private lastTokensPerSecond: number | null = null
  private phase?: string
  private viewport?: ScrollView
  private toolsExpanded = false
  private planMode = false
  private normalTools?: string[]
  private stopped = false
  private initialized = false
  private closing?: Promise<void>
  private failure?: Error
  private finish!: () => void
  private done = new Promise<void>(resolve => { this.finish = resolve })
  private cleanup: (() => void)[] = []
  private finalCleanup: (() => void)[] = []
  private draftSync = Promise.resolve()
  private lastInput = ''
  private commandBusy = false
  private pendingPolling = false
  private pendingBusy = false
  private pendingAbort?: AbortController
  private pendingId?: string
  private dismissedDecisions = new Set<string>()
  private suggestion = COMPOSER_SUGGESTIONS[Math.floor(Math.random() * COMPOSER_SUGGESTIONS.length)]

  constructor(private readonly args: string[]) {
    this.preferences = readScreenPreferences(process.env.PI_CODING_AGENT_DIR)
    this.tui = createTerminalScreen(this.terminal, this.preferences, this.hooks)
    this.chat.addChild(this.masthead)
    this.dock = createDock({ title: this.titleRow, above: this.above, queue: this.queueRows, editor: this.editorSlot, below: this.below, footer: this.footerSlot })
    this.viewport = mountTerminalLayout(this.tui, { document: this.chat, dock: this.dock }, this.preferences, this.hooks)
  }
  private get session() { if (!this.runtime) throw new Error('The terminal runtime is not ready.'); return this.runtime.session }
  private get theme(): Theme { return this.ui.theme }
  /** The product lockup stays only until the chat has a user message; a resumed session starts without it. */
  private get showsMasthead(): boolean { return !this.runtime?.snapshot().hasUserMessages }
  private change = (): void => { if (!this.stopped) this.tui.requestRender() }
  private notify = (message: string, type = 'info'): void => {
    if (message.startsWith('No models available.')) message = 'No model is configured. Use /accounts or /login to sign in.'
    this.transcript?.notice(message, type)
    this.change()
  }
  private attempt = (action: () => Promise<unknown> | unknown): void => { void Promise.resolve().then(action).catch(error => this.notify(error instanceof Error ? error.message : String(error), 'error')).finally(this.change) }

  async run(): Promise<number> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The Harness frontend requires an interactive terminal.')
    if (!process.env.PI_CODING_AGENT_DIR || !process.env.XINGULAR_HARNESS_SOCKET) throw new Error('Prepare a Harness terminal session before starting its frontend.')
    const onSignal = () => { void this.shutdown() }
    const onFatal = (error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error))
      void this.shutdown()
    }
    const onContinue = () => { if (!this.stopped) { this.tui.start(); this.change() } }
    try {
      const adapter = await loadPiAdapter()
      initTheme('dark', false)
      const theme = createHarnessTheme({ getColorMode: () => process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' ? 'truecolor' : '256color' } as Theme)
      setPiTheme(theme)
      this.keybindings = terminalKeybindings(process.env.PI_CODING_AGENT_DIR)
      setKeybindings(this.keybindings)
      this.transcript = new TerminalTranscript(this.tui, () => this.theme, adapter.withBuiltInRenderers)
      this.chat.addChild(this.transcript)
      this.ui = this.makeUi(theme)
      this.mountEditor()
      this.tui.setFocus(this.editor)
      this.cleanup.push(this.tui.addInputListener(data => this.dispatchInput(data)))
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) { process.on(signal, onSignal); this.cleanup.push(() => { process.off(signal, onSignal) }) }
      process.on('uncaughtException', onFatal)
      process.on('unhandledRejection', onFatal)
      this.finalCleanup.push(() => { process.off('uncaughtException', onFatal); process.off('unhandledRejection', onFatal) })
      process.on('SIGCONT', onContinue)
      this.cleanup.push(() => { process.off('SIGCONT', onContinue) })
      this.tui.setShowHardwareCursor(true)
      this.tui.setClearOnShrink(true)
      this.tui.start()
      this.phase = 'Starting session…'
      this.runtime = await createTerminalRuntime(this.args, { ui: this.ui, shutdown: () => { void this.shutdown() }, notify: this.notify, changed: this.change, resources: services => {
        this.ui.setThemes(services.resourceLoader.getThemes().themes)
        const name = services.settingsManager.getTheme()
        const selected = name ? this.ui.getTheme(name) : undefined
        if (selected && this.ui.theme.name !== selected.name) this.ui.setTheme(selected)
      } })
      if (this.stopped) { await this.runtime.dispose(); if (this.failure) throw this.failure; return 0 }
      this.commands = createTerminalCommands({
        session: () => this.session, runtime: () => this.runtime!, ui: this.ui,
        cwd: () => this.runtime!.cwd, sessionDirectory: () => this.runtime!.sessionDirectory,
        refresh: () => this.refresh(), shutdown: () => { void this.shutdown() }, setEditorText: text => { this.editor.setText(text); this.syncDraft(text) },
        planMode: () => this.planMode, setPlanMode: enabled => this.setPlanMode(enabled),
        copyText: copyToClipboard, openExternal,
        changed: this.change,
        trajectory: {
          list: async () => (await controlCall<{ runs: TerminalTrajectoryRun[] }>('terminal.trajectory.list')).runs,
          read: (runId, afterSequence) => controlCall<TerminalTrajectorySnapshot>('terminal.trajectory.events', { runId, ...(afterSequence === undefined ? {} : { afterSequence }) })
        },
        suspend: () => this.suspend(), hotkeys: () => this.hotkeys(),
        changelog: async () => {
          for (const path of ['../CHANGELOG.md', '../../../CHANGELOG.md']) {
            try { return `${manifest.name} v${manifest.version}\n\n${(await readFile(new URL(path, import.meta.url), 'utf8')).split('\n').slice(0, 24).join('\n')}` } catch { /* Bundled hosts may omit package documentation. */ }
          }
          return `${manifest.name} v${manifest.version}\nRelease notes were not bundled with this installation.`
        },
        secretInput: (title, placeholder, options) => this.ui.secretInput(title, placeholder, options)
      })
      this.cleanup.push(this.runtime.subscribe(event => this.accept(event)))
      this.cleanup.push(this.runtime.onBeforeSessionChange(() => this.resetPresentation()))
      this.cleanup.push(this.runtime.onSessionChange(() => { this.keybindings.reload(); this.resetWorkingStatus(); this.scrollToLatest(); this.planMode = false; this.normalTools = undefined; this.refresh(true) }))
      this.initialized = true
      this.phase = undefined
      this.refresh(true)
      const tick = setInterval(() => { if (this.startedAt !== null) this.change(); void this.decisions() }, 100)
      const git = setInterval(() => { void this.refreshBranch() }, 3000)
      this.cleanup.push(() => { clearInterval(tick); clearInterval(git) })
      await this.refreshBranch()
      await this.done
      if (this.failure) throw this.failure
      return 0
    } catch (error) {
      if (this.ui && !this.stopped) { this.notify(error instanceof Error ? error.message : String(error), 'error'); this.tui.renderNow(true) }
      throw error
    } finally { await this.shutdown() }
  }

  private makeUi(theme: Theme): TerminalUi {
    return createTerminalUi({
      tui: this.tui, theme, themes: [createHarnessLightTheme(theme)], keybindings: this.keybindings, changed: this.change, notify: this.notify,
      setEditor: factory => this.mountEditor(factory), getEditor: () => this.editor,
      getEditorText: () => this.editor?.getText() ?? '', setEditorText: value => { this.editor.setText(value); this.syncDraft(value) },
      setStatus: (key, value) => { if (value === undefined) this.statuses.delete(key); else this.statuses.set(key, value) },
      setWidget: (key, content, placement) => {
        this.release(this.widgets.get(key)?.component)
        if (!content) this.widgets.delete(key)
        else this.widgets.set(key, { component: typeof content === 'function' ? content(this.tui, this.theme) : new Text(content.join('\n'), 0, 0), placement: placement ?? 'aboveEditor' })
        this.syncDock()
      },
      setHeader: factory => { this.headerFactory = factory; this.release(this.header); this.header = factory?.(this.tui, this.theme) },
      setFooter: factory => { this.footerFactory = factory; this.release(this.footer); this.footer = factory?.(this.tui, this.theme, this.footerData); this.syncDock() },
      getAutocompleteProvider: () => this.baseAutocomplete!,
      setAutocompleteProvider: provider => this.editor.setAutocompleteProvider?.(provider),
      themeChanged: next => { setPiTheme(next); this.remountPresentation() },
      getToolsExpanded: () => this.toolsExpanded, setToolsExpanded: value => { this.toolsExpanded = value; this.transcript.setExpanded(value) }
    })
  }
  private footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => this.branch, getExtensionStatuses: () => this.statuses,
    getAvailableProviderCount: () => new Set(this.runtime?.services.modelRuntime.getAvailableSnapshot().map(model => model.provider) ?? []).size,
    onBranchChange: callback => { this.branchListeners.add(callback); return () => { this.branchListeners.delete(callback) } }
  }
  private async refreshBranch(): Promise<void> {
    if (!this.runtime || this.stopped) return
    let branch: string | null = null
    try { branch = (await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: this.runtime.cwd, timeout: 2000 })).stdout.trim() || null }
    catch { /* Non-repositories and detached HEAD have no branch segment. */ }
    if (branch !== this.branch) { this.branch = branch; for (const listener of this.branchListeners) listener(); this.change() }
  }
  private release(component?: Mounted): void {
    try { component?.dispose?.() }
    catch (error) { this.notify(`Plugin cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 'error') }
  }
  private mountEditor(factory?: EditorFactory): void {
    const draft = this.editor?.getText() ?? ''
    this.release(this.editor as Mounted | undefined)
    this.editorFactory = factory
    const editorTheme = { borderColor: (text: string) => this.theme.fg('border', text), selectList: {
      selectedPrefix: (text: string) => this.theme.fg('accent', text), selectedText: (text: string) => this.theme.fg('accent', text), description: (text: string) => this.theme.fg('muted', text), scrollInfo: (text: string) => this.theme.fg('dim', text), noMatch: (text: string) => this.theme.fg('muted', text)
    } }
    this.editor = factory?.(this.tui, editorTheme, this.keybindings) ?? new HarnessEditor(this.tui, editorTheme, this.keybindings, {
      band: width => this.band(width), theme: () => this.theme,
      placeholder: () => this.runtime?.snapshot().hasUserMessages || this.startedAt !== null ? undefined : this.suggestion
    })
    this.editor.setText(draft)
    this.editor.onSubmit = text => this.submit(text)
    const onChange = this.editor.onChange
    this.editor.onChange = text => { onChange?.(text); this.syncDraft(text); this.change() }
    if (factory && this.editor instanceof CustomEditor) {
      // A trusted editor may consume keys in its own mode before delegating to CustomEditor.
      // Wire host actions into that delegation instead of taking the keys away in a listener.
      const editor = this.editor
      for (const action of Object.keys(HARNESS_KEYBINDINGS).filter(name => name.startsWith('app.'))) {
        const id = action as Parameters<CustomEditor['onAction']>[0]
        if (!editor.actionHandlers.has(id)) editor.onAction(id, () => { this.dispatchInput(this.lastInput, true) })
      }
      editor.onEscape ??= () => { this.dispatchInput(this.lastInput, true) }
      editor.onCtrlD ??= () => { void this.shutdown() }
      editor.onPasteImage ??= () => this.attempt(() => this.pasteClipboard())
      editor.onExtensionShortcut ??= data => this.extensionShortcut(data)
    }
    if (this.baseAutocomplete) this.editor.setAutocompleteProvider?.(this.ui.wrapAutocomplete(this.baseAutocomplete))
    this.syncDock()
    this.tui.setFocus(this.editor)
  }
  /** The dock's slots follow the current editor, widgets and footer; their rows are read at draw time. */
  private syncDock(): void {
    this.above.clear(); this.below.clear()
    for (const widget of this.widgets.values()) (widget.placement === 'belowEditor' ? this.below : this.above).addChild(widget.component)
    this.editorSlot.clear()
    if (this.editor) this.editorSlot.addChild(this.editor)
    this.footerSlot.clear()
    this.footerSlot.addChild(this.footer ?? this.statusRow)
  }
  private syncThinking(): void {
    if (!this.ui) return
    this.transcript?.setThinking(this.runtime?.snapshot().hideThinking ?? false, this.ui.state.hiddenThinkingLabel ?? 'Thinking…')
  }
  private resetWorkingStatus(): void {
    this.startedAt = null
    this.activeVerb = undefined
    this.activeTurnId = undefined
    this.completionStatus = undefined
    this.phase = undefined
  }
  /** Plan mode narrows the session to read-only tools; leaving it restores the set the session had before. */
  private setPlanMode(enabled: boolean): void {
    if (!this.runtime) return
    if (this.planMode === enabled) return
    if (this.planMode) {
      this.session.setActiveToolsByName(this.normalTools ?? this.session.getActiveToolNames())
      this.normalTools = undefined
    } else {
      this.normalTools = this.session.getActiveToolNames()
      this.session.setActiveToolsByName(planModeTools(this.normalTools))
    }
    this.planMode = enabled
    this.notify(this.planMode ? 'Plan mode: only read-only tools are available. Use /plan off to return to normal.' : 'Normal mode: all tools are available.')
    this.change()
  }
  private scrollToLatest(): void { this.viewport?.scrollToEnd() }
  private async chooseApproval(request: TerminalDecision, signal: AbortSignal): Promise<{ decision: 'approved' | 'denied'; alwaysAllow: boolean }> {
    if (signal.aborted) return { decision: 'denied', alwaysAllow: false }
    const viewport = this.viewport
    const scrollTop = viewport?.scrollTop
    const wasFollowingEnd = viewport?.isFollowingEnd
    const tool = request.target ?? 'action'
    const choices = [
      { value: 'once', label: 'Allow once' },
      ...(request.rememberable ? [{ value: 'global', label: `Always allow ${tool} everywhere` }] : []),
      { value: 'deny', label: 'Deny' }
    ]
    const details = [
      request.rememberable
        ? `Always allow applies to every future ${tool} call in Pi terminal sessions sharing this local Harness state.`
        : 'This approval cannot be saved as a tool grant.',
      '',
      request.action ?? ''
    ].join('\n')
    let abortListener: (() => void) | undefined
    try {
      const choice = await this.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const finish = (value: string | undefined) => {
          if (abortListener) signal.removeEventListener('abort', abortListener)
          abortListener = undefined
          done(value)
        }
        abortListener = () => finish(undefined)
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
        const list = new SearchableSelect(choices.map(item => item.label), tui, () => theme,
          index => finish(choices[index]?.value), () => finish(undefined))
        return new DialogPanel(`Approve ${tool}?`, list, () => theme, 'Enter choose · Esc deny', details)
      }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } })
      return { decision: choice === 'once' || choice === 'global' ? 'approved' : 'denied', alwaysAllow: choice === 'global' }
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener)
      if (viewport && viewport === this.viewport && scrollTop !== undefined && wasFollowingEnd !== undefined) {
        if (wasFollowingEnd) viewport.scrollToEnd()
        else viewport.scrollTo(scrollTop, { disableFollow: true })
      }
    }
  }
  /** Steps through the levels this model supports and stops at either end, unlike the wrapping cycle. */
  private stepThinking(direction: 1 | -1): void {
    const levels = this.session.getAvailableThinkingLevels()
    const next = levels[Math.min(levels.length - 1, Math.max(0, levels.indexOf(this.session.thinkingLevel) + direction))]
    if (!this.session.supportsThinking() || next === undefined || next === this.session.thinkingLevel) return
    this.session.setThinkingLevel(next)
  }
  private exitScrollback(): string[] | undefined {
    if (this.preferences.mode !== 'fullscreen' || this.preferences.exitOutput !== 'transcript' || !this.runtime?.snapshot().hasUserMessages) return undefined
    return scrollbackLines(this.chat, this.terminal.columns)
  }
  private titleLines(width: number): string[] {
    if (!this.ui) return []
    const title = this.runtime?.snapshot().name
    const active = this.startedAt !== null
    const working = this.phase ?? (active
      ? this.ui.state.workingVisible ? this.ui.state.workingMessage ?? this.activeVerb ?? 'Working…' : ''
      : this.completionStatus ?? '')
    const titleText = title ? this.theme.italic(this.theme.fg('dim', singleLine(title))) : ''
    const indicator = this.ui.state.workingIndicator
    const frames = indicator?.frames ?? getWorkingSpinnerFrames(process.env.TERM)
    const frame = active && frames.length
      ? spinnerFrameAt(Date.now() - this.startedAt!, frames, indicator?.intervalMs ?? SPINNER_INTERVAL_MS)
      : ''
    const defaultWorking = active && !this.phase && this.ui.state.workingVisible && !this.ui.state.workingMessage && working === this.activeVerb
    const workingColor = defaultWorking ? 'warning' : 'muted'
    const workText = working ? this.theme.fg(workingColor, (frame ? frame + ' ' : '') + singleLine(working)) : ''
    return titleText || workText ? [truncateToWidth(workText, width, '') + ' '.repeat(Math.max(0, width - visibleWidth(workText) - visibleWidth(titleText))) + titleText] : []
  }
  private queuedMessages(width: number): string[] {
    if (!this.ui) return []
    const state = this.runtime?.snapshot()
    return state ? [...state.queue.steering.map(text => `Steering: ${text}`), ...state.queue.followUp.map(text => `Follow-up: ${text}`)].flatMap(text => wrapTextWithAnsi(this.theme.fg('muted', text), width)) : []
  }
  private statusLines(width: number): string[] {
    return this.statuses.size ? wrapTextWithAnsi([...this.statuses.values()].join('  '), width) : []
  }
  private syncDraft(text: string): void {
    this.draftSync = this.draftSync.then(() => controlCall('terminal.draft', { dirty: text.length > 0 })).then(() => {}).catch(error => this.notify(String(error), 'error'))
  }
  private band(width: number): string {
    const state = this.runtime?.snapshot()
    const usage = this.runtime?.session.getSessionStats().tokens
    return renderStatusBand({ cwd: state?.cwd ?? process.cwd(), model: state?.model,
      thinkingLevel: state?.thinkingLevel ?? 'off', branch: this.branch, account: state?.account?.label ?? 'account unknown',
      inputTokens: (usage?.input ?? 0) + (usage?.cacheRead ?? 0), outputTokens: usage?.output ?? 0,
      tokensPerSecond: this.lastTokensPerSecond
    }, width, this.theme)
  }
  private submit(text: string, followUp = false): void {
    if (!text.trim() || !this.initialized) return
    if (this.commandBusy) { this.notify('Finish or cancel the active command first.', 'error'); return }
    const command = text.trimStart().startsWith('/')
    if (command) this.commandBusy = true
    this.editor.addToHistory?.(text)
    this.editor.setText(''); this.syncDraft(''); this.scrollToLatest()
    this.attempt(async () => {
      try {
        await this.draftSync
        if (this.stopped) return
        if (command && await this.commands.execute(text)) return
        if (text.trimStart().startsWith('!')) throw new Error('Use the bash tool so this action can be checked.')
        await this.runtime!.submit(this.commands.expandSkill(text), followUp)
      } finally { if (command) this.commandBusy = false }
    })
  }
  private dispatchInput(data: string, delegated = false) {
    this.lastInput = data
    if (this.stopped) return { consume: true }
    if (this.tui.hasOverlay()) return
    if (!this.initialized) { if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) void this.shutdown(); return { consume: true } }
    if (this.editorFactory && !delegated) return
    if (this.extensionShortcut(data)) return { consume: true }
    const is = (action: Parameters<KeybindingsManager['matches']>[1]) => this.keybindings.matches(data, action)
    if (is('app.interrupt')) {
      if (this.editor instanceof HarnessEditor && this.editor.isShowingAutocomplete()) return
      this.attempt(() => this.runtime!.interrupt())
    } else if (is('app.clear')) {
      if (this.session.isStreaming) this.attempt(() => this.runtime!.interrupt())
      else if (this.editor.getText()) { this.editor.setText(''); this.syncDraft('') }
      else void this.shutdown()
    } else if (is('app.exit') && this.editor.getText() === '') void this.shutdown()
    else if (is('app.thinking.cycle')) this.session.cycleThinkingLevel()
    else if (is('app.thinking.increase') || is('app.thinking.decrease')) this.stepThinking(is('app.thinking.increase') ? 1 : -1)
    else if (is('app.thinking.save')) this.session.setThinkingLevel(this.session.thinkingLevel, { persist: true })
    else if (is('app.model.cycleForward') || is('app.model.cycleBackward')) this.attempt(() => this.session.cycleModel(is('app.model.cycleBackward') ? 'backward' : 'forward'))
    else if (is('app.model.select')) this.attempt(() => this.commands.execute('/model'))
    else if (is('app.tools.expand')) this.ui.setToolsExpanded(!this.toolsExpanded)
    else if (is('app.thinking.toggle')) { const hidden = !this.session.settingsManager.getHideThinkingBlock(); this.session.settingsManager.setHideThinkingBlock(hidden); this.transcript.setThinking(hidden) }
    else if (is('app.message.followUp')) this.submit(this.editor.getExpandedText?.() ?? this.editor.getText(), true)
    else if (is('app.message.dequeue')) { const pending = this.session.clearQueue(); this.editor.setText([...pending.steering, ...pending.followUp, this.editor.getText()].filter(Boolean).join('\n')); this.syncDraft(this.editor.getText()) }
    else if (is('app.editor.external')) this.attempt(() => this.externalEditor())
    else if (is('app.message.copy')) this.attempt(() => this.commands.execute('/copy'))
    else if (is('app.clipboard.pasteImage')) this.attempt(() => this.pasteClipboard())
    else if (is('app.suspend')) this.attempt(() => this.suspend())
    else if (data === '?' && this.editor.getText() === '') this.notify(this.hotkeys())
    else return
    this.change(); return { consume: true }
  }
  private extensionShortcut(data: string): boolean {
    const shortcut = [...this.session.extensionRunner.getShortcuts(this.keybindings.getResolvedBindings()).entries()].find(([key]) => matchesKey(data, key))
    if (!shortcut) return false
    this.attempt(() => shortcut[1].handler(this.session.extensionRunner.createContext()))
    return true
  }
  private accept(event: AgentSessionEvent): void {
    if (event.type === 'turn_start') this.requestStartedAt = performance.now()
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const outputTokens = event.message.usage?.output
      const startedAt = this.requestStartedAt
      if (startedAt !== null && typeof outputTokens === 'number') {
        const duration = performance.now() - startedAt
        if (duration > 0) this.lastTokensPerSecond = outputTokens * 1000 / duration
      }
      this.requestStartedAt = null
    }
    this.transcript.accept(event)
    if (event.type === 'agent_start') {
      this.startedAt = Date.now()
      this.activeVerb = chooseWorkingVerb()
      this.activeTurnId = randomUUID()
      this.completionStatus = undefined
      this.phase = undefined
      this.terminal.setProgress(this.session.settingsManager.getShowTerminalProgress())
    }
    if (event.type === 'agent_settled') {
      if (this.startedAt !== null) this.completionStatus = createCompletionStatus(this.activeTurnId ?? randomUUID(), Date.now() - this.startedAt)
      this.startedAt = null
      this.activeVerb = undefined
      this.activeTurnId = undefined
      this.requestStartedAt = null
      this.phase = undefined
      this.terminal.setProgress(false)
    }
    if (event.type === 'compaction_start') this.phase = 'Compacting context…'
    if (event.type === 'compaction_end') { this.phase = undefined; this.transcript.bind(this.session); if (event.errorMessage) this.notify(event.errorMessage, 'error') }
    if (event.type === 'auto_retry_start') this.phase = `Retry ${event.attempt}/${event.maxAttempts} in ${(event.delayMs / 1000).toFixed(1)}s: ${event.errorMessage}`
    if (event.type === 'auto_retry_end') this.phase = event.finalError
    this.change()
  }
  private refresh(history = false): void {
    if (!this.runtime) return
    this.ui.setThemes(this.session.resourceLoader.getThemes().themes)
    this.tui.setShowHardwareCursor(this.session.settingsManager.getShowHardwareCursor())
    this.transcript.bind(this.session); this.transcript.setExpanded(this.toolsExpanded)
    if (history) for (const message of this.session.state.messages) if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      if (text) this.editor.addToHistory?.(text)
    }
    const commands = this.commands.completions()
    if (this.editor instanceof HarnessEditor) {
      this.editor.setValidCommands([
        ...commands.map(command => command.name),
        ...this.commands.skills().map(skill => 'skill:' + skill.name)
      ])
    }
    this.baseAutocomplete = skillCompletions(new CombinedAutocompleteProvider(commands, this.runtime.cwd), this.commands.skills)
    this.editor.setAutocompleteProvider?.(this.ui.wrapAutocomplete(this.baseAutocomplete))
    this.change()
  }
  private resetPresentation(): void {
    this.pendingAbort?.abort(); this.dismissedDecisions.clear()
    this.resetWorkingStatus()
    this.requestStartedAt = null; this.lastTokensPerSecond = null
    this.transcript.clearSession()
    this.ui.reset()
    this.release(this.header); this.release(this.footer)
    this.header = this.footer = undefined; this.headerFactory = this.footerFactory = undefined
    for (const widget of this.widgets.values()) this.release(widget.component)
    this.widgets.clear(); this.statuses.clear(); this.branchListeners.clear()
    this.mountEditor()
    // The UI object bound to the runtime stays stable; reset its session-owned state separately.
  }
  private remountPresentation(): void {
    this.release(this.header); this.release(this.footer)
    this.header = this.headerFactory?.(this.tui, this.theme)
    this.footer = this.footerFactory?.(this.tui, this.theme, this.footerData)
    this.mountEditor(this.editorFactory)
    if (this.runtime) this.refresh()
  }

  private async decisions(): Promise<void> {
    if (this.pendingPolling || !this.runtime || this.stopped) return
    this.pendingPolling = true
    let requests: TerminalDecision[]
    try {
      requests = await this.runtime.pending()
    } catch (error) {
      if (!this.stopped) this.notify(error instanceof Error ? error.message : String(error), 'error')
      return
    } finally { this.pendingPolling = false }
    if (this.pendingId && !requests.some(request => request.requestId === this.pendingId)) this.pendingAbort?.abort()
    if (this.pendingBusy) return
    this.pendingBusy = true
    try {
      const request = requests.find(request => !this.dismissedDecisions.has(request.requestId))
      if (!request || this.tui.hasOverlay()) return
      const abort = new AbortController(); this.pendingAbort = abort; this.pendingId = request.requestId
      this.dismissedDecisions.add(request.requestId)
      if (request.type === 'approval') {
        const choice = await this.chooseApproval(request, abort.signal)
        if (!abort.signal.aborted) await this.runtime.approve(request.requestId, choice.decision, choice.alwaysAllow)
      } else {
        const group = request.batchId
          ? requests.filter(item => item.type === 'question' && item.batchId === request.batchId).sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
          : [request]
        const answers: { questionId: string; answer: QuestionAnswer }[] = []
        for (const question of group) {
          const answer = await answerTerminalQuestion(this.ui, question, abort.signal)
          if (abort.signal.aborted) return
          if (!answer) { await this.runtime!.interrupt(); return }
          answers.push({ questionId: question.requestId, answer })
        }
        if (!abort.signal.aborted) {
          if (request.batchId) await this.runtime.answerBatch(request.batchId, answers)
          else await this.runtime.answer(request.requestId, answers[0]!.answer)
        }
      }
    } catch (error) {
      if (this.pendingId) this.dismissedDecisions.delete(this.pendingId)
      if (!this.stopped) this.notify(error instanceof Error ? error.message : String(error), 'error')
    }
    finally { this.pendingBusy = false; this.pendingId = undefined; this.pendingAbort = undefined }
  }
  private hotkeys(): string {
    return Object.entries(this.keybindings.getResolvedBindings()).filter(([name, keys]) => name.startsWith('app.') && (!Array.isArray(keys) || keys.length)).map(([name, keys]) => `${Array.isArray(keys) ? keys.join(', ') : keys}: ${name.slice(4).replaceAll('.', ' ')}`).join('\n') + (this.tui.mode === 'fullscreen' ? '\nPgUp/PgDn: scroll transcript\nCtrl+Home/End: oldest/latest transcript' : '')
  }
  private async pasteClipboard(): Promise<void> {
    const adapter = await loadPiAdapter()
    const files = await adapter.readClipboardFilePaths()
    if (files?.length) {
      if (files.some(file => /[\x00-\x1f\x7f]/.test(file))) throw new Error('Clipboard file paths contain control characters.')
      this.ui.pasteToEditor(files.join('\n'))
      return
    }
    const image = await adapter.readClipboardImage()
    if (image) {
      const directory = await mkdtemp(join(tmpdir(), 'harness-clipboard-'))
      const file = join(directory, `${randomUUID()}.${adapter.extensionForImageMimeType(image.mimeType) ?? 'png'}`)
      await writeFile(file, image.bytes, { mode: 0o600 })
      this.cleanup.push(() => { void rm(directory, { recursive: true, force: true }) })
      this.ui.pasteToEditor(file)
      return
    }
    const text = await adapter.readClipboardText()
    if (text) this.ui.pasteToEditor(text)
  }
  private async externalEditor(): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) throw new Error('Set VISUAL or EDITOR to open an external editor.')
    const directory = await mkdtemp(join(tmpdir(), 'harness-editor-')), file = join(directory, 'prompt.md')
    try {
      await writeFile(file, this.editor.getExpandedText?.() ?? this.editor.getText(), { mode: 0o600 })
      this.tui.stop()
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.SHELL || '/bin/sh', ['-c', `${editor} "$1"`, 'harness-editor', file], { stdio: 'inherit' })
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Editor exited with ${code}.`)))
      })
      this.editor.setText(await readFile(file, 'utf8')); this.syncDraft(this.editor.getText())
    } finally { await rm(directory, { recursive: true, force: true }); if (!this.stopped) { this.tui.start(); this.change() } }
  }
  private async suspend(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Suspending is unavailable on Windows.')
    this.tui.stop(); process.kill(process.pid, 'SIGTSTP')
  }
  shutdown(): Promise<void> {
    return this.closing ??= (async () => {
      const protect = (action: () => void) => {
        try { action() } catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
      }
      this.stopped = true
      protect(() => this.pendingAbort?.abort())
      protect(() => this.ui?.dispose())
      for (const cleanup of this.cleanup.splice(0)) protect(cleanup)
      // Captured while the runtime and its components still exist; written only after the alternate screen is left.
      const scrollback = this.exitScrollback()
      try { await this.runtime?.dispose() }
      catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
      finally {
        await this.terminal.drainInput(200, 30).catch(() => {})
        protect(() => this.tui.stop())
        if (scrollback) protect(() => writeScrollback(this.terminal, scrollback))
        protect(() => this.transcript?.clearSession())
        protect(() => this.header?.dispose?.())
        protect(() => this.footer?.dispose?.())
        for (const widget of this.widgets.values()) protect(() => widget.component.dispose?.())
        protect(() => (this.editor as Mounted | undefined)?.dispose?.())
        for (const cleanup of this.finalCleanup.splice(0)) protect(cleanup)
        this.finish()
      }
    })()
  }
}
export function runTerminalFrontend(args: string[]): Promise<number> { return new TerminalApplication(args).run() }
