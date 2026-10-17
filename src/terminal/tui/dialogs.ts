// Rounded selector chrome follows Oh My Pi 18.11.3 (MIT; see NOTICE-oh-my-pi).
import type { ExtensionUIContext, ExtensionUIDialogOptions, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, Input, SelectList, fuzzyFilter, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type OverlayOptions, type SelectListTheme, type TUI } from '@earendil-works/pi-tui'

type DisposableComponent = Component & { dispose?(): void }
export function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text.replace(/^→/, '❯')),
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

function safe(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, ' ')
}

/** OMP hook-selector.ts uses type-to-search once its options exceed the list window. */
export class SearchableSelect implements Component, Focusable {
  private search = new Input({ prompt: '' })
  private list: SelectList
  private query = ''
  private limit = 0
  private items: { value: string; label: string }[]
  private filtered: { value: string; label: string }[] = []
  private focusedValue = false
  private currentTheme: Theme | undefined
  constructor(options: string[], private readonly tui: TUI, private readonly theme: () => Theme, private readonly select: (index: number) => void, private readonly cancel: () => void) {
    this.items = options.map((option, index) => ({ value: String(index), label: safe(option) }))
    this.list = new SelectList([], 1, selectTheme(theme()))
    this.rebuild()
  }
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value; this.search.focused = value && this.searchEnabled() }
  private searchEnabled(): boolean { return this.items.length > this.limit || this.query.length > 0 }
  private rebuild(): void {
    const selected = this.list.getSelectedItem()?.value
    this.limit = Math.min(12, Math.max(1, Math.floor(this.tui.terminal.rows * 0.8) - 7))
    this.currentTheme = this.theme()
    this.filtered = fuzzyFilter(this.items, this.query, item => item.label)
    this.list = new SelectList(this.filtered, this.limit, selectTheme(this.currentTheme))
    if (selected) {
      const index = this.filtered.findIndex(item => item.value === selected)
      if (index >= 0) this.list.setSelectedIndex(index)
    }
    this.list.onSelect = item => this.select(Number(item.value))
    this.list.onCancel = this.cancel
    this.search.focused = this.focusedValue && this.searchEnabled()
  }
  invalidate(): void { this.rebuild(); this.search.invalidate() }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.cancel(); return }
    if (!this.query && /^[1-9]$/.test(data)) {
      const index = this.items.findIndex(item => item.label.startsWith(`${data}. `))
      if (index >= 0) { this.select(index); return }
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter') || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.list.handleInput(data)
    } else if (this.searchEnabled()) {
      this.search.handleInput(data)
      if (this.query !== this.search.getValue()) { this.query = this.search.getValue(); this.rebuild() }
    } else if (data === 'j' || data === 'k') this.list.handleInput(data === 'j' ? '\x1b[B' : '\x1b[A')
  }
  render(width: number): string[] {
    if (this.limit !== Math.min(12, Math.max(1, Math.floor(this.tui.terminal.rows * 0.8) - 7)) || this.currentTheme !== this.theme()) this.rebuild()
    const theme = this.theme()
    const lines = this.list.render(Math.max(4, width)).map(line => {
      const bounded = truncateToWidth(line, width, '')
      return stripTerminalSequences(line).startsWith('❯')
        ? theme.bg('selectedBg', bounded + ' '.repeat(Math.max(0, width - visibleWidth(bounded))))
        : bounded
    })
    if (this.searchEnabled()) {
      const selected = this.filtered.findIndex(item => item.value === this.list.getSelectedItem()?.value) + 1
      const count = `(${selected}/${this.filtered.length}${this.query ? ` of ${this.items.length}` : ''})`
      lines.push(this.query ? theme.fg('dim', `  ${count} Search: `) + (this.search.render(Math.max(2, width - count.length - 11))[0] ?? '') : theme.fg('dim', `  ${count} Type to search`))
    }
    return lines.map(line => truncateToWidth(line, width, ''))
  }
}

/** An overlay owns focus; its input emits the cursor marker through this delegate. */
export class DialogPanel implements Component, Focusable {
  deadline?: number
  maxRows?: () => number
  private focusedValue = false
  private detailOffset = 0
  private detailRows = 0
  private detailTotal = 0
  constructor(readonly title: string, readonly content: Component, private readonly theme: () => Theme, readonly hint: string, private readonly message?: string) {}
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    if ('focused' in this.content) (this.content as Component & Focusable).focused = value
  }
  invalidate(): void { this.content.invalidate() }
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
    const inner = Math.max(2, width - 4)
    const cap = (value: string) => truncateToWidth(value, width, '')
    const border = (value: string) => theme.fg('border', value)
    const title = truncateToWidth(` ${safe(this.title)} `, Math.max(0, width - 4), '')
    const top = cap(border('╭─') + theme.bold(theme.fg('accent', title)) + border('─'.repeat(Math.max(0, width - visibleWidth(title) - 3)) + '╮'))
    const bottom = cap(border('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'))
    const row = (line: string) => {
      const shown = truncateToWidth(line, inner, '')
      return cap(border('│') + ' ' + shown + ' '.repeat(Math.max(0, width - visibleWidth(shown) - 3)) + border('│'))
    }
    const details = this.message
      ? wrapTextWithAnsi(stripTerminalSequences(this.message).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '    '), inner)
      : []
    const content = this.content.render(inner)
    const height = this.maxRows ? Math.max(3, Math.floor(this.maxRows())) : details.length + content.length + 4
    const budget = Math.max(0, height - 3)
    // Keep choices and the footer mounted even when an approval contains a large command or path.
    const minContent = Math.min(content.length, Math.min(2, budget))
    const detailBudget = Math.min(details.length, Math.max(0, budget - Math.max(minContent, Math.min(content.length, budget))))
    this.detailRows = detailBudget
    this.detailTotal = details.length
    this.detailOffset = Math.max(0, Math.min(this.detailOffset, details.length - detailBudget))
    const body = details.slice(this.detailOffset, this.detailOffset + detailBudget).map(line => theme.fg('muted', line))
    const available = Math.max(0, budget - body.length)
    const cursor = content.findIndex(line => line.includes('\x1b_pi:c\x07') || stripTerminalSequences(line).startsWith('❯'))
    const first = content.length <= available ? 0 : Math.max(0, Math.min(content.length - available, cursor - Math.floor(available / 2)))
    body.push(...content.slice(first, first + available))
    const seconds = this.deadline === undefined ? '' : ` · ${Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000))}s`
    let footerText = this.hint + seconds
    if (details.length > detailBudget) {
      footerText = `PgUp/PgDn details ${this.detailOffset + 1}-${this.detailOffset + detailBudget}/${details.length} · ${footerText}`
      if (visibleWidth(footerText) > inner) footerText = 'PgUp/PgDn details · Enter · Esc' + seconds
    }
    const footer = row(theme.fg('dim', footerText))
    return [top, ...body.map(row), footer, bottom].slice(0, height)
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
        panel.maxRows = () => Math.max(3, Math.floor(this.tui.terminal.rows * 0.8))
        if (options?.timeout !== undefined) {
          panel.deadline = Date.now() + Math.max(0, options.timeout)
          timer = setTimeout(cancel, Math.max(0, options.timeout))
          countdown = setInterval(this.changed, 250)
          countdown.unref?.()
        }
        handle = this.tui.showOverlay(panel, { anchor: 'bottom-center', width: '100%', maxHeight: '80%' })
        if (settled) handle.hide()
        this.changed()
      } catch (error) {
        finish(undefined, error)
      }
    })
  }

  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.show<string>(done => {
      const list = new SearchableSelect(options, this.tui, this.theme, index => done(options[index]), () => done(undefined))
      return new DialogPanel(title, list, this.theme, '↑/↓ select · Enter confirm · Esc cancel')
    }, opts)
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return (await this.show<boolean>(done => {
      const list = new SelectList([{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], 2, selectTheme(this.theme()))
      list.onSelect = item => done(item.value === 'yes')
      list.onCancel = () => done(undefined)
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
