import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  copyToClipboard, initTheme, resizeImage,
  type AgentSessionEvent, type ExtensionUIContext, type ReadonlyFooterDataProvider, type Theme
} from '@earendil-works/pi-coding-agent'
import { matchesKey, type Component, type EditorComponent } from '@earendil-works/pi-tui'

import { controlCall } from '../control'
import { selectionText } from '../tui/chrome'
import { createTerminalCommands } from '../tui/commands'
import { BROWSER_COMMANDS } from '../browser'
import type { TerminalCommandHelpGroup } from '../commandHelp'
import { parseProposedPlan } from '../tui/planMode'
import { DialogPanel, SearchableSelect } from '../tui/dialogs'
import { terminalKeybindings } from '../tui/keybindings'
import { loadPiAdapter, setPiTheme } from '../tui/piAdapter'
import { createTerminalRuntime, type TerminalDecision, type TerminalImage, type TerminalRuntime } from '../tui/runtime'
import { SideQuestion, createSideSession, sideQuestionSnapshot } from '../tui/sideQuestion'
import { createHarnessLightTheme, createHarnessTheme } from '../tui/theme'
import { createTerminalUi, type TerminalUi } from '../tui/ui'
import { centeredDialogHost } from '../tui/dialogGeometry'
import { chooseCompletionVerb, chooseWorkingVerb, getWorkingSpinnerFrames, SPINNER_INTERVAL_MS, spinnerFrameAt } from '../tui/workingStatus'
import { stageClipboardFiles } from '../tui/clipboardFiles'
import { readHarnessLogSnapshot, type HarnessLogChunk, type HarnessLogInfo } from '../logs'
import type { OpenTuiMouseInput } from './mouse'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'
import type { TerminalSubagentActivity } from '../subagentMonitor'
import { parseAnsi, type AnsiLine } from './ansi'
import { asTui, PiDialogHost, type OverlayView } from './dialogHost'
import { ComposerAttachments, imageMimeTypeForPath, isLargePaste, parsePastedImagePaths, type AttachmentLabel } from './attachments'
import { splitBashDraft } from './bashMode'
import { TranscriptModel, type TranscriptItem } from './model'
import { matchPalette, type PaletteItem } from './palette'
import { completeFilePaths, formatPathCompletion, type PathCompletionItem } from './pathCompletion'
import { PlanChoice, type PlanChoiceView } from './planChoice'
import { QuestionDockState, type QuestionDockAnswers, type QuestionDockQuestion, type QuestionDockView } from './questionDockState'
import { clickableMarkdownUrl, openMarkdownLink } from './markdownLinks'
import { subagentsWidget } from './subagentsWidget'

const exec = promisify(execFile)
const COPY_TOAST_DURATION_MS = 2500
/**
 * The shortest gap between two view publications. While a run streams, 30 Hz leaves frames free
 * for keystrokes; otherwise one 60 Hz frame.
 */
const PUBLISH_INTERVAL_MS = 16
const RUNNING_PUBLISH_INTERVAL_MS = 33

function retryNotice(attempt: number, maxAttempts: number, delayMs: number, errorMessage: string): string {
  return `Retry ${attempt}/${maxAttempts} in ${(delayMs / 1000).toFixed(1)}s: ${errorMessage}`
}

/** Session statistics walk the whole history, so a streamed reply refreshes them at most this often. */
const STATISTICS_INTERVAL_MS = 250
type Mounted = Component & { dispose?(): void }
type EditorFactory = Parameters<ExtensionUIContext['setEditorComponent']>[0]
type HeaderFactory = Parameters<ExtensionUIContext['setHeader']>[0]
type FooterFactory = Parameters<ExtensionUIContext['setFooter']>[0]
type WidgetContent = string[] | ((...args: Parameters<NonNullable<HeaderFactory>>) => ReturnType<NonNullable<HeaderFactory>>) | undefined
type DeferredInput =
  | { kind: 'plan'; text: string; images?: TerminalImage[] }
  | { kind: 'bash'; text: string }
  | { kind: 'prompt'; text: string; followUp: boolean; images?: TerminalImage[] }
/** Larger images are refused when Pi cannot shrink them. */
const MAX_UNRESIZED_IMAGE_BYTES = 5 * 1024 * 1024

export interface KeyInput {
  name: string
  sequence: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super?: boolean
  repeated?: boolean
  cursorOffset?: number
}

export interface RendererControls {
  suspend(): Promise<void>
  resume(): Promise<void>
  setTitle(title: string): void
  setMousePointer(style: 'default' | 'pointer'): void
  getLinkAt(x: number, y: number): string | null
  destroy(): void
}

export interface PaletteView {
  items: PaletteItem[]
  index: number
}

export interface FileCompletionView {
  items: PathCompletionItem[]
  index: number
  start: number
  end: number
  source: string
}

export interface OpenTuiView {
  home: boolean
  sessionName?: string
  cwd: string
  branch: string | null
  account?: string
  model?: { name: string; provider: string; reasoning: boolean; contextWindow: number }
  thinking: string
  contextPercent: number | null
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  subscription: boolean
  items: readonly TranscriptItem[]
  hasUserMessages: boolean
  draft: string
  draftEpoch: number
  draftCursorOffset: number | null
  /** Labels of the images and collapsed pastes in the draft; the composer colours them. */
  attachments: AttachmentLabel[]
  /** Text for the composer to insert at its cursor; a new epoch means a new insertion. */
  insertion: { epoch: number; text: string } | null
  bashMode: boolean
  planMode: boolean
  /** The finished plan's choice block above the composer, or null. */
  planChoice: PlanChoiceView | null
  /** The pending question form above the composer, or null. */
  questionDock: QuestionDockView | null
  working: {
    sessionName?: string
    active: boolean
    frame: string
    label: string
    elapsedMs: number | null
    tokensPerSecond: number | null
  }
  statuses: string[]
  linkHovered: boolean
  toast: string | null
  palette: PaletteView | null
  fileCompletion: FileCompletionView | null
  overlay?: OverlayView
  customEditor?: AnsiLine[]
  header?: AnsiLine[]
  footer?: AnsiLine[]
  widgets: { above: AnsiLine[][]; below: AnsiLine[][] }
  toolsExpanded: boolean
}

export class OpenTuiApplication {
  private readonly host = new PiDialogHost(() => this.change())
  private readonly transcript = new TranscriptModel()
  private readonly listeners = new Set<() => void>()
  private readonly cleanup: (() => void | Promise<void>)[] = []
  private readonly statuses = new Map<string, string>()
  private readonly widgets = new Map<string, { component: Mounted; placement: string }>()
  private readonly branchListeners = new Set<() => void>()
  private historyIndex: number | undefined
  private runtime?: TerminalRuntime
  private ui?: TerminalUi
  private commands?: ReturnType<typeof createTerminalCommands>
  private sideQuestion?: SideQuestion
  private keybindings?: ReturnType<typeof terminalKeybindings>
  private themeValue?: Theme
  private renderer?: RendererControls
  private header?: Mounted
  private footer?: Mounted
  private headerFactory?: HeaderFactory
  private footerFactory?: FooterFactory
  private editorFactory?: EditorFactory
  private customEditor?: EditorComponent
  private draft = ''
  private draftEpoch = 0
  private draftCursorOffset: number | null = null
  private readonly attachments = new ComposerAttachments()
  private insertion: { epoch: number; text: string } | null = null
  private fileCompletion: FileCompletionView | null = null
  private fileCompletionRequest = 0
  private bashMode = false
  private planMode = false
  private paletteOpen = false
  private paletteSuppressed = false
  private paletteFilter = ''
  private paletteIndex = 0
  private branch: string | null = null
  private subagents: TerminalSubagentActivity[] = []
  private subagentsPolling = false
  private subagentGeneration = 0
  private startedAt: number | null = null
  private requestStartedAt: number | null = null
  private lastResponseTokensPerSecond: number | null = null
  private completedWorkingStatus?: { label: string; elapsedMs: number; tokensPerSecond: number | null }
  private activeVerb?: string
  private toastMessage?: string
  private toastTimer?: ReturnType<typeof setTimeout>
  private hoveredLink: string | null = null
  private activeTurnId?: string
  private toolsExpanded = false
  private deferredInputs: DeferredInput[] = []
  private planBarrierOpen = false
  private planActive = false
  private readonly planChoice = new PlanChoice()
  private questionDock?: QuestionDockState
  private drainingDeferred = false
  private activeDeferredKind?: DeferredInput['kind']
  private stopped = false
  private initialized = false
  private closing?: Promise<void>
  private failure?: Error
  private stopHandler?: () => void
  private finish!: () => void
  readonly done = new Promise<void>(resolve => { this.finish = resolve })
  private pendingPolling = false
  private pendingBusy = false
  private pendingAbort?: AbortController
  private pendingId?: string
  private readonly dismissedDecisions = new Set<string>()
  private commandBusy = false
  private draftSync = Promise.resolve()
  private pendingDraft?: boolean
  private draftSyncing = false

  constructor(private readonly args: string[], private readonly openLink: (url: string) => Promise<void> = openMarkdownLink) {}

  attachRenderer(renderer: RendererControls): void {
    this.renderer = renderer
    this.host.onTitle = title => renderer.setTitle(title)
  }

  updateLinkHover(x: number, y: number): void {
    const next = clickableMarkdownUrl(this.renderer?.getLinkAt(x, y))
    if (next === this.hoveredLink) return
    this.hoveredLink = next
    this.renderer?.setMousePointer(next ? 'pointer' : 'default')
    this.change()
  }

  activateLinkAt(x: number, y: number): boolean {
    const url = clickableMarkdownUrl(this.renderer?.getLinkAt(x, y))
    if (!url) return false
    this.hoveredLink = null
    this.renderer?.setMousePointer('default')
    this.change()
    this.attempt(() => this.openLink(url))
    return true
  }

  copySelection(text: string): void {
    if (!text.trim()) return
    this.attempt(async () => {
      await copyToClipboard(text)
      this.showToast('Copied transcript selection')
    })
  }

  setStopHandler(handler: () => void): void {
    this.stopHandler = handler
  }

  resize(width: number, height: number): void {
    this.host.resize(width, height)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get hasFailure(): boolean { return !!this.failure }

  get failureText(): string | undefined { return this.failure?.message }

  private publishTimer?: ReturnType<typeof setTimeout>
  private lastPublish = 0
  /** Set while handling a key or action of a person's, so what it changes publishes at once. */
  private interactive = false
  private statistics?: { at: number; snapshot: ReturnType<TerminalRuntime['snapshot']> | undefined; inputTokens: number; cacheReadTokens: number; outputTokens: number }

  /**
   * Schedules one view publication. A burst of changes, such as the events of a streamed reply,
   * becomes a single update at most once per frame instead of one per event.
   */
  private change = (): void => {
    // A key or action publishes synchronously, in order with the composer's own events: a draft
    // that a send clears must reach the composer before the composer reports its text again.
    // Typed text is not one of these: the composer draws it, and the view follows at frame pace.
    if (this.interactive) {
      if (this.publishTimer) clearTimeout(this.publishTimer)
      this.publish()
      return
    }
    if (this.publishTimer) return
    const interval = this.startedAt === null ? PUBLISH_INTERVAL_MS : RUNNING_PUBLISH_INTERVAL_MS
    const wait = Math.max(0, interval - (performance.now() - this.lastPublish))
    this.publishTimer = setTimeout(this.publish, wait)
  }

  /** Runs a person's key or action with immediate publication of what it changes. */
  private input<T>(action: () => T): T {
    const previous = this.interactive
    this.interactive = true
    try { return action() }
    finally { this.interactive = previous }
  }

  private publish = (): void => {
    this.publishTimer = undefined
    this.lastPublish = performance.now()
    for (const listener of this.listeners) {
      try { listener() }
      catch { /* A renderer listener cannot change Harness state. */ }
    }
  }

  private get theme(): Theme {
    if (!this.themeValue) throw new Error('The terminal theme is not ready yet.')
    return this.themeValue
  }

  private notify = (message: string, type = 'info'): void => {
    if (message.startsWith('No models available.')) message = 'No model is configured. Use /accounts or /login to sign in.'
    this.transcript.notice(message, type)
    this.change()
  }

  private showHelp(groups: TerminalCommandHelpGroup[]): void {
    this.transcript.commandHelp(groups)
    this.change()
  }

  private showToast(message: string): void {
    if (this.stopped) return
    this.toastMessage = message
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toastMessage = undefined
      this.toastTimer = undefined
      this.change()
    }, COPY_TOAST_DURATION_MS)
    this.change()
  }

  private attempt = (action: () => Promise<unknown> | unknown): void => {
    void Promise.resolve().then(action).catch(error => this.notify(error instanceof Error ? error.message : String(error), 'error')).finally(this.change)
  }

  async start(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The Harness frontend requires an interactive terminal.')
    if (!process.env.PI_CODING_AGENT_DIR || !process.env.XINGULAR_HARNESS_SOCKET) throw new Error('Prepare a Harness terminal session before starting its frontend.')
    try {
      await loadPiAdapter()
      initTheme('dark', false)
      const theme = createHarnessTheme({
        getColorMode: () => process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' ? 'truecolor' : '256color'
      } as Theme)
      setPiTheme(theme)
      this.themeValue = theme
      this.keybindings = terminalKeybindings(process.env.PI_CODING_AGENT_DIR)
      this.ui = createTerminalUi({
        tui: asTui(this.host),
        theme,
        themes: [createHarnessLightTheme(theme)],
        keybindings: this.keybindings,
        changed: this.change,
        notify: this.notify,
        setEditor: factory => this.mountEditor(factory),
        getEditor: () => this.customEditor as EditorComponent,
        getEditorText: () => this.draft,
        setEditorText: value => this.setDraftExternal(value),
        setStatus: (key, value) => {
          if (value === undefined) this.statuses.delete(key)
          else this.statuses.set(key, value)
        },
        setWidget: (key, content, placement) => this.mountWidget(key, content, placement),
        setHeader: factory => {
          this.headerFactory = factory
          this.release(this.header)
          this.header = factory?.(asTui(this.host), theme)
          this.change()
        },
        setFooter: factory => {
          this.footerFactory = factory
          this.release(this.footer)
          this.footer = factory?.(asTui(this.host), theme, this.footerData)
          this.change()
        },
        themeChanged: next => { setPiTheme(next); this.themeValue = next; this.remountPresentation() },
        getToolsExpanded: () => this.toolsExpanded,
        setToolsExpanded: value => { this.toolsExpanded = value; this.transcript.setExpanded(value); this.change() }
      })
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
        const handler = () => { void this.shutdown() }
        process.on(signal, handler)
        this.cleanup.push(() => { process.off(signal, handler) })
      }
      const onFatal = (error: unknown) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error))
        void this.shutdown()
      }
      process.on('uncaughtException', onFatal)
      process.on('unhandledRejection', onFatal)
      this.cleanup.push(() => {
        process.off('uncaughtException', onFatal)
        process.off('unhandledRejection', onFatal)
      })
      const onContinue = () => { if (!this.stopped) void this.renderer?.resume().catch(() => undefined) }
      process.on('SIGCONT', onContinue)
      this.cleanup.push(() => { process.off('SIGCONT', onContinue) })
      this.notify('Starting session…')
      this.runtime = await createTerminalRuntime(this.args, {
        ui: this.ui,
        shutdown: () => { void this.shutdown() },
        notify: this.notify,
        changed: this.change,
        resources: services => {
          this.ui?.setThemes(services.resourceLoader.getThemes().themes)
          const name = services.settingsManager.getTheme()
          const selected = name ? this.ui?.getTheme(name) : undefined
          if (this.ui && selected && this.ui.theme.name !== selected.name) this.ui.setTheme(selected)
        }
      })
      if (this.stopped) return
      this.sideQuestion = new SideQuestion({
        create: () => createSideSession(this.runtime!.services, this.runtime!.session),
        snapshot: () => sideQuestionSnapshot(this.runtime!.session.messages, this.runtime!.session.isStreaming),
        theme: () => this.theme,
        mount: dock => {
          const previous = this.widgets.get('harness-btw')
          if (previous) this.release(previous.component)
          if (dock) this.widgets.set('harness-btw', { component: dock as Mounted, placement: 'aboveEditor' })
          else this.widgets.delete('harness-btw')
          this.change()
        },
        changed: this.change
      })
      this.commands = createTerminalCommands({
        session: () => this.runtime!.session,
        runtime: () => this.runtime!,
        ui: this.ui,
        cwd: () => this.runtime!.cwd,
        sessionDirectory: () => this.runtime!.sessionDirectory,
        refresh: () => this.refresh(),
        shutdown: () => { void this.shutdown() },
        setEditorText: text => this.setDraftExternal(text),
        plan: brief => this.enqueuePlan(brief),
        btw: question => this.sideQuestion!.ask(question),
        copyText: copyToClipboard,
        control: (method, params) => controlCall(method, params ?? {}),
        changed: this.change,
        showHelp: groups => this.showHelp(groups),
        logs: {
          read: () => readHarnessLogSnapshot(
            () => controlCall<HarnessLogInfo>('terminal.logs.info'),
            (snapshotSize, offset) => controlCall<HarnessLogChunk>('terminal.logs.read', { snapshotSize, offset })
          )
        },
        trajectory: {
          list: async () => (await controlCall<{ runs: TerminalTrajectoryRun[] }>('terminal.trajectory.list')).runs,
          read: (runId, afterSequence) => controlCall<TerminalTrajectorySnapshot>('terminal.trajectory.events', { runId, ...(afterSequence === undefined ? {} : { afterSequence }) })
        },
        subagents: () => this.subagents,
        suspend: () => this.suspend(),
        hotkeys: () => this.hotkeys()
      })
      this.cleanup.push(this.runtime.subscribe(event => this.accept(event)))
      this.cleanup.push(this.runtime.onBeforeSessionChange(() => this.resetPresentation()))
      this.cleanup.push(this.runtime.onSessionChange(() => {
        this.keybindings?.reload()
        this.resetActiveWorkingStatus()
        this.refresh()
      }))
      this.initialized = true
      this.refresh()
      let lastSubagentPoll = 0
      const tick = setInterval(() => {
        if (this.startedAt !== null || this.sideQuestion?.state === 'thinking') this.change()
        const now = Date.now()
        if (this.startedAt !== null && now - lastSubagentPoll >= 1000) {
          lastSubagentPoll = now
          void this.refreshSubagents()
        }
        void this.decisions()
      }, 100)
      const git = setInterval(() => { void this.refreshBranch() }, 3000)
      this.cleanup.push(() => { clearInterval(tick); clearInterval(git) })
      await this.refreshBranch()
      this.change()
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.notify(this.failure.message, 'error')
      await this.shutdown()
      throw this.failure
    }
  }

  private get session() {
    if (!this.runtime) throw new Error('The terminal runtime is not ready.')
    return this.runtime.session
  }

  private get footerData(): ReadonlyFooterDataProvider {
    return {
      getGitBranch: () => this.branch,
      getExtensionStatuses: () => this.statuses,
      getAvailableProviderCount: () => new Set(this.runtime?.services.modelRuntime.getAvailableSnapshot().map(model => model.provider) ?? []).size,
      onBranchChange: callback => {
        this.branchListeners.add(callback)
        return () => { this.branchListeners.delete(callback) }
      }
    }
  }

  private async refreshBranch(): Promise<void> {
    if (!this.runtime || this.stopped) return
    let branch: string | null = null
    try {
      branch = (await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: this.runtime.cwd, timeout: 2000 })).stdout.trim() || null
    } catch { /* Non-repositories and detached HEAD have no branch segment. */ }
    if (branch !== this.branch) {
      this.branch = branch
      for (const listener of this.branchListeners) listener()
      this.change()
    }
  }

  private async refreshSubagents(): Promise<void> {
    if (!this.runtime || this.startedAt === null || this.stopped || this.subagentsPolling) return
    const generation = this.subagentGeneration
    this.subagentsPolling = true
    try {
      if (!this.session.getActiveToolNames().includes('spawn_subagent')) {
        if (this.subagents.length) {
          this.subagents = []
          this.change()
        }
        return
      }
      const result = await controlCall<{ children: TerminalSubagentActivity[] }>('terminal.subagents.monitor')
      if (generation !== this.subagentGeneration || this.startedAt === null || this.stopped) return
      if (JSON.stringify(result.children) !== JSON.stringify(this.subagents)) {
        this.subagents = result.children
        this.change()
      }
    } catch { /* Keep the last observed activity through a transient monitor error. */ }
    finally {
      this.subagentsPolling = false
    }
  }

  private release(component?: Mounted): void {
    try { component?.dispose?.() }
    catch (error) { this.notify(`Plugin cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 'error') }
  }

  private mountEditor(factory?: EditorFactory): void {
    const draft = this.customEditor?.getText() ?? this.draft
    this.release(this.customEditor as Mounted | undefined)
    this.editorFactory = factory
    if (!factory) {
      this.customEditor = undefined
      this.change()
      return
    }
    const editorTheme = {
      borderColor: (text: string) => this.theme.fg('border', text),
      selectList: {
        selectedPrefix: (text: string) => selectionText(this.theme, text),
        selectedText: (text: string) => selectionText(this.theme, text),
        description: (text: string) => this.theme.fg('muted', text),
        scrollInfo: (text: string) => this.theme.fg('dim', text),
        noMatch: (text: string) => this.theme.fg('muted', text)
      }
    }
    const editor = factory(asTui(this.host), editorTheme, this.keybindings!)
    editor.setText(draft)
    editor.onSubmit = text => this.submit(text)
    editor.onChange = text => { this.draft = text; this.syncDraft(text); this.change() }
    const focusable = editor as unknown as { focused?: boolean }
    focusable.focused = true
    this.customEditor = editor
    this.change()
  }

  private mountWidget(key: string, content: WidgetContent, placement?: string): void {
    const previous = this.widgets.get(key)
    if (previous) this.release(previous.component)
    if (!content) {
      this.widgets.delete(key)
      this.change()
      return
    }
    const component: Mounted = typeof content === 'function'
      ? content(asTui(this.host), this.theme) as Mounted
      : { render: () => content, invalidate: () => {} }
    this.widgets.set(key, { component, placement: placement ?? 'aboveEditor' })
    this.change()
  }

  private remountPresentation(): void {
    this.release(this.header)
    this.release(this.footer)
    this.header = this.headerFactory?.(asTui(this.host), this.theme)
    this.footer = this.footerFactory?.(asTui(this.host), this.theme, this.footerData)
    this.mountEditor(this.editorFactory)
    this.refresh()
  }

  private refresh(): void {
    if (!this.runtime) return
    this.ui?.setThemes(this.session.resourceLoader.getThemes().themes)
    this.transcript.bind(this.session)
    this.transcript.setThinkingHidden(this.session.settingsManager.getHideThinkingBlock())
    this.transcript.setImagesShown(this.session.settingsManager.getShowImages())
    this.transcript.setExpanded(this.toolsExpanded)
    this.change()
  }

  private resetPresentation(): void {
    this.historyIndex = undefined
    this.invalidateFileCompletion()
    void this.sideQuestion?.dismiss()
    this.pendingAbort?.abort()
    this.questionDock?.cancel()
    this.questionDock = undefined
    this.dismissedDecisions.clear()
    this.deferredInputs = []
    this.planBarrierOpen = false
    this.planActive = false
    this.planChoice.clear()
    this.activeDeferredKind = undefined
    this.resetActiveWorkingStatus()
    this.subagentGeneration += 1
    this.subagents = []
    this.transcript.clear()
    this.ui?.reset()
    this.release(this.header)
    this.release(this.footer)
    this.header = this.footer = undefined
    this.headerFactory = this.footerFactory = undefined
    for (const widget of this.widgets.values()) this.release(widget.component)
    this.widgets.clear()
    this.statuses.clear()
    this.branchListeners.clear()
    this.mountEditor(undefined)
    this.change()
  }

  private resetActiveWorkingStatus(): void {
    this.startedAt = null
    this.requestStartedAt = null
    this.lastResponseTokensPerSecond = null
    this.activeVerb = undefined
    this.activeTurnId = undefined
  }

  private accept(event: AgentSessionEvent): void {
    if (event.type !== 'message_update') this.statistics = undefined
    if (event.type === 'bash_execution_update' && event.id?.startsWith('initial-bash:')) {
      this.transcript.appendBashOutput(event.id, event.delta)
    }
    if (event.type === 'turn_start') this.requestStartedAt = performance.now()
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const outputTokens = event.message.usage?.output
      const requestStartedAt = this.requestStartedAt
      if (requestStartedAt !== null && typeof outputTokens === 'number') {
        const duration = performance.now() - requestStartedAt
        if (duration > 0 && Number.isFinite(outputTokens)) {
          this.lastResponseTokensPerSecond = Math.max(0, outputTokens) * 1000 / duration
        }
      }
      this.requestStartedAt = null
    }
    if (event.type === 'agent_start') {
      this.subagentGeneration += 1
      this.startedAt = Date.now()
      this.subagents = []
      this.requestStartedAt = null
      this.lastResponseTokensPerSecond = null
      this.completedWorkingStatus = undefined
      this.activeVerb = chooseWorkingVerb()
      this.activeTurnId = randomUUID()
    }
    if (event.type === 'agent_settled') {
      this.subagentGeneration += 1
      this.transcript.finishBash()
      if (this.startedAt !== null) {
        this.completedWorkingStatus = {
          label: `✻ ${chooseCompletionVerb(this.activeTurnId ?? randomUUID())}`,
          elapsedMs: Math.max(0, Date.now() - this.startedAt),
          tokensPerSecond: this.lastResponseTokensPerSecond
        }
      }
      this.startedAt = null
      this.subagents = []
      this.requestStartedAt = null
      this.activeVerb = undefined
      this.activeTurnId = undefined
      queueMicrotask(() => this.drainDeferred())
    }
    if (event.type === 'compaction_start') this.notify('Compacting context…')
    if (event.type === 'compaction_end') {
      this.transcript.bind(this.session)
      if (event.errorMessage) this.notify(event.errorMessage, 'error')
    }
    if (event.type === 'auto_retry_start') {
      this.notify(retryNotice(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage), 'warning')
    }
    if (event.type === 'auto_retry_end' && event.finalError) this.notify(event.finalError, 'error')
    if (event.type === 'summarization_retry_scheduled') {
      this.notify(retryNotice(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage), 'warning')
    }
    if (event.type === 'summarization_retry_attempt_start') {
      const target = event.source === 'branchSummary' ? 'branch summary' : 'context compaction'
      this.notify(`Retrying ${target}…`)
    }
    if (event.type === 'summarization_retry_finished') this.notify('Summarization retry finished.')
    this.transcript.invalidate()
    this.change()
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
      const request = requests.find(item => !this.dismissedDecisions.has(item.requestId))
      if (!request || this.host.hasOverlay()) return
      const abort = new AbortController()
      this.pendingAbort = abort
      this.pendingId = request.requestId
      this.dismissedDecisions.add(request.requestId)
      if (request.type === 'approval') {
        const choice = await this.chooseApproval(request, abort.signal)
        if (!abort.signal.aborted) await this.runtime.approve(request.requestId, choice.decision, choice.alwaysAllow)
      } else {
        const group = request.batchId
          ? requests.filter(item => item.type === 'question' && item.batchId === request.batchId).sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0))
          : [request]
        const answers = await this.showQuestionDock(group as QuestionDockQuestion[], abort.signal)
        if (abort.signal.aborted) return
        if (!answers) { await this.runtime!.interrupt(); return }
        if (request.batchId) await this.runtime.answerBatch(request.batchId, answers)
        else await this.runtime.answer(request.requestId, answers[0]!.answer)
      }
    } catch (error) {
      if (this.pendingId) this.dismissedDecisions.delete(this.pendingId)
      if (!this.stopped) this.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.pendingBusy = false
      this.pendingId = undefined
      this.pendingAbort = undefined
    }
  }

  private async showQuestionDock(questions: QuestionDockQuestion[], signal: AbortSignal): Promise<QuestionDockAnswers | undefined> {
    if (signal.aborted) return undefined
    const dock = new QuestionDockState(questions)
    this.questionDock = dock
    const cancel = () => dock.cancel()
    signal.addEventListener('abort', cancel, { once: true })
    this.change()
    try {
      return await dock.result
    } finally {
      signal.removeEventListener('abort', cancel)
      if (this.questionDock === dock) {
        this.questionDock = undefined
        this.change()
      }
    }
  }

  focusQuestionOption(index: number): void {
    this.input(() => {
      const dock = this.questionDock
      if (!dock) return
      const previous = dock.view
      if (dock.focusOption(index) && (previous.optionIndex !== dock.view.optionIndex || previous.focus !== dock.view.focus)) this.change()
    })
  }

  activateQuestionOption(index: number): void {
    this.input(() => {
      if (this.questionDock?.activateOption(index)) this.change()
    })
  }

  focusQuestionNote(label: string): void {
    this.input(() => {
      if (this.questionDock?.focusNote(label)) this.change()
    })
  }

  setQuestionNote(label: string, text: string): void {
    this.input(() => {
      const dock = this.questionDock
      if (!dock) return
      const option = dock.view.options.find(item => item.label === label)
      if (!option || option.note === text) return
      dock.setNote(label, text)
      this.change()
    })
  }

  focusQuestionAnswer(): void {
    this.input(() => {
      if (!this.questionDock || !this.questionDock.view.allowText || this.questionDock.view.focus === 'answer') return
      this.questionDock.setFocus('answer')
      this.change()
    })
  }

  focusQuestionAction(): void {
    this.input(() => {
      if (!this.questionDock || this.questionDock.view.focus === 'action') return
      this.questionDock.setFocus('action')
      this.change()
    })
  }

  focusQuestionComposer(): void {
    this.input(() => {
      if (!this.questionDock || this.questionDock.view.focus === 'composer') return
      this.questionDock.setFocus('composer')
      this.change()
    })
  }

  setQuestionText(text: string): void {
    this.input(() => this.onSetQuestionText(text))
  }

  private onSetQuestionText(text: string): void {
    const dock = this.questionDock
    if (!dock || dock.view.text === text) return
    dock.setText(text)
    this.change()
  }

  activateQuestionAction(): void {
    this.input(() => this.onActivateQuestionAction())
  }

  private onActivateQuestionAction(): void {
    if (!this.questionDock) return
    this.questionDock.activateAction()
    this.change()
  }

  private handleQuestionKey(key: KeyInput, data: string): boolean {
    const dock = this.questionDock
    if (!dock) return false
    const view = dock.view
    if (key.name === 'escape') {
      dock.cancel()
      this.questionDock = undefined
      this.change()
      return true
    }
    if (key.name === 'tab') {
      dock.focusNext(key.shift)
      this.change()
      return true
    }
    if (view.collapsed || view.focus === 'note' || view.focus === 'answer' || view.focus === 'composer') return false
    if (data === 'x') {
      dock.collapse()
      this.change()
      return true
    }
    if (view.focus === 'options') {
      if (key.name === 'up') dock.moveOption(-1)
      else if (key.name === 'down') dock.moveOption(1)
      else if (key.name === 'left') dock.moveQuestion(-1)
      else if (key.name === 'right') dock.moveQuestion(1)
      else if ((key.name === 'return' || key.name === 'enter') && key.ctrl) dock.activateAction()
      else if (key.name === 'return' || key.name === 'enter') {
        const focused = view.options[view.optionIndex]
        if (!view.multiSelect && focused?.selected) dock.activateAction()
        else dock.toggleOption()
      } else if ((key.name === 'space' || data === ' ') && view.multiSelect) dock.toggleOption()
      else if (/^[1-9]$/u.test(data)) {
        const index = Number(data) - 1
        if (index < view.options.length) dock.toggleOption(index)
      } else return this.replyDirectly(dock, key, data)
      this.change()
      return true
    }
    if (view.focus === 'action') {
      if (key.name === 'return' || key.name === 'enter') dock.activateAction()
      else if (key.name === 'left') dock.moveQuestion(-1)
      else if (key.name === 'right') dock.moveQuestion(1)
      else return this.replyDirectly(dock, key, data)
      this.change()
      return true
    }
    return false
  }

  /**
   * A character the dock has no use for starts a direct reply: the composer takes focus and the
   * character, so typing is never swallowed while the dock holds focus.
   */
  private replyDirectly(dock: QuestionDockState, key: KeyInput, data: string): boolean {
    if (key.ctrl || key.meta || !data || /[\x00-\x1f\x7f]/u.test(data)) return false
    dock.setFocus('composer')
    this.setDraftExternal(`${this.draft}${data}`)
    return true
  }

  private async chooseApproval(request: TerminalDecision, signal: AbortSignal): Promise<{ decision: 'approved' | 'denied'; alwaysAllow: boolean }> {
    if (signal.aborted) return { decision: 'denied', alwaysAllow: false }
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
      const choice = await this.ui!.custom<string | undefined>((tui, theme, _keys, done) => {
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
        const panel = new DialogPanel(`Approve ${tool}?`, list, () => theme, 'Enter choose · Esc deny', details)
        panel.centered = centeredDialogHost(tui)
        return panel
      }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } })
      return { decision: choice === 'once' || choice === 'global' ? 'approved' : 'denied', alwaysAllow: choice === 'global' }
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener)
    }
  }

  private stepThinking(direction: 1 | -1): void {
    const levels = this.session.getAvailableThinkingLevels()
    const next = levels[Math.min(levels.length - 1, Math.max(0, levels.indexOf(this.session.thinkingLevel) + direction))]
    if (!this.session.supportsThinking() || next === undefined || next === this.session.thinkingLevel) return
    this.session.setThinkingLevel(next)
  }

  private extensionShortcut(data: string): boolean {
    const shortcut = [...this.session.extensionRunner.getShortcuts(this.keybindings!.getResolvedBindings()).entries()].find(([key]) => matchesKey(data, key))
    if (!shortcut) return false
    this.attempt(() => shortcut[1].handler(this.session.extensionRunner.createContext()))
    return true
  }

  private invalidateFileCompletion(): void {
    this.fileCompletionRequest += 1
    this.fileCompletion = null
  }

  private async openFileCompletion(cursorOffset: number): Promise<void> {
    const request = ++this.fileCompletionRequest
    const source = this.draft
    const result = await completeFilePaths(source, cursorOffset, this.runtime?.cwd ?? process.cwd())
    if (request !== this.fileCompletionRequest || source !== this.draft || this.stopped || this.paletteOpen) return
    this.fileCompletion = result.items.length ? { ...result, source, index: 0 } : null
    this.change()
  }

  private acceptFileCompletion(index = this.fileCompletion?.index): boolean {
    const completion = this.fileCompletion
    const item = completion?.items[index ?? -1]
    if (!completion || !item || completion.source !== this.draft) return false
    const inserted = formatPathCompletion(item.path, this.bashMode)
    const next = `${completion.source.slice(0, completion.start)}${inserted}${completion.source.slice(completion.end)}`
    const cursorOffset = completion.start + inserted.length
    this.invalidateFileCompletion()
    this.setDraftExternal(next, cursorOffset, true)
    return true
  }

  selectFileCompletion(index: number): void {
    this.input(() => {
      const completion = this.fileCompletion
      if (!completion || !Number.isInteger(index) || index < 0 || index >= completion.items.length || completion.index === index) return
      this.fileCompletion = { ...completion, index }
      this.change()
    })
  }

  activateFileCompletion(index: number): boolean {
    return this.input(() => {
      const completion = this.fileCompletion
      if (!completion || !Number.isInteger(index) || index < 0 || index >= completion.items.length) return false
      this.fileCompletion = { ...completion, index }
      return this.acceptFileCompletion(index)
    })
  }

  private paletteView(): PaletteView | null {
    if (this.paletteSuppressed) return null
    const slash = /^\/([^\s]*)$/u.exec(this.draft)
    const skill = /^\$([^\s]*)$/u.exec(this.draft)
    if (!this.paletteOpen && (this.bashMode || (!slash && !skill))) return null
    let items: PaletteItem[] = []
    try {
      items = skill && !this.paletteOpen
        ? this.commands?.skills().map(item => ({ name: item.name, description: item.description, prefix: '$' as const })) ?? []
        : this.commands?.completions().map(item => ({
            name: item.name,
            ...(item.aliases?.length ? { aliases: item.aliases } : {}),
            description: item.description
          })) ?? []
    } catch { return null }
    const filter = this.paletteOpen ? this.paletteFilter : skill?.[1] ?? slash?.[1] ?? ''
    const matched = matchPalette(items, filter)
    if (!matched.length) return null
    const visible = matched.slice(0, 8)
    const index = Math.min(Math.max(0, this.paletteIndex), visible.length - 1)
    return { items: visible, index }
  }

  selectPaletteItem(index: number): void {
    this.input(() => {
      const palette = this.paletteView()
      if (!palette || !Number.isInteger(index) || index < 0 || index >= palette.items.length || this.paletteIndex === index) return
      this.paletteIndex = index
      this.change()
    })
  }

  activatePaletteItem(index: number): boolean {
    return this.input(() => {
      const palette = this.paletteView()
      if (!palette || !Number.isInteger(index) || index < 0 || index >= palette.items.length) return false
      this.paletteIndex = index
      return this.acceptPalette()
    })
  }

  private acceptPalette(): boolean {
    const palette = this.paletteView()
    const item = palette?.items[palette.index]
    if (!item) return false
    if (item.prefix === '$') return this.insertPalette()
    const preserveDraft = this.paletteOpen && BROWSER_COMMANDS.has(item.name)
    this.paletteOpen = false
    this.paletteSuppressed = true
    this.paletteIndex = 0
    this.draftEpoch += 1
    if (preserveDraft) {
      if (this.commandBusy) { this.notify('Finish or cancel the active command first.', 'error'); return true }
      this.commandBusy = true
      this.attempt(async () => {
        try { await this.commands!.execute(`/${item.name}`) }
        finally { this.commandBusy = false }
      })
      return true
    }
    this.submit(`/${item.name}`)
    return true
  }

  private insertPalette(): boolean {
    const palette = this.paletteView()
    const item = palette?.items[palette.index]
    if (!item) return false
    this.paletteOpen = false
    this.paletteSuppressed = true
    this.paletteIndex = 0
    this.setDraftExternal(`${item.prefix ?? '/'}${item.name} `)
    return true
  }

  private openPalette(): void {
    this.invalidateFileCompletion()
    this.paletteOpen = true
    this.paletteSuppressed = false
    this.paletteFilter = this.draft.startsWith('/') && !/\s/u.test(this.draft) ? this.draft.slice(1) : ''
    this.paletteIndex = 0
    this.draftEpoch += 1
    this.change()
  }

  setDraft(value: string): void {
    if (this.paletteOpen) {
      this.paletteFilter = value.startsWith('/') && !/\s/u.test(value) ? value.slice(1) : value
      this.paletteIndex = 0
      this.paletteSuppressed = false
      this.change()
      return
    }
    let modeChanged = false
    if (!this.bashMode) {
      const bash = splitBashDraft(value)
      if (bash.bashMode) {
        modeChanged = true
        this.applyComposerMode('bash')
      }
      value = bash.body
    }
    if (value === this.draft) {
      if (modeChanged) this.change()
      return
    }
    this.historyIndex = undefined
    this.invalidateFileCompletion()
    this.draftCursorOffset = null
    this.draft = value
    this.attachments.retain(value)
    if (this.paletteOpen) this.paletteFilter = value.startsWith('/') && !/\s/u.test(value) ? value.slice(1) : value
    this.paletteSuppressed = false
    this.paletteIndex = 0
    this.syncDraft(value)
    this.change()
  }

  setDraftExternal(value: string, cursorOffset?: number, preserveBashMode = false): void {
    const bash = preserveBashMode ? { body: value, bashMode: this.bashMode } : splitBashDraft(value)
    this.invalidateFileCompletion()
    this.applyComposerMode(bash.bashMode ? 'bash' : this.planMode ? 'plan' : 'normal')
    const body = bash.body
    this.draft = body
    this.attachments.retain(body)
    this.draftCursorOffset = cursorOffset ?? null
    this.draftEpoch += 1
    this.paletteSuppressed = false
    this.paletteIndex = 0
    this.updateCustomEditor(body)
    this.syncDraft(body)
    this.change()
  }

  private switchComposerMode(mode: 'normal' | 'plan' | 'bash'): Promise<void> {
    const wasPlanMode = this.planMode
    this.planMode = mode === 'plan'
    this.bashMode = mode === 'bash'
    if (wasPlanMode === this.planMode) return Promise.resolve()
    return this.runtime?.setMode(this.planMode ? 'plan' : 'normal') ?? Promise.resolve()
  }

  private applyComposerMode(mode: 'normal' | 'plan' | 'bash'): void {
    void this.switchComposerMode(mode).catch(error => this.notify(error instanceof Error ? error.message : String(error), 'error'))
  }

  private enterBashMode(body: string): void {
    this.planChoice.clear()
    this.invalidateFileCompletion()
    this.applyComposerMode('bash')
    this.draft = body
    this.draftCursorOffset = null
    this.draftEpoch += 1
    this.paletteSuppressed = false
    this.paletteIndex = 0
    this.updateCustomEditor(body)
    this.syncDraft(body)
    this.change()
  }

  private exitBashMode(): void {
    this.invalidateFileCompletion()
    this.applyComposerMode('normal')
    this.draftCursorOffset = null
    this.change()
  }

  private clearDraft(): void {
    this.historyIndex = undefined
    this.invalidateFileCompletion()
    this.applyComposerMode(this.planMode ? 'plan' : 'normal')
    this.draft = ''
    this.attachments.clear()
    this.draftCursorOffset = null
    this.draftEpoch += 1
    this.paletteSuppressed = false
    this.paletteIndex = 0
    this.updateCustomEditor('')
    this.syncDraft('')
    this.change()
  }

  private updateCustomEditor(value: string): void {
    if (!this.customEditor) return
    try { this.customEditor.setText(value) }
    catch (error) { this.notify(`The custom editor could not be updated: ${error instanceof Error ? error.message : String(error)}`, 'error') }
  }

  private syncDraft(text: string): void {
    this.pendingDraft = text.length > 0
    if (this.draftSyncing) return
    this.draftSyncing = true
    this.draftSync = this.flushDraftSync()
  }

  private async flushDraftSync(): Promise<void> {
    try {
      while (this.pendingDraft !== undefined) {
        const dirty = this.pendingDraft
        this.pendingDraft = undefined
        try { await controlCall('terminal.draft', { dirty }) }
        catch (error) { this.notify(String(error), 'error') }
      }
    } finally {
      this.draftSyncing = false
    }
  }

  /** Enter queues the prompt behind a running reply; Cmd/Alt+Enter steers it (see `app.message.steer`). */
  submitPrompt(): void {
    this.input(() => this.onSubmitPrompt())
  }

  private onSubmitPrompt(): void {
    this.submit(this.bashMode ? `!${this.draft}` : this.draft, true)
  }

  private async runBash(text: string): Promise<void> {
    const command = /^\s*!\s*([\s\S]+)$/u.exec(text)?.[1]?.trim()
    if (!command) throw new Error('Enter a Bash command after !.')
    this.transcript.beginBash(command)
    this.change()
    try {
      await this.runtime!.submit(text, false)
    } finally {
      this.transcript.finishBash()
      this.change()
    }
  }

  private submit(draft: string, followUp = false): void {
    if (!draft.trim() || !this.initialized) return
    const { text, images: attached } = this.attachments.expand(draft)
    const images = attached.length ? attached : undefined
    this.planChoice.clear()
    if (/^\/plan\s*$/u.test(text)) {
      this.historyIndex = undefined
      this.clearDraft()
      this.togglePlanMode()
      return
    }
    if (this.commandBusy) { this.notify('Finish or cancel the active command first.', 'error'); return }
    const bang = /^\s*!\s*([\s\S]+)$/u.exec(text)
    const bangMode = text.trimStart().startsWith('!')
    if (bangMode && !bang?.[1]?.trim()) { this.notify('Enter a Bash command after !.', 'error'); return }
    const command = text.trimStart().startsWith('/')
    if (images && (command || bangMode)) this.notify('Images are only sent with a message; this one runs without them.', 'warning')
    if (command) this.commandBusy = true
    this.historyIndex = undefined
    this.clearDraft()
    this.attempt(async () => {
      try {
        await this.draftSync
        if (this.stopped) return
        if (command && await this.commands!.execute(text)) return
        if (bangMode) {
          if (this.planBarrierOpen || !this.session.isIdle) {
            this.planBarrierOpen = true
            this.deferredInputs.push({ kind: 'bash', text })
            this.notify('Bash command queued to run by itself after the current response.')
            this.change()
            return
          }
          await this.runBash(text)
          return
        }
        if (this.planMode && !command) { this.enqueuePlan(text, images); return }
        const expanded = this.commands!.expandSkill(text)
        if (this.planBarrierOpen) {
          this.deferredInputs.push({ kind: 'prompt', text: expanded, followUp, images })
          this.notify('Message queued to run after the current response.')
          this.change()
          return
        }
        if (!this.session.isIdle) this.notify(followUp ? 'Follow-up message queued.' : 'Steering message queued.')
        await this.runtime!.submit(expanded, followUp, images)
      } finally { if (command) this.commandBusy = false }
    })
  }

  private togglePlanMode(): void {
    this.applyComposerMode(this.planMode ? 'normal' : 'plan')
    this.change()
  }

  /** Offers the reply's plan once a plan run ends cleanly with nothing queued behind it. */
  private offerPlan(): void {
    if (this.deferredInputs.length) return
    const last = this.session.messages.at(-1) as { role?: string; stopReason?: string } | undefined
    if (last?.role !== 'assistant' || last.stopReason === 'error' || last.stopReason === 'aborted') return
    const plan = parseProposedPlan(this.session.getLastAssistantText() ?? '')
    if (plan?.complete) this.planChoice.show(plan.title)
  }

  /** Leaves plan mode, then runs the plan. The plan is already in the conversation, so the prompt only names it. */
  private implementPlan(title: string): void {
    this.planChoice.clear()
    this.attempt(async () => {
      if (this.planMode) {
        await this.switchComposerMode('normal')
        this.change()
      }
      this.submit(`Implement the plan: ${title}`)
    })
  }

  /** Stays in plan mode so the next message revises the plan. */
  private editPlan(): void {
    this.planChoice.clear()
    if (!this.planMode) this.togglePlanMode()
    this.notify('Describe what to change. Your next message revises the plan.')
  }

  private enqueuePlan(brief: string, images?: TerminalImage[]): void {
    const text = brief.trim()
    if (!text) { this.notify('Use /plan <plan brief>.', 'error'); return }
    const waiting = !this.session.isIdle
    this.planBarrierOpen = true
    this.deferredInputs.push({ kind: 'plan', text, images })
    this.notify(waiting
      ? 'Plan request queued to run by itself after the current response.'
      : 'Plan request queued as an isolated run.')
    this.change()
    this.drainDeferred()
  }

  private drainDeferred(): void {
    if (this.drainingDeferred || !this.planBarrierOpen || !this.runtime || !this.session.isIdle || !this.deferredInputs.length) return
    this.drainingDeferred = true
    void (async () => {
      try {
        while (this.deferredInputs.length && !this.stopped && this.runtime && this.session.isIdle) {
          const next = this.deferredInputs.shift()!
          this.activeDeferredKind = next.kind
          this.change()
          try {
            if (next.kind === 'plan') {
              this.planActive = true
              await this.runtime.submitPlan(next.text, next.images)
              this.offerPlan()
            } else if (next.kind === 'bash') {
              await this.runBash(next.text)
            } else {
              await this.runtime.submit(next.text, next.followUp, next.images)
            }
          } catch (error) {
            this.notify(error instanceof Error ? error.message : String(error), 'error')
          } finally {
            if (next.kind === 'plan') this.planActive = false
            this.activeDeferredKind = undefined
          }
        }
      } finally {
        this.drainingDeferred = false
        if (!this.deferredInputs.length && !this.planActive) this.planBarrierOpen = false
        this.change()
        if (this.deferredInputs.length && this.runtime?.session.isIdle) this.drainDeferred()
      }
    })()
  }

  private promptHistory(): string[] {
    return this.transcript.view().items.flatMap(item =>
      item.kind === 'user' && item.text.trim() ? [item.text] : []
    )
  }

  private historyPrevious(): void {
    const history = this.promptHistory()
    if (!history.length) return
    const next = this.historyIndex === undefined ? history.length - 1 : Math.max(0, this.historyIndex - 1)
    this.historyIndex = next
    this.setDraftExternal(history[next] ?? '')
  }

  private historyNext(): void {
    const history = this.promptHistory()
    if (this.historyIndex === undefined) return
    const next = this.historyIndex + 1
    if (next >= history.length) {
      this.historyIndex = undefined
      this.setDraftExternal('')
      return
    }
    this.historyIndex = next
    this.setDraftExternal(history[next] ?? '')
  }

  handleMouse(event: OpenTuiMouseInput): boolean {
    if (this.stopped || !this.host.hasOverlay()) return false
    return this.input(() => this.host.sendMouseToOverlay(event))
  }

  selectPlanChoice(index: number): void {
    this.input(() => {
      if (this.draft !== '' || this.paletteView() || this.planChoice.view?.index === index) return
      if (this.planChoice.select(index)) this.change()
    })
  }

  activatePlanChoice(index: number): boolean {
    return this.input(() => {
      if (this.draft !== '' || this.paletteView() || !this.planChoice.select(index)) return false
      const choice = this.planChoice.view
      if (!choice) return false
      if (index === 0) this.implementPlan(choice.title)
      else this.editPlan()
      return true
    })
  }

  handleKey(key: KeyInput): boolean {
    return this.input(() => this.onHandleKey(key))
  }

  private onHandleKey(key: KeyInput): boolean {
    if (this.stopped) return true
    this.statistics = undefined
    if (this.host.hasOverlay()) return this.host.sendToOverlay(key.sequence)
    if (this.customEditor) { this.customEditor.handleInput(key.sequence); return true }
    const routed = this.host.emitInput(key.sequence)
    if (routed?.consume) return true
    const data = routed?.data ?? key.sequence
    if (this.handleQuestionKey(key, data)) return true
    const palette = this.paletteView()
    if (palette) {
      if (key.name === 'up') { this.paletteIndex = (palette.index - 1 + palette.items.length) % palette.items.length; this.change(); return true }
      if (key.name === 'down') { this.paletteIndex = (palette.index + 1) % palette.items.length; this.change(); return true }
      if (key.name === 'return' || key.name === 'enter') return this.acceptPalette()
      if (key.name === 'tab') return key.shift ? true : this.insertPalette()
      if (key.name === 'escape' || (this.paletteOpen && key.ctrl && key.name === 'c')) {
        this.paletteOpen = false; this.paletteSuppressed = true; this.paletteIndex = 0; this.draftEpoch += 1; this.change(); return true
      }
    }
    const choice = this.planChoice.view
    if (choice && !palette) {
      const action = this.planChoice.handle(key, this.draft === '')
      if (action === 'implement') { this.implementPlan(choice.title); return true }
      if (action === 'edit') { this.editPlan(); return true }
      if (action === 'dismiss') { this.planChoice.clear(); this.change(); return true }
      if (action === 'moved') { this.change(); return true }
    }
    if (!this.paletteOpen && !this.bashMode && this.draft.trim() === '' && data.startsWith('!')) {
      this.enterBashMode(data.slice(1))
      return true
    }
    if (!this.paletteOpen && this.bashMode && this.draft === '' && (
      data === '\x7f' || data === '\b' || data === '\x1b[3~' || key.name === 'backspace' || key.name === 'delete'
    )) {
      this.exitBashMode()
      return true
    }
    const fileCompletion = this.fileCompletion
    const unmodified = !key.ctrl && !key.meta && !key.shift && !key.option && !key.super
    if (fileCompletion && key.name === 'tab' && key.shift) {
      this.invalidateFileCompletion()
      this.togglePlanMode()
      return true
    }
    if (fileCompletion && unmodified && key.name === 'up') {
      this.fileCompletion = { ...fileCompletion, index: (fileCompletion.index - 1 + fileCompletion.items.length) % fileCompletion.items.length }
      this.change()
      return true
    }
    if (fileCompletion && unmodified && key.name === 'down') {
      this.fileCompletion = { ...fileCompletion, index: (fileCompletion.index + 1) % fileCompletion.items.length }
      this.change()
      return true
    }
    if (fileCompletion && unmodified && (key.name === 'return' || key.name === 'enter' || key.name === 'tab')) return this.acceptFileCompletion()
    if (fileCompletion && unmodified && key.name === 'escape') {
      this.invalidateFileCompletion()
      this.change()
      return true
    }
    if (key.ctrl && key.name === 'up') { this.historyPrevious(); return true }
    if (key.ctrl && key.name === 'down') { this.historyNext(); return true }
    const plainArrow = !key.ctrl && !key.meta && !key.shift && !key.option && !key.super
    if (plainArrow && key.name === 'up' && this.draft === '') {
      this.historyPrevious()
      return true
    }
    if (plainArrow && key.name === 'down' && this.draft === '' && this.historyIndex !== undefined) {
      this.historyNext()
      return true
    }
    if (key.name === 'tab' && !key.shift) {
      if (!this.paletteOpen) this.attempt(() => this.openFileCompletion(key.cursorOffset ?? this.draft.length))
      return true
    }
    if (key.name === 'tab' && key.shift) { this.togglePlanMode(); return true }
    if (key.name === 'pageup' || key.name === 'pagedown' || (key.ctrl && (key.name === 'home' || key.name === 'end'))) return false
    const is = (action: string): boolean => {
      try { return this.keybindings!.matches(data, action as Parameters<ReturnType<typeof terminalKeybindings>['matches']>[1]) }
      catch { return false }
    }
    if (is('app.commands')) this.openPalette()
    else if (is('app.interrupt')) {
      if (this.sideQuestion?.visible) void this.sideQuestion.dismiss()
      else this.attempt(() => this.runtime!.interrupt())
    } else if (is('app.clear')) {
      if (this.session.isStreaming) this.attempt(() => this.runtime!.interrupt())
      else if (this.draft) this.clearDraft()
      else void this.shutdown()
    } else if (is('app.exit') && this.draft === '') void this.shutdown()
    else if (is('app.thinking.cycle')) this.session.cycleThinkingLevel()
    else if (is('app.thinking.increase') || is('app.thinking.decrease')) this.stepThinking(is('app.thinking.increase') ? 1 : -1)
    else if (is('app.thinking.save')) this.session.setThinkingLevel(this.session.thinkingLevel, { persist: true })
    else if (is('app.model.cycleForward') || is('app.model.cycleBackward')) this.attempt(() => this.session.cycleModel(is('app.model.cycleBackward') ? 'backward' : 'forward'))
    else if (is('app.model.select')) this.attempt(() => this.commands!.execute('/model'))
    else if (is('app.tools.expand')) this.ui!.setToolsExpanded(!this.toolsExpanded)
    else if (is('app.thinking.toggle')) {
      const hidden = !this.session.settingsManager.getHideThinkingBlock()
      this.session.settingsManager.setHideThinkingBlock(hidden)
      this.transcript.setThinkingHidden(hidden)
    } else if (is('app.message.steer')) {
      const editor = this.customEditor as (EditorComponent & { getExpandedText?(): string }) | undefined
      this.submit(editor?.getExpandedText?.() ?? (this.bashMode ? `!${this.draft}` : this.draft), false)
    }
    else if (is('app.message.dequeue')) {
      const pending = this.session.clearQueue()
      const deferred = this.deferredInputs.map(input => input.kind === 'plan' ? `/plan ${input.text}` : input.text)
      if (this.deferredInputs.some(input => input.kind !== 'bash' && input.images?.length)) this.notify('Images on queued messages were dropped; paste them again.', 'warning')
      this.deferredInputs = []
      this.planBarrierOpen = this.planActive || this.activeDeferredKind === 'plan'
      this.setDraftExternal([...pending.steering, ...pending.followUp, ...deferred, this.draft].filter(Boolean).join('\n'))
    } else if (is('app.editor.external')) this.attempt(() => this.externalEditor())
    else if (is('app.message.copy')) this.attempt(() => this.commands!.execute('/copy'))
    // Cmd+V arrives as a key only in terminals that forward it; most paste on their own.
    else if (is('app.clipboard.pasteImage') || (key.super && key.name === 'v' && !key.ctrl && !key.meta)) this.attempt(() => this.pasteClipboard())
    else if (is('app.suspend')) this.attempt(() => this.suspend())
    else if (is('app.session.new')) this.attempt(() => this.commands!.execute('/new'))
    else if (data === '?' && this.draft === '') this.notify(this.hotkeys())
    else if (!this.extensionShortcut(data)) return false
    this.change()
    return true
  }

  private hotkeys(): string {
    return [
      'Tab files/folders · Shift+Tab plan mode', 'Shift+↑/↓ effort · /effort · Ctrl+K commands', 'Ctrl+O expand details · Ctrl+T thinking',
      'Ctrl+L model', 'Ctrl+N new session', '↑ recalls when empty · Ctrl+↑/↓ browse history',
      'Enter send or queue · Cmd+Enter steer · Esc dismisses btw or stops reply', 'Ctrl+C clear or quit · Ctrl+D quit',
      'PgUp/PgDn transcript'
    ].join('\n')
  }

  private working(): OpenTuiView['working'] {
    const active = this.startedAt !== null
    if (!active && this.completedWorkingStatus) {
      return { active: false, frame: '', ...this.completedWorkingStatus }
    }
    const state = this.ui?.state
    const label = active
      ? state?.workingVisible === false ? '' : state?.workingMessage ?? this.activeVerb ?? 'Working…'
      : ''
    const indicator = state?.workingIndicator
    const frames = indicator?.frames ?? getWorkingSpinnerFrames(process.env.TERM)
    const elapsedMs = this.startedAt !== null ? Math.max(0, Date.now() - this.startedAt) : null
    const frame = active && this.startedAt !== null
      ? spinnerFrameAt(Date.now() - this.startedAt, frames, indicator?.intervalMs ?? SPINNER_INTERVAL_MS)
      : ''
    return {
      active,
      frame,
      label,
      elapsedMs,
      tokensPerSecond: this.lastResponseTokensPerSecond
    }
  }

  private componentLines(component: Mounted | undefined, width: number): AnsiLine[] | undefined {
    if (!component) return undefined
    try { return parseAnsi(component.render(Math.max(1, width)).join('\n')) }
    catch (error) { return parseAnsi(`Component could not be drawn: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** The session's snapshot and token totals; reused between the deltas of one streamed message. */
  private sessionStatistics(): NonNullable<OpenTuiApplication['statistics']> {
    const now = performance.now()
    if (this.startedAt !== null && this.statistics && now - this.statistics.at < STATISTICS_INTERVAL_MS) return this.statistics
    const snapshot = this.runtime?.snapshot()
    let inputTokens = 0
    let cacheReadTokens = 0
    let outputTokens = 0
    try {
      const usage = this.session.getSessionStats().tokens
      cacheReadTokens = usage.cacheRead ?? 0
      inputTokens = (usage.input ?? 0) + cacheReadTokens
      outputTokens = usage.output ?? 0
    } catch { /* A session being replaced has no statistics for a frame. */ }
    return this.statistics = { at: now, snapshot, inputTokens, cacheReadTokens, outputTokens }
  }

  view(): OpenTuiView {
    const { snapshot, inputTokens, cacheReadTokens, outputTokens } = this.sessionStatistics()
    const transcript = this.transcript.view()
    const width = Math.max(20, this.host.columns - 4)
    const above: AnsiLine[][] = []
    const below: AnsiLine[][] = []
    if (this.subagents.length) above.push(subagentsWidget(this.subagents, width, this.theme))
    for (const widget of this.widgets.values()) {
      const lines = this.componentLines(widget.component, width)
      if (lines) (widget.placement === 'belowEditor' ? below : above).push(lines)
    }
    return {
      // Single-line notices can accompany the welcome; multiline output such as /help takes over the transcript.
      home: !transcript.hasMultilineNotice && transcript.items.every(item => item.kind === 'notice'),
      sessionName: snapshot?.name,
      cwd: snapshot?.cwd ?? process.cwd(),
      branch: this.branch,
      account: snapshot?.account?.label,
      model: snapshot?.model,
      thinking: snapshot?.thinkingLevel ?? 'off',
      contextPercent: snapshot?.context.percent ?? null,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      subscription: snapshot?.subscription ?? false,
      items: transcript.items,
      hasUserMessages: transcript.hasUserMessages,
      draft: this.paletteOpen ? this.paletteFilter : this.draft,
      draftEpoch: this.draftEpoch,
      draftCursorOffset: this.draftCursorOffset,
      attachments: this.attachments.labels(),
      insertion: this.insertion,
      bashMode: this.bashMode,
      planMode: this.planMode,
      planChoice: this.draft === '' && !this.bashMode ? this.planChoice.view : null,
      questionDock: this.questionDock?.view ?? null,
      working: { ...this.working(), sessionName: snapshot?.name },
      statuses: [...this.statuses.values()],
      linkHovered: this.hoveredLink !== null,
      toast: this.toastMessage ?? null,
      palette: this.paletteView(),
      fileCompletion: this.fileCompletion,
      overlay: this.host.overlay(),
      customEditor: this.customEditor ? this.componentLines(this.customEditor as Mounted, width) : undefined,
      header: this.componentLines(this.header, width),
      footer: this.componentLines(this.footer, width),
      widgets: { above, below },
      toolsExpanded: this.toolsExpanded
    }
  }

  /** A bracketed paste from the terminal (Cmd+V, drag and drop) reaching the composer. */
  paste(text: string): void {
    this.attempt(() => this.handlePaste(text))
  }

  private async handlePaste(text: string): Promise<void> {
    // Terminals paste nothing when the clipboard holds only an image, so read it ourselves.
    if (!text.trim()) return this.pasteClipboard()
    const paths = parsePastedImagePaths(text, existsSync)
    if (paths) return this.attachImageFiles(paths)
    this.pasteText(text)
  }

  private async pasteClipboard(): Promise<void> {
    const adapter = await loadPiAdapter()
    const files = await adapter.readClipboardFilePaths()
    if (files?.length) {
      if (files.some(file => /[\x00-\x1f\x7f]/u.test(file))) throw new Error('Clipboard file paths contain control characters.')
      const images = files.filter(file => imageMimeTypeForPath(file))
      const others = files.filter(file => !imageMimeTypeForPath(file))
      if (images.length) await this.attachImageFiles(images)
      if (others.length) this.insert(others.join('\n'))
      return
    }
    const image = await adapter.readClipboardImage()
    if (image) return this.attachImage(image.bytes, image.mimeType)
    const text = await adapter.readClipboardText()
    if (text?.trim()) {
      const paths = parsePastedImagePaths(text, existsSync)
      if (paths) return this.attachImageFiles(paths)
      this.pasteText(text)
    }
  }

  private pasteText(text: string): void {
    const normalized = text.replace(/\r\n?/gu, '\n')
    if (!isLargePaste(normalized) || this.customEditor) { this.insert(normalized); return }
    this.insert(this.attachments.addText(normalized).label)
  }

  private async attachImageFiles(paths: string[]): Promise<void> {
    const staged = await stageClipboardFiles(paths)
    if (staged.cleanup) this.cleanup.push(staged.cleanup)
    for (const path of staged.paths) {
      const mimeType = imageMimeTypeForPath(path)
      if (!mimeType) continue
      await this.attachImage(await readFile(path), mimeType)
    }
  }

  private async attachImage(bytes: Uint8Array, mimeType: string): Promise<void> {
    if (this.customEditor) throw new Error('This editor does not take images.')
    if (this.bashMode) throw new Error('Images cannot be attached to a Bash command.')
    const model = this.session.model
    if (model && !model.input.includes('image')) throw new Error(`${model.name || model.id} does not accept images. Choose another model with /model.`)
    const resized = await resizeImage(bytes, mimeType)
    if (!resized && bytes.byteLength > MAX_UNRESIZED_IMAGE_BYTES) throw new Error('The image is too large to send.')
    const item = this.attachments.addImage(resized?.data ?? Buffer.from(bytes).toString('base64'), resized?.mimeType ?? mimeType)
    this.insert(`${item.label} `)
  }

  /** Inserts at the composer's cursor; the composer reports the new draft back. */
  private insert(text: string): void {
    if (!text) return
    if (this.customEditor?.getExpandedText) {
      const editor = this.customEditor as { insertTextAtCursor?(value: string): void }
      if (editor.insertTextAtCursor) { editor.insertTextAtCursor(text); this.change(); return }
    }
    if (this.customEditor) { this.setDraftExternal(`${this.customEditor.getText()}${text}`); return }
    this.insertion = { epoch: (this.insertion?.epoch ?? 0) + 1, text }
    this.change()
  }

  private async externalEditor(): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR
    if (!editor) throw new Error('Set VISUAL or EDITOR to open an external editor.')
    const renderer = this.renderer
    if (!renderer) throw new Error('The terminal renderer is not ready.')
    const directory = await mkdtemp(join(tmpdir(), 'harness-editor-'))
    const file = join(directory, 'prompt.md')
    try {
      await writeFile(file, this.customEditor?.getExpandedText?.() ?? this.draft, { mode: 0o600 })
      await renderer.suspend()
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.env.SHELL || '/bin/sh', ['-c', `${editor} "$1"`, 'harness-editor', file], { stdio: 'inherit' })
          child.once('error', reject)
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Editor exited with ${code}.`)))
        })
      } finally {
        await renderer.resume()
      }
      this.setDraftExternal(await readFile(file, 'utf8'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async suspend(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Suspending is unavailable on Windows.')
    if (!this.renderer) throw new Error('The terminal renderer is not ready.')
    await this.renderer.suspend()
    process.kill(process.pid, 'SIGTSTP')
  }

  shutdown(): Promise<void> {
    return this.closing ??= (async () => {
      const protect = (action: () => void | Promise<void>) => {
        try {
          const result = action()
          if (result instanceof Promise) result.catch(error => { this.failure ??= error instanceof Error ? error : new Error(String(error)) })
        } catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
      }
      this.stopped = true
      protect(() => this.renderer?.setMousePointer('default'))
      this.hoveredLink = null
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = undefined
      if (this.publishTimer) clearTimeout(this.publishTimer)
      this.publishTimer = undefined
      protect(() => this.pendingAbort?.abort())
      protect(() => { this.questionDock?.cancel(); this.questionDock = undefined })
      protect(() => { void this.sideQuestion?.dismiss() })
      protect(() => this.ui?.dispose())
      try { await this.runtime?.dispose() }
      catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
      finally {
        for (const cleanup of this.cleanup.splice(0)) {
          try { await cleanup() }
          catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
        }
        protect(() => this.transcript.clear())
        protect(() => this.release(this.header))
        protect(() => this.release(this.footer))
        for (const widget of this.widgets.values()) protect(() => this.release(widget.component))
        this.widgets.clear()
        protect(() => this.release(this.customEditor as Mounted | undefined))
        protect(() => this.host.dispose())
        try { this.stopHandler?.() }
        catch (error) { this.failure ??= error instanceof Error ? error : new Error(String(error)) }
        this.finish()
      }
    })()
  }
}

export function runOpenTuiFrontend(args: string[]): OpenTuiApplication {
  return new OpenTuiApplication(args)
}
