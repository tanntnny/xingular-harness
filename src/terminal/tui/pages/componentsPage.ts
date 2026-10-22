import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { KINDS, type ComponentItem } from '../../../tree/components'
import type { MenuUi } from '../../pluginMenu'
import { safeText, type TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList } from '../list'
import type { TerminalMouseInput } from '../mouse'

const SECTIONS = [
  { id: 'skills', title: 'Skills' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'rules', title: 'Rules' }
] as const

export interface ComponentLibrarySnapshot {
  items: ComponentItem[]
  addedIds: string[]
  writable: boolean
  fingerprint: string | null
}

export interface ComponentAddedResult {
  fingerprint: string
  alreadyPresent: boolean
}

export type ComponentPageCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface ComponentsPageOptions {
  theme: () => Theme
  call: ComponentPageCall
  ui: MenuUi
  notify(message: string, type?: string): void
  changed(): void
}

export class ComponentsPage implements TerminalPage {
  private snapshot: ComponentLibrarySnapshot | undefined
  private section: typeof KINDS[number] = 'skills'
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<ComponentItem>

  constructor(private readonly options: ComponentsPageOptions) {
    this.list = new FilterList<ComponentItem>({
      theme: options.theme, search: 'always', noun: ['item', 'items'], empty: 'This library section is empty.',
      onActivate: row => { void this.add(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }
  activate(): void { if (!this.snapshot) void this.load() }
  dispose(): void { this.disposed = true }
  hint(): string { return this.list.query ? 'Enter add · Esc clear' : 'Enter add eligible item · type to search' }

  private async load(): Promise<void> {
    try {
      this.snapshot = await this.options.call<ComponentLibrarySnapshot>('terminal.components.list')
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.fill()
    this.options.changed()
  }

  private fill(): void {
    const items = (this.snapshot?.items ?? []).filter(item => item.kind === this.section)
    const added = new Set(this.snapshot?.addedIds ?? [])
    this.list.setRows(items.map(item => {
      const exists = added.has(item.id)
      const detail = exists ? 'In Harness' : item.kind === 'prompts' ? 'Library only' : this.snapshot?.writable ? 'Add for next session' : 'Browse only'
      return {
        id: item.id, label: safeText(item.name), group: item.builtin ? 'Built-in' : 'Library',
        detail, tone: exists ? 'success' as const : item.kind === 'prompts' ? 'dim' as const : 'muted' as const,
        searchText: item.name + ' ' + item.description + ' ' + item.id, data: item
      }
    }))
  }

  private async add(item: ComponentItem | undefined): Promise<void> {
    if (!item || this.busy) return
    if (item.kind === 'prompts') {
      this.options.notify('Prompts stay in the library and cannot be added to a Harness tree.', 'info')
      return
    }
    if ((this.snapshot?.addedIds ?? []).includes(item.id)) {
      this.options.notify('This item is already in the current Harness tree.', 'info')
      return
    }
    if (!this.snapshot?.writable) {
      this.options.notify('This terminal has no writable Harness scope. The library is browse-only.', 'warning')
      return
    }
    const approved = await this.options.ui.confirm(
      'Add ' + item.name + '?',
      'This creates a new Harness tree version for the next session. The running terminal keeps its pinned version.'
    )
    if (!approved) return
    this.busy = true
    try {
      const result = await this.options.call<ComponentAddedResult>('terminal.components.add', { id: item.id })
      this.options.notify(
        result.alreadyPresent ? 'This item is already in the current Harness tree.' : 'Saved for the next session · version ' + result.fingerprint,
        'info'
      )
      await this.load()
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        const at = SECTIONS.findIndex(section => section.id === this.section)
        const delta = matchesKey(data, 'shift+tab') ? -1 : 1
        this.section = SECTIONS[(at + delta + SECTIONS.length) % SECTIONS.length]!.id
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.snapshot) return [theme.fg(this.error ? 'error' : 'dim', this.error ? 'Could not read the component library: ' + this.error : 'Reading the component library…')]
    const selected = this.list.selected?.data
    const detail = selected && rows >= 8
      ? wrapTextWithAnsi(safeText(selected.description || 'No description.'), width).slice(0, Math.min(3, rows - 4))
      : []
    const lines = this.list.render(width, Math.max(2, rows - (detail.length ? detail.length + 1 : 0)))
    if (detail.length) lines.push('', ...detail.map(line => theme.fg('muted', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
