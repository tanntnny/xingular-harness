/**
 * Settings chrome adapted from Oh My Pi 18.11.3 settings-selector.ts and
 * settings-list.ts (MIT; see NOTICE-oh-my-pi). Values and actions belong to the host.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Input, fuzzyFilter, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from '@earendil-works/pi-tui'

export interface TerminalSettingItem {
  id: string
  tab: string
  group: string
  label: string
  value: string
  description?: string
}
const categories = ['appearance', 'model', 'interaction', 'context'] as const
const categoryIcon: Record<string, string> = { appearance: '🎨', model: '🤖', interaction: '⌨', context: '📋' }
const categoryName = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const plain = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, ' ')
const tabOf = (item: TerminalSettingItem) => item.tab.toLowerCase()

/** A full terminal settings view. It describes existing host settings without owning them. */
export class SettingsPanel implements Component, Focusable {
  private search = new Input({ prompt: '' })
  private query = ''
  private currentTab = ''
  private selected: string | undefined
  private groupFocus = false
  private focusedValue = false
  private remembered = new Map<string, string>()
  private readonly items: TerminalSettingItem[]
  private readonly tabs: string[]
  constructor(private readonly tui: TUI, private readonly theme: () => Theme, items: TerminalSettingItem[], private readonly done: (id: string | undefined) => void, initialId?: string) {
    this.items = items.filter(item => categories.includes(tabOf(item) as typeof categories[number]))
    this.tabs = categories.filter(tab => this.items.some(item => tabOf(item) === tab))
    const initial = this.items.find(item => item.id === initialId)
    this.currentTab = initial ? tabOf(initial) : this.tabs[0] ?? ''
    this.selected = initial?.id ?? this.visibleItems()[0]?.id
  }
  get selectedId(): string | undefined { return this.selected }
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value; this.search.focused = value && this.query.length > 0 }
  invalidate(): void { this.search.invalidate() }
  private visibleItems(): TerminalSettingItem[] {
    return this.query
      ? fuzzyFilter(this.items, this.query, item => `${item.label} ${item.id} ${item.value} ${item.description ?? ''} ${item.group} ${item.tab}`)
      : this.items.filter(item => tabOf(item) === this.currentTab)
  }
  private select(item: TerminalSettingItem | undefined): void {
    this.selected = item?.id
    if (item) { this.currentTab = tabOf(item); this.remembered.set(this.currentTab, item.id) }
  }
  private switchTab(direction: number): void {
    const tabs = this.query ? this.tabs.filter(tab => this.visibleItems().some(item => tabOf(item) === tab)) : this.tabs
    if (!tabs.length) return
    const at = Math.max(0, tabs.indexOf(this.currentTab))
    this.currentTab = tabs[(at + direction + tabs.length) % tabs.length]
    const items = this.visibleItems().filter(item => tabOf(item) === this.currentTab)
    this.select(items.find(item => item.id === this.remembered.get(this.currentTab)) ?? items[0])
    this.groupFocus = false
  }
  private jumpGroup(direction: number): void {
    const items = this.visibleItems()
    const groups = [...new Set(items.map(item => item.group))]
    const current = items.find(item => item.id === this.selected)?.group
    const index = Math.max(0, groups.indexOf(current ?? ''))
    const group = groups[(index + direction + groups.length) % groups.length]
    this.select(items.find(item => item.group === group))
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.done(undefined); return }
    if (matchesKey(data, 'left') || matchesKey(data, 'right')) { this.switchTab(matchesKey(data, 'left') ? -1 : 1); return }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (this.query) this.switchTab(matchesKey(data, 'shift+tab') ? -1 : 1)
      else if (new Set(this.visibleItems().map(item => item.group)).size > 1) this.groupFocus = !this.groupFocus
      else this.switchTab(matchesKey(data, 'shift+tab') ? -1 : 1)
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      const direction = matchesKey(data, 'up') || matchesKey(data, 'pageUp') ? -1 : 1
      if (this.groupFocus || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) this.jumpGroup(direction)
      else {
        const items = this.visibleItems()
        const at = Math.max(0, items.findIndex(item => item.id === this.selected))
        this.select(items[Math.max(0, Math.min(items.length - 1, at + direction))])
      }
      return
    }
    if (matchesKey(data, 'enter') || data === ' ') {
      if (this.groupFocus) this.groupFocus = false
      else if (this.selected) this.done(this.selected)
      return
    }
    this.search.handleInput(data)
    if (this.search.getValue() !== this.query) {
      this.query = this.search.getValue()
      this.groupFocus = false
      this.search.focused = this.focusedValue && !!this.query
      const items = this.visibleItems()
      this.select(items.find(item => item.id === this.selected) ?? items[0])
    }
  }

  render(width: number): string[] {
    const height = Math.max(0, Math.trunc(this.tui.terminal.rows))
    width = Math.max(0, Math.trunc(width))
    if (!width || !height) return []
    const theme = this.theme()
    const inner = Math.max(0, width - 4)
    const clip = (value: string, columns = width) => truncateToWidth(value, columns, '')
    const pad = (value: string, columns: number) => clip(value, columns) + ' '.repeat(Math.max(0, columns - Math.min(columns, visibleWidth(value))))
    const border = (value: string) => theme.fg('border', value)
    const row = (value: string) => clip(border('│') + ' ' + pad(value, inner) + ' ' + border('│'))
    const rule = () => clip(border('├' + '─'.repeat(Math.max(0, width - 2)) + '┤'))
    const title = clip(' Settings ', Math.max(0, width - 4))
    const top = clip(border('╭─') + theme.bold(theme.fg('accent', title)) + border('─'.repeat(Math.max(0, width - visibleWidth(title) - 3)) + '╮'))
    const bottom = clip(border('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'))
    const tabRow = (compact: boolean) => this.tabs.map(tab => {
      const label = ` ${categoryIcon[tab]}${compact ? '' : ` ${categoryName(tab)}`} `
      return tab === this.currentTab ? theme.bg('selectedBg', theme.fg('accent', label)) : theme.fg('muted', label)
    }).join('  ')
    let tabs = tabRow(false)
    if (visibleWidth(tabs) > inner) tabs = tabRow(true)
    if (visibleWidth(tabs) > inner) tabs = theme.fg('accent', `‹ ${categoryIcon[this.currentTab] ?? ''} ${categoryName(this.currentTab)} ›`)
    const lines = [top, row(tabs), rule()]
    const items = this.visibleItems()
    const current = items.find(item => item.id === this.selected)
    if (this.query) {
      const count = `${items.length} ${items.length === 1 ? 'match' : 'matches'}`
      const prefix = theme.fg('accent', '🔍 ')
      const queryWidth = Math.max(2, inner - visibleWidth(prefix) - count.length - 1)
      lines.push(row(prefix + (this.search.render(queryWidth)[0] ?? '') + ' ' + theme.fg('dim', count)))
    }
    const contentRows = Math.max(0, height - lines.length - 3)
    const descriptionRows = Math.min(3, Math.max(0, contentRows - 2))
    const listRows = Math.max(0, contentRows - descriptionRows - (descriptionRows ? 1 : 0))
    const groups = [...new Set(items.map(item => item.group))]
    // The shipped SettingsList keeps at least 60 columns for editable rows.
    const sidebar = !this.query && groups.length > 1 && inner - 28 >= 60 ? 26 : 0
    const paneWidth = Math.max(0, inner - (sidebar ? sidebar + 2 : 0))
    const entries: { item?: TerminalSettingItem; heading?: string }[] = []
    let lastGroup: string | undefined
    for (const item of items) {
      const group = this.query ? `${categoryName(tabOf(item))} / ${item.group}` : item.group
      if (group !== lastGroup) { entries.push({ heading: group }); lastGroup = group }
      entries.push({ item })
    }
    const selectedRow = entries.findIndex(entry => entry.item?.id === this.selected)
    const start = Math.max(0, Math.min(Math.max(0, entries.length - listRows), selectedRow - Math.floor(listRows / 2)))
    const maxLabel = Math.min(30, Math.max(0, ...items.map(item => visibleWidth(plain(item.label)))))
    const labelWidth = Math.min(maxLabel, Math.max(0, Math.floor((paneWidth - 4) * 0.6)))
    for (let index = 0; index < listRows; index++) {
      const entry = entries[start + index]
      let right = ''
      if (entry?.heading) right = theme.fg(entry.heading.includes(current?.group ?? '\u0000') ? 'accent' : 'dim', plain(entry.heading))
      if (entry?.item) {
        const item = entry.item
        const selected = item.id === this.selected && !this.groupFocus
        const active = this.query || item.group === current?.group
        const prefix = selected ? '❯ ' : '  '
        const labelText = prefix + pad(plain(item.label), labelWidth)
        const text = labelText + '  ' + clip(plain(item.value), Math.max(0, paneWidth - visibleWidth(labelText) - 2))
        right = selected
          ? theme.bg('selectedBg', theme.fg('accent', pad(text, paneWidth)))
          : theme.fg(active ? 'text' : 'dim', text)
      }
      if (!entries.length && index === 0) right = theme.fg('warning', this.query ? 'No matching settings' : 'No settings')
      if (sidebar) {
        const name = groups[index]
        const active = name === current?.group
        const left = name ? (active && this.groupFocus ? '❯ ' : '  ') + plain(name) : ''
        const styled = active && this.groupFocus
          ? theme.bg('selectedBg', theme.fg('accent', pad(left, sidebar)))
          : theme.fg(active ? 'accent' : 'dim', pad(left, sidebar))
        lines.push(row(styled + theme.fg('dim', '│ ') + right))
      } else lines.push(row(right))
    }
    if (descriptionRows) lines.push(row(''))
    const description = current?.description && inner > 1 ? wrapTextWithAnsi(plain(current.description), inner) : []
    for (let index = 0; index < descriptionRows; index++) lines.push(row(theme.fg('muted', description[index] ?? '')))
    const footer = this.groupFocus
      ? '↑/↓ jump sections · Tab/Enter to settings · ←/→ switch tabs · Esc close'
      : this.query ? 'Enter/Space change · Tab jump tabs · Esc close'
        : `Enter/Space change · ${groups.length > 1 ? 'Tab jump sections · ←/→ switch tabs' : 'Tab/←/→ switch tabs'} · Type to search · Esc close`
    lines.push(rule(), row(theme.fg('dim', footer)), bottom)
    return lines.slice(0, height).map(value => clip(value))
  }
}
