/**
 * The Permissions page: Full Permission, then every tool with whether a call needs asking.
 * The state lives in the local Harness state through the runtime's `permissions` calls.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { TabInfo } from '../chrome'
import type { TerminalPage } from '../page'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPermissionState } from '../runtime'

export interface PermissionsPageOptions {
  theme: () => Theme
  permissions(): Promise<TerminalPermissionState>
  setFullPermission(enabled: boolean): Promise<void>
  setGlobalTool(tool: string, allowed: boolean): Promise<void>
  /** The tools this session has switched on. */
  activeTools(): string[]
  confirm(title: string, message: string): Promise<boolean>
  notify(message: string, type?: string): void
  changed(): void
}

const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'tools', title: 'Tools' }
] as const
const FULL = 'full'
const NOTE = 'Applies to future approvals only. Hard denials and disabled tools still apply.'
const FULL_WARNING = 'Automatically approve eligible future requests in every Pi terminal session sharing this local Harness state. Hard denials and disabled tools still apply; human-only requests stay manual unless the host explicitly opts them in. Requests already waiting are not approved.'

export class PermissionsPage implements TerminalPage {
  private state: TerminalPermissionState | undefined
  private section: typeof SECTIONS[number]['id'] = 'overview'
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<string>

  constructor(private readonly options: PermissionsPageOptions) {
    this.list = new FilterList<string>({
      theme: options.theme, search: 'always', noun: ['tool', 'tools'], empty: 'No tools to show',
      onActivate: row => { void this.toggle(row.id) },
      onToggle: row => { void this.toggle(row.id) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return SECTIONS }
  activeTab(): string { return this.section }
  hint(): string { return this.list.query ? 'Enter toggle · Esc clear' : 'Space or Enter toggle · type to search' }

  private async reload(): Promise<void> {
    try {
      this.state = await this.options.permissions()
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.fill()
    this.options.changed()
  }

  private fill(): void {
    this.list.setRows(this.rows())
  }

  private rows(): ListRow<string>[] {
    const state = this.state
    if (!state) return []
    if (this.section === 'overview') {
      return [{ id: FULL, label: 'Full Permission', group: 'Mode', detail: state.full ? 'ON' : 'OFF', tone: state.full ? 'warning' : 'muted', searchText: 'full permission approve everything' }]
    }
    const granted = new Set(state.globalTools)
    const active = this.options.activeTools()
    const inactive = [...granted].filter(tool => !active.includes(tool))
    const byName = (left: string, right: string) => left.localeCompare(right)
    const tool = (name: string, group: string): ListRow<string> => ({
      id: 'tool:' + name, label: name, group,
      detail: granted.has(name) ? '● allowed everywhere' : '○ asks each time',
      tone: granted.has(name) ? 'success' : 'muted'
    })
    return [
      ...[...active].sort(byName).map(name => tool(name, 'Tools in this session')),
      ...inactive.sort(byName).map(name => tool(name, 'Granted, not active here'))
    ]
  }

  private async toggle(id: string): Promise<void> {
    if (this.busy || !this.state) return
    this.busy = true
    try {
      if (id === FULL) {
        const desired = !this.state.full
        const latest = await this.options.permissions()
        if (latest.full !== desired && (!desired || await this.options.confirm('Enable Full Permission?', FULL_WARNING))) await this.options.setFullPermission(desired)
      } else {
        const tool = id.slice('tool:'.length)
        if (!tool) return
        const desired = !this.state.globalTools.includes(tool)
        const latest = await this.options.permissions()
        if (latest.globalTools.includes(tool) !== desired) await this.options.setGlobalTool(tool, desired)
      }
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
    await this.reload()
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (!this.list.query) {
        this.section = this.section === 'overview' ? 'tools' : 'overview'
        this.fill()
      }
      return true
    }
    return this.list.handleInput(data)
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (!this.state) return [theme.fg(this.error ? 'error' : 'dim', this.error ? `Could not read permissions: ${this.error}` : 'Reading permissions…')]
    const note = this.section === 'overview' && rows >= 8 ? wrapTextWithAnsi(NOTE, width).slice(0, 2) : []
    const lines = this.list.render(width, Math.max(1, rows - (note.length ? note.length + 1 : 0)))
    if (note.length) lines.push('', ...note.map(line => theme.fg('dim', line)))
    return lines.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
