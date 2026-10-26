import type {
  Component, OverlayBounds, OverlayHandle, OverlayOptions, Terminal, TerminalColors,
  TuiInputListener, TuiInputListenerResult, TUI, TuiMode, TuiStopOptions
} from '@earendil-works/pi-tui'

import { centeredRect, dialogFits, dialogRows, dialogWidth, type HarnessOverlayOptions } from '../tui/dialogGeometry'
import type { TerminalMouseInput } from '../tui/mouse'
import type { OpenTuiMouseInput } from './mouse'
import { parseAnsi, type AnsiLine } from './ansi'

export interface OverlayView {
  width: number
  maxHeight?: number
  fullscreen: boolean
  /** A page presented as a centered dialog rather than a full-screen surface. */
  dialog: boolean
  bounds: OverlayBounds
  contentInset: { x: number; y: number }
  lines: AnsiLine[]
}

interface OverlayEntry {
  component: Component
  options: OverlayOptions
  hidden: boolean
  bounds?: OverlayBounds
  contentInset?: { x: number; y: number }
}

function resolveSize(value: number | `${number}%` | undefined, total: number, fallback: number): number {
  if (typeof value === 'number') return Math.max(1, Math.min(total, Math.trunc(value)))
  if (typeof value === 'string' && value.endsWith('%')) {
    const percent = Number.parseFloat(value)
    if (Number.isFinite(percent)) return Math.max(1, Math.min(total, Math.trunc(total * percent / 100)))
  }
  return Math.max(1, Math.min(total, fallback))
}

/**
 * The small TUI surface Pi's dialogs, pages and editors need. Nothing is drawn here: the Solid
 * application renders `overlay()` and forwards raw key sequences from OpenTUI.
 */
export class PiDialogHost {
  readonly children: Component[] = []
  /** Pages marked `dialog: 'page'` render as centered dialogs, not full-screen surfaces. */
  readonly centeredDialogs = true
  readonly mode: TuiMode = 'fullscreen'
  readonly fullRedraws = 0
  readonly terminal: Terminal
  columns: number
  rows: number
  onTitle?: (title: string) => void
  private overlayStack: OverlayEntry[] = []
  private inputListeners = new Set<TuiInputListener>()
  private colorListeners = new Set<(scheme: 'dark' | 'light') => void>()

  constructor(private readonly changed: () => void) {
    this.columns = Math.max(1, process.stdout.columns ?? 80)
    this.rows = Math.max(1, process.stdout.rows ?? 24)
    const host = this
    this.terminal = {
      get columns() { return host.columns },
      get rows() { return host.rows },
      get kittyProtocolActive() { return false },
      start() {},
      stop() {},
      drainInput: async () => {},
      write() {},
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle(title: string) { host.onTitle?.(title) },
      setProgress() {},
      setProgramStatus() {}
    }
  }

  resize(columns: number, rows: number): void {
    const nextColumns = Math.max(1, Math.trunc(columns))
    const nextRows = Math.max(1, Math.trunc(rows))
    if (nextColumns === this.columns && nextRows === this.rows) return
    this.columns = nextColumns
    this.rows = nextRows
    for (const entry of this.overlayStack) entry.component.invalidate()
    this.changed()
  }

  addChild(component: Component): void {
    this.children.push(component)
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component)
    if (index >= 0) this.children.splice(index, 1)
  }

  clear(): void {
    this.children.length = 0
  }

  getShowHardwareCursor(): boolean { return false }
  setShowHardwareCursor(): void {}
  getClearOnShrink(): boolean { return true }
  setClearOnShrink(): void {}
  setFocus(): void {}
  invalidate(): void {
    this.top()?.component.invalidate()
    this.changed()
  }

  private top(): OverlayEntry | undefined {
    for (let index = this.overlayStack.length - 1; index >= 0; index -= 1) {
      const entry = this.overlayStack[index]
      if (entry && !entry.hidden) return entry
    }
    return undefined
  }

  showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const entry: OverlayEntry = { component, options, hidden: false }
    this.overlayStack.push(entry)
    this.changed()
    const handle: OverlayHandle = {
      hide: () => {
        const index = this.overlayStack.indexOf(entry)
        if (index < 0) return
        this.overlayStack.splice(index, 1)
        try { component.invalidate() } catch { /* A hidden overlay cannot affect the page. */ }
        this.changed()
      },
      setHidden: hidden => {
        if (!this.overlayStack.includes(entry)) return
        entry.hidden = hidden
        this.changed()
      },
      isHidden: () => entry.hidden,
      focus: () => {},
      unfocus: () => {},
      isFocused: () => this.top() === entry,
      getBounds: () => entry.bounds
    }
    return handle
  }

  hideOverlay(): void {
    const entry = this.top()
    if (!entry) return
    this.overlayStack.splice(this.overlayStack.indexOf(entry), 1)
    this.changed()
  }

  hasOverlay(): boolean {
    return !!this.top()
  }

  start(): void {}
  stop(_options?: TuiStopOptions): void {}
  renderNow(): void { this.changed() }
  requestRender(): void { this.changed() }

  addInputListener(listener: TuiInputListener): () => void {
    this.inputListeners.add(listener)
    return () => { this.inputListeners.delete(listener) }
  }

  removeInputListener(listener: TuiInputListener): void {
    this.inputListeners.delete(listener)
  }

  onTerminalColorSchemeChange(listener: (scheme: 'dark' | 'light') => void): () => void {
    this.colorListeners.add(listener)
    return () => { this.colorListeners.delete(listener) }
  }

  setTerminalColorSchemeNotifications(): void {}

  queryTerminalColors(): Promise<TerminalColors> {
    return Promise.resolve({ palette: [] })
  }

  /** Extension input handlers run before the focused surface, as they do in Pi. */
  emitInput(data: string): TuiInputListenerResult {
    let current = data
    for (const listener of this.inputListeners) {
      const result = listener(current)
      if (!result) continue
      if (result.consume) return result
      if (typeof result.data === 'string') current = result.data
    }
    return current === data ? undefined : { data: current }
  }

  /** Routes a raw key sequence to the current overlay. */
  sendToOverlay(data: string): boolean {
    const entry = this.top()
    if (!entry) return false
    try { entry.component.handleInput?.(data) }
    catch { /* A dialog that cannot handle a key stays open. */ }
    this.changed()
    return true
  }

  /** Routes pasted text through Pi's bracketed-paste input protocol. */
  sendPasteToOverlay(text: string): boolean {
    if (!text) return false
    return this.sendToOverlay(`\x1b[200~${text}\x1b[201~`)
  }

  sendMouseToOverlay(event: OpenTuiMouseInput): boolean {
    const entry = this.top()
    if (!entry) return false
    const bounds = entry.bounds ?? this.overlay()?.bounds
    if (!bounds) return false
    const inset = entry.contentInset ?? { x: 0, y: 0 }
    const x = event.x - bounds.col - inset.x
    const y = event.y - bounds.row - inset.y
    const width = Math.max(0, bounds.width - inset.x * 2)
    const height = Math.max(0, bounds.height - inset.y * 2)
    const inside = x >= 0 && y >= 0 && x < width && y < height
    const type = event.type === 'move' ? 'move' : event.type === 'scroll' ? 'wheel' : 'click'
    if (type !== 'move' && !inside) return false
    const normalized: TerminalMouseInput = {
      type,
      button: event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'none',
      x,
      y,
      screenX: event.x,
      screenY: event.y,
      width,
      height,
      shift: event.modifiers.shift,
      alt: event.modifiers.alt,
      ctrl: event.modifiers.ctrl,
      ...(type === 'wheel' ? {
        wheelDelta: (event.scroll?.direction === 'up' || event.scroll?.direction === 'left' ? -1 : 1) * Math.max(1, event.scroll?.delta ?? 1)
      } : {})
    }
    const mouseAware = entry.component as Component
    try {
      const result = mouseAware.handleMouse?.(normalized)
      if (result?.render) this.changed()
      return result?.handled === true
    } catch {
      return false
    }
  }

  overlay(): OverlayView | undefined {
    const entry = this.top()
    if (!entry) return undefined
    const options = entry.options
    if (options.visible && !options.visible(this.columns, this.rows)) return undefined
    const page = (options as HarnessOverlayOptions).dialog === 'page'
    const dialog = page && dialogFits(this.columns, this.rows)
    const width = dialog ? dialogWidth(this.columns) : resolveSize(options.width, this.columns, Math.min(this.columns - 6, 92))
    const maxHeight = dialog ? dialogRows(this.rows) : resolveSize(options.maxHeight, this.rows, this.rows)
    let lines: AnsiLine[]
    try { lines = parseAnsi(entry.component.render(Math.max(1, width)).join('\n')) }
    catch (error) {
      lines = parseAnsi(`The dialog could not be drawn: ${error instanceof Error ? error.message : String(error)}`)
    }
    const fullscreen = !dialog && options.anchor === 'top-left' && width >= this.columns - 2 && maxHeight >= Math.floor(this.rows * 0.9)
    const height = Math.min(lines.length, maxHeight)
    const rect = dialog
      ? centeredRect(this.columns, this.rows, width, height)
      : fullscreen
        ? { top: 0, left: 0, width: this.columns, height: this.rows }
        : centeredRect(
          this.columns,
          this.rows,
          Math.max(20, Math.min(width + 4, this.columns - 2)),
          Math.max(3, Math.min(lines.length + 4, this.rows - 2))
        )
    entry.bounds = { row: rect.top, col: rect.left, width: rect.width, height: rect.height }
    entry.contentInset = dialog || fullscreen ? { x: 0, y: 0 } : { x: 2, y: 2 }
    return {
      width,
      maxHeight,
      fullscreen,
      dialog,
      bounds: entry.bounds,
      contentInset: entry.contentInset!,
      lines: lines.slice(0, height)
    }
  }

  render(_width: number): string[] { return [] }

  dispose(): void {
    this.inputListeners.clear()
    this.colorListeners.clear()
    for (const entry of this.overlayStack) {
      try { (entry.component as Component & { dispose?(): void }).dispose?.() }
      catch { /* A dialog's cleanup cannot keep the frontend alive. */ }
    }
    this.overlayStack = []
  }
}

export function asTui(host: PiDialogHost): TUI {
  return host as unknown as TUI
}
