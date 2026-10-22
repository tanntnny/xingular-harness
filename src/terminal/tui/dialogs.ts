// Dialogs are blocks or pages (see chrome.ts); the selector rows follow Oh My Pi 18.11.3 (MIT; see NOTICE-oh-my-pi).
import type { ExtensionUIContext, ExtensionUIDialogOptions, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, Input, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type OverlayOptions, type SelectListTheme, type TUI, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import { CENTER_DIALOG_PAD, CHROME_ROWS, blockFrame, centerDialogChromeRows, centerDialogContentWidth, centerDialogFrame, centerDialogVerticalPad, contentWidth, pageFrame, safeText, selectionText } from './chrome'
import { centeredDialogHost, dialogFits, pageOverlayOptions, pageRows } from './dialogGeometry'
import { FilterList } from './list'
import { searchFieldRowsFor } from './search'
import type { TerminalMouseInput } from './mouse'

type DisposableComponent = Component & { dispose?(): void }
/** `page` asks for a full-screen dialog; Pi's own dialogs ignore the field. */
export type TerminalDialogOptions = ExtensionUIDialogOptions & { page?: boolean }
export type DialogVariant = 'block' | 'page'
export function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: text => selectionText(theme, text), selectedText: text => selectionText(theme, text.replace(/^→/, '❯')),
    description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text),
    noMatch: text => theme.fg('warning', text.replace('commands', 'options'))
  }
}

/** Input keeps the original value; only its rendered cells are masked. */
export class SecretInput extends Input {
  override render(width: number): string[] {
    const lines = super.render(width)
    if (!this.getValue()) return lines
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return lines.map(line => line.split(/(\x1b(?:\[[0-9;?]*[ -/]*[@-~]|_[^\x07]*\x07))/g).map((part, index) => index % 2
      ? part
      : [...segments.segment(part)].map(item => '•'.repeat(visibleWidth(item.segment))).join('')).join(''))
  }
}

const safe = safeText

/** Choices as a `FilterList`, with the standard search field visible for every list. */
export class SearchableSelect implements Component, Focusable {
  private readonly list: FilterList<number>
  private readonly labels: string[]
  private focusedValue = false
  constructor(options: string[], private readonly tui: TUI, theme: () => Theme, private readonly select: (index: number) => void, private readonly cancel: () => void, search: 'always' | 'never' = 'always') {
    this.labels = options.map(safe)
    this.list = new FilterList<number>({
      theme, search,
      rows: this.labels.map((label, index) => ({ id: String(index), label, data: index })),
      limit: () => this.windowRows(),
      noun: ['option', 'options'],
      onActivate: row => this.select(row.data ?? 0),
      onCancel: cancel
    })
  }
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value; this.list.focused = value }
  get pinnedRows(): number { return this.list.pinnedRows }
  private contentRows(): number {
    const centered = centeredDialogHost(this.tui)
    const maxRows = centered ? pageRows(this.tui) : Math.max(3, Math.floor(this.tui.terminal.rows * 0.8))
    const chromeRows = centered ? centerDialogChromeRows(maxRows) : CHROME_ROWS
    return Math.max(1, maxRows - chromeRows)
  }
  private searchRows(): number { return searchFieldRowsFor(this.contentRows()) }
  private windowRows(): number {
    return Math.min(12, Math.max(1, this.contentRows() - this.searchRows()))
  }
  invalidate(): void { this.list.invalidate() }
  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    return this.list.handleMouse(event)
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) { this.cancel(); return }
    if (!this.list.query && /^[1-9]$/.test(data)) {
      const index = this.labels.findIndex(label => label.startsWith(`${data}. `))
      if (index >= 0) { this.select(index); return }
    }
    if (this.list.handleInput(data)) return
    if (!this.list.query && this.list.pinnedRows === 0 && (data === 'j' || data === 'k')) this.list.handleInput(data === 'j' ? '\x1b[B' : '\x1b[A')
  }
  render(width: number): string[] {
    return this.list.render(Math.max(4, width), this.windowRows() + this.searchRows()).map(line => truncateToWidth(line, width, ''))
  }
}

/** An overlay owns focus; its input emits the cursor marker through this delegate. */
export class DialogPanel implements Component, Focusable {
  deadline?: number
  maxRows?: () => number
  centered = false
  private focusedValue = false
  private detailOffset = 0
  private detailRows = 0
  private detailTotal = 0
  private mouseBodyStart = 0
  private mouseContentRows: (number | undefined)[] = []
  constructor(readonly title: string, readonly content: Component, private readonly theme: () => Theme, readonly hint: string, private readonly message?: string, readonly variant: DialogVariant = 'block') {}
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    if ('focused' in this.content) (this.content as Component & Focusable).focused = value
  }
  invalidate(): void { this.content.invalidate() }
  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') {
      const key = event.wheelDelta !== undefined && event.wheelDelta < 0 ? '\x1b[5~' : '\x1b[6~'
      this.handleInput(key)
      return { handled: true, render: true }
    }
    if (event.type !== 'move' && event.type !== 'click') return undefined
    if (event.type === 'click' && event.button !== 'left') return undefined
    const row = this.mouseContentRows[event.y - this.mouseBodyStart]
    if (row === undefined) return undefined
    const mouseAware = this.content as Component
    return mouseAware.handleMouse?.({ ...event, y: row })
  }
  handleInput(data: string): void {
    if (this.detailTotal > this.detailRows && (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown'))) {
      const delta = matchesKey(data, 'pageUp') ? -1 : 1
      this.detailOffset = Math.max(0, Math.min(this.detailTotal - this.detailRows, this.detailOffset + delta * Math.max(1, this.detailRows)))
      return
    }
    this.content.handleInput?.(data)
  }
  render(width: number): string[] {
    if (width < 1) return []
    const theme = this.theme()
    const inner = this.centered ? centerDialogContentWidth(width) : contentWidth(width)
    const details = this.message
      ? wrapTextWithAnsi(stripTerminalSequences(this.message).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '    '), inner)
      : []
    const content = this.content.render(inner)
    const frameRows = this.centered ? CENTER_DIALOG_PAD * 2 + 2 : CHROME_ROWS
    const maxHeight = this.maxRows ? Math.max(3, Math.floor(this.maxRows())) : details.length + content.length + frameRows
    const chromeRows = this.centered ? centerDialogChromeRows(maxHeight) : CHROME_ROWS
    const budget = Math.max(0, maxHeight - chromeRows)
    // Keep choices mounted even when an approval contains a large command or path.
    const minContent = Math.min(content.length, Math.min(2, budget))
    const detailBudget = Math.min(details.length, Math.max(0, budget - Math.max(minContent, Math.min(content.length, budget))))
    this.detailRows = detailBudget
    this.detailTotal = details.length
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, details.length - detailBudget))
    const body = details.slice(this.detailOffset, this.detailOffset + detailBudget).map(line => theme.fg('muted', line))
    this.mouseContentRows = body.map(() => undefined)
    const available = Math.max(0, budget - body.length)
    // A search row stays on top when a tall list has to be cut.
    const pinned = Math.min(Math.max(0, 'pinnedRows' in this.content ? Number(this.content.pinnedRows) || 0 : 0), content.length, available)
    const scrolling = content.slice(pinned)
    const room = available - pinned
    const cursor = scrolling.findIndex(line => line.includes('\x1b_pi:c\x07') || stripTerminalSequences(line).startsWith('❯'))
    const first = scrolling.length <= room ? 0 : Math.max(0, Math.min(scrolling.length - room, cursor - Math.floor(room / 2)))
    body.push(...content.slice(0, pinned), ...scrolling.slice(first, first + room))
    this.mouseContentRows.push(...Array.from({ length: pinned }, (_, index) => index))
    this.mouseContentRows.push(...Array.from({ length: Math.min(room, scrolling.length - first) }, (_, index) => pinned + first + index))
    const height = this.centered ? body.length + centerDialogChromeRows(body.length + chromeRows) : maxHeight
    this.mouseBodyStart = this.centered ? centerDialogVerticalPad(height) + 2 : 2
    const seconds = this.deadline === undefined ? undefined : `${Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000))}s`
    let footer = this.hint
    if (details.length > detailBudget) {
      footer = `PgUp/PgDn details ${this.detailOffset + 1}-${this.detailOffset + detailBudget}/${details.length} · ${footer}`
      if (visibleWidth(footer) > inner) footer = 'PgUp/PgDn details · Enter · Esc'
    }
    const frame = { title: this.title, meta: seconds, body, footer, width, theme }
    if (this.centered) return centerDialogFrame({ title: this.title, body, width, rows: height, theme })
    return (this.variant === 'page' && this.maxRows ? pageFrame({ ...frame, rows: height }) : blockFrame(frame)).slice(0, height)
  }
}

export class TerminalDialogs {
  private pending = new Set<() => void>()
  private disposed = false
  constructor(private readonly tui: TUI, private readonly theme: () => Theme, private readonly keybindings: KeybindingsManager, private readonly changed: () => void) {}

  private show<T>(build: (done: (value: T | undefined) => void) => DialogPanel, options?: ExtensionUIDialogOptions): Promise<T | undefined> {
    if (this.disposed || options?.signal?.aborted) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      let handle: OverlayHandle | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let countdown: ReturnType<typeof setInterval> | undefined
      let settled = false
      let panel: DialogPanel | undefined
      const finish = (value: T | undefined, error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(countdown)
        options?.signal?.removeEventListener('abort', cancel)
        this.pending.delete(cancel)
        handle?.hide()
        const content = panel?.content as DisposableComponent | undefined
        try { content?.dispose?.() } catch { /* The dialog must still release focus and settle. */ }
        this.changed()
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const done = (value: T | undefined) => finish(value)
      const cancel = () => done(undefined)
      this.pending.add(cancel)
      options?.signal?.addEventListener('abort', cancel, { once: true })
      try {
        panel = build(done)
        const page = panel.variant === 'page'
        const centered = centeredDialogHost(this.tui)
        panel.centered = centered && (!page || dialogFits(this.tui.terminal.columns, this.tui.terminal.rows))
        // A centered host caps every dialog at the rows its overlay shows, so a long list is not cut at the bottom.
        panel.maxRows = () => centered ? pageRows(this.tui) : page ? Math.max(3, Math.floor(this.tui.terminal.rows)) : Math.max(3, Math.floor(this.tui.terminal.rows * 0.8))
        if (options?.timeout !== undefined) {
          panel.deadline = Date.now() + Math.max(0, options.timeout)
          timer = setTimeout(cancel, Math.max(0, options.timeout))
          countdown = setInterval(this.changed, 250)
          countdown.unref?.()
        }
        // Every dialog on a centered host is the same flat panel on the scrim that the page commands use.
        handle = this.tui.showOverlay(panel, centered
          ? pageOverlayOptions()
          : page
            ? { anchor: 'top-left', width: '100%', maxHeight: '100%' }
            : { anchor: 'bottom-center', width: '100%', maxHeight: '80%' })
        if (settled) handle.hide()
        this.changed()
      } catch (error) {
        finish(undefined, error)
      }
    })
  }

  select(title: string, options: string[], opts?: TerminalDialogOptions): Promise<string | undefined> {
    return this.show<string>(done => {
      const list = new SearchableSelect(options, this.tui, this.theme, index => done(options[index]), () => done(undefined))
      return new DialogPanel(title, list, this.theme, '↑/↓ select · Enter confirm · Esc cancel', undefined, opts?.page ? 'page' : 'block')
    }, opts)
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return (await this.show<boolean>(done => {
      const list = new SearchableSelect(['Yes', 'No'], this.tui, this.theme, index => done(index === 0), () => done(undefined), 'never')
      return new DialogPanel(title, list, this.theme, '↑/↓ select · Enter confirm · Esc cancel', message)
    }, opts)) ?? false
  }

  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions, secret = false): Promise<string | undefined> {
    return this.show<string>(done => {
      const InputType = secret ? SecretInput : Input
      const input = new InputType({ prompt: secret ? '' : '> ', placeholder, placeholderStyle: text => this.theme().fg('dim', text) })
      input.onSubmit = done
      input.onEscape = () => done(undefined)
      return new DialogPanel(title, input, this.theme, 'Enter submit · Esc cancel')
    }, opts)
  }

  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.show<string>(done => {
      const editor = new Editor(this.tui, { borderColor: text => this.theme().fg('border', text), selectList: selectTheme(this.theme()) })
      editor.setText(prefill ?? '')
      editor.onSubmit = done
      const content: Component & Focusable = {
        get focused() { return editor.focused }, set focused(value) { editor.focused = value },
        invalidate: () => editor.invalidate(), render: width => editor.render(Math.max(4, width)).map(line => truncateToWidth(line, width, '')),
        handleInput: data => {
          if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) done(undefined)
          else editor.handleInput(data)
        }
      }
      return new DialogPanel(title, content, this.theme, 'Enter submit · Shift+Enter newline · Esc cancel')
    })
  }

  custom<T>(factory: Parameters<ExtensionUIContext['custom']>[0], options?: Parameters<ExtensionUIContext['custom']>[1]): Promise<T> {
    if (this.disposed) return Promise.resolve(undefined as T)
    return new Promise<T>((resolve, reject) => {
      let handle: OverlayHandle | undefined
      let component: DisposableComponent | undefined
      let settled = false
      const done = (value: unknown) => {
        if (settled) return
        settled = true
        this.pending.delete(cancel)
        handle?.hide()
        try { component?.dispose?.() } catch { /* Cleanup cannot prevent completion. */ }
        this.changed()
        resolve(value as T)
      }
      const cancel = () => done(undefined)
      this.pending.add(cancel)
      Promise.resolve().then(() => factory(this.tui, this.theme(), this.keybindings, done)).then(value => {
        component = value
        if (settled) {
          try { component.dispose?.() } catch { /* It never mounted. */ }
          return
        }
        const defaults: OverlayOptions = { anchor: 'bottom-center', width: '100%', maxHeight: '90%' }
        const source = options?.overlayOptions
        const overlayOptions = typeof source === 'function'
          ? new Proxy(defaults, { get: (target, key: keyof OverlayOptions) => source()[key] ?? target[key] })
          : { ...defaults, ...source }
        handle = this.tui.showOverlay(component, overlayOptions)
        options?.onHandle?.(handle)
        this.changed()
      }).catch(error => {
        if (!settled) {
          settled = true
          this.pending.delete(cancel)
          handle?.hide()
          try { component?.dispose?.() } catch { /* Cleanup cannot prevent completion. */ }
          this.changed()
          reject(error)
        }
      })
    })
  }

  reset(): void {
    for (const cancel of [...this.pending]) cancel()
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }
}
