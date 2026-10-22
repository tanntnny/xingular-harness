/**
 * The `/model` picker: every model the account can use, searched in the standard place, with the
 * current model marked, the default noted, and Tab to move between all models and the scoped set.
 * Enter uses a model for this session; Ctrl+S also saves it as the default.
 */
import type { AgentSession, Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'

import { centerDialogChromeRows, centerDialogContentWidth, centerDialogFrame, contentWidth, pageFrame, safeText, tabStrip } from './chrome'
import { centeredDialogHost, dialogFits, pageRows } from './dialogGeometry'
import { FilterList, type ListRow } from './list'

type PiModel = NonNullable<AgentSession['model']>
type ModelCatalog = Pick<AgentSession['modelRuntime'], 'getAvailableSnapshot' | 'getModel' | 'getError' | 'refresh'>

export interface ModelPickerOptions {
  theme: () => Theme
  tui: TUI
  runtime: ModelCatalog
  current: PiModel | undefined
  /** The models Ctrl+P cycles through, when any are chosen. */
  scoped: ReadonlyArray<{ model: PiModel }>
  defaultModel?: { provider: string; id: string }
  initialSearch?: string
  select(model: PiModel, persist: boolean): void
  cancel(): void
  changed(): void
}

const REFRESH_TIMEOUT_MS = 15_000
const SCOPES = [{ id: 'all', title: 'All models' }, { id: 'scoped', title: 'Scoped models' }] as const
const keyOf = (model: { provider: string; id: string }) => `${model.provider}\u0000${model.id}`

export class ModelPicker implements Component, Focusable {
  private scope: 'all' | 'scoped'
  private all: PiModel[] = []
  private scoped: PiModel[]
  private status = 'Refreshing model catalogs…'
  private error: string | undefined
  private closed = false
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly list: FilterList<PiModel>

  constructor(private readonly options: ModelPickerOptions) {
    this.scoped = options.scoped.map(item => options.runtime.getModel(item.model.provider, item.model.id) ?? item.model)
    this.scope = this.scoped.length ? 'scoped' : 'all'
    this.list = new FilterList<PiModel>({
      theme: options.theme, search: 'always', noun: ['model', 'models'], empty: 'No models are available for this account.',
      searchContext: () => this.scope === 'all' ? 'all models' : 'scoped models',
      onActivate: row => { if (row.data) this.finish(row.data, false) },
      onCancel: () => this.cancel()
    })
    this.load()
    if (options.initialSearch) this.list.setQuery(options.initialSearch)
    this.timer = setTimeout(() => this.abort.abort(), REFRESH_TIMEOUT_MS)
    void this.refresh()
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  private isCurrent(model: PiModel): boolean { return this.options.current ? keyOf(this.options.current) === keyOf(model) : false }
  private isDefault(model: PiModel): boolean { return this.options.defaultModel ? keyOf(this.options.defaultModel) === keyOf(model) : false }

  private load(): void {
    this.all = [...this.options.runtime.getAvailableSnapshot()]
    this.fill()
  }

  /** The current model first, the default second, then by provider. */
  private fill(): void {
    const source = this.scope === 'scoped' ? this.scoped : this.all
    const ordered = [...source].sort((left, right) =>
      Number(this.isCurrent(right)) - Number(this.isCurrent(left)) || Number(this.isDefault(right)) - Number(this.isDefault(left)) || left.provider.localeCompare(right.provider))
    const rows: ListRow<PiModel>[] = ordered.map(model => ({
      id: keyOf(model), data: model,
      label: `${this.isCurrent(model) ? '✓' : ' '} ${safeText(model.id)}`,
      detail: `${safeText(model.provider)}${this.isDefault(model) ? ' · default' : ''}`,
      tone: 'muted',
      searchText: `${model.provider} ${model.provider}/${model.id} ${model.id} ${model.name ?? ''}${this.isDefault(model) ? ' default' : ''}`
    }))
    this.list.setRows(rows)
    const current = ordered.find(model => this.isCurrent(model))
    if (current) this.list.select(keyOf(current))
  }

  private async refresh(): Promise<void> {
    try {
      const result = await this.options.runtime.refresh({ allowNetwork: true, signal: this.abort.signal })
      if (this.closed) return
      this.status = ''
      if (result.aborted) this.error = 'Model refresh timed out; showing cached models.'
      else if (result.errors.size) this.error = `Could not refresh ${[...result.errors.keys()].join(', ')}; showing cached models.`
      else {
        this.error = this.options.runtime.getError()
        if (!this.error) this.status = 'Model catalogs refreshed.'
      }
      this.load()
    } catch (error) {
      if (this.closed) return
      this.status = ''
      this.error = `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      clearTimeout(this.timer)
      if (!this.closed) this.options.changed()
    }
  }

  private finish(model: PiModel, persist: boolean): void {
    this.dispose()
    this.options.select(model, persist)
  }

  private cancel(): void {
    this.dispose()
    this.options.cancel()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.abort.abort()
  }

  invalidate(): void { this.list.invalidate() }

  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) { this.cancel(); return }
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const scopeForward = matchesKey(data, 'tab') || (centered && matchesKey(data, 'right'))
    const scopeBackward = matchesKey(data, 'shift+tab') || (centered && matchesKey(data, 'left'))
    if (scopeForward || scopeBackward) {
      if (this.scoped.length && !this.list.query) { this.scope = this.scope === 'all' ? 'scoped' : 'all'; this.fill() }
      return
    }
    if (matchesKey(data, 'ctrl+s')) {
      const model = this.list.selected?.data
      if (model) this.finish(model, true)
      return
    }
    const before = this.list.query
    this.list.handleInput(data)
    if (this.list.query !== before) this.options.changed()
  }

  render(width: number): string[] {
    const rows = pageRows(this.options.tui)
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    const centered = centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const inner = centered ? centerDialogContentWidth(width) : contentWidth(width)
    const selected = this.list.selected?.data
    const notes = [
      this.status ? theme.fg('muted', this.status) : '',
      selected ? theme.fg('muted', `Model name: ${safeText(selected.name ?? selected.id)}`) : '',
      this.error ? theme.fg('error', this.error) : ''
    ].filter(Boolean)
    const chromeRows = centered ? centerDialogChromeRows(rows) : 4
    const lines = this.list.render(inner, Math.max(2, rows - chromeRows - 1 - (notes.length ? notes.length + 1 : 0)))
    if (this.scoped.length) lines.splice(this.list.pinnedRows, 0, tabStrip(SCOPES, this.scope, inner, theme, 'sub'))
    if (notes.length) lines.push('', ...notes)
    const hint = `Enter use · Ctrl+S set as default${this.scoped.length ? ' · Tab scope' : ''} · Esc cancel`
    if (centered) return centerDialogFrame({ title: 'Model', body: lines.map(line => truncateToWidth(line, inner, '')), width, rows, theme })
    return pageFrame({ title: 'Model', meta: this.status || undefined, body: lines.map(line => truncateToWidth(line, inner, '')), footer: hint, width, rows, theme })
  }
}
