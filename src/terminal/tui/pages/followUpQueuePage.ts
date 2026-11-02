import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey } from '@earendil-works/pi-tui'
import { isPrimaryClick } from '../mouse'
import type { TabInfo } from '../chrome'
import type { FollowUpQueueEditor, FollowUpQueueEntry } from '../commands'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'

const TABS = [{ id: 'queue', title: 'Follow-up queue' }] as const

export class FollowUpQueuePage implements TerminalPage {
  presentation = 'centered' as const
  private selected = 0
  private disposed = false
  private closed = false

  constructor(private readonly options: {
    editor: FollowUpQueueEditor
    theme(): Theme
    changed(): void
    close(): void
  }) {}

  get focused(): boolean { return true }
  set focused(_value: boolean) {}
  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'queue' }
  hint(): string { return '↑↓ select · Enter actions · e edit · s send next · d remove · r return · Esc close' }
  activate(): void { this.options.changed() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeEditor()
  }

  private closeEditor(): void {
    if (this.closed) return
    this.closed = true
    this.options.editor.close()
  }

  private entries(): readonly FollowUpQueueEntry[] { return this.options.editor.entries() }

  render(_width: number, _rows: number): string[] {
    const entries = this.entries()
    const steering = entries.filter(entry => entry.kind === 'steering')
    const followUp = entries.filter(entry => entry.kind === 'followUp')
    const result = ['Follow-up and steering are shown in FIFO order.', '']
    for (const [title, group] of [['Steer', steering], ['Follow-up', followUp]] as const) {
      result.push(title)
      if (!group.length) result.push('  (empty)')
      for (const entry of group) {
        const index = entries.indexOf(entry)
        const marker = index === this.selected ? '›' : ' '
        const kind = entry.kind === 'steering' ? 'Steer' : 'Follow-up'
        result.push(`${marker} ${kind}${entry.hasImages ? ' · images' : ''}  ${entry.text.replace(/\s+/g, ' ')}`)
      }
      result.push('')
    }
    if (!entries.length) result.push('Queue is empty. Plan, Bash, and deferred inputs are managed elsewhere.')
    else result.push('e edit in place · s send next · d remove · r return to composer')
    return result
  }

  private async act(action: 'edit' | 'send' | 'remove' | 'return'): Promise<void> {
    if (action === 'return') { this.options.close(); return }
    const entries = this.entries()
    if (!entries.length) return
    const entry = entries[Math.min(this.selected, entries.length - 1)]!
    if (action === 'edit') await this.options.editor.edit(entry.id)
    if (action === 'send') await this.options.editor.sendNext()
    if (action === 'remove') this.options.editor.remove(entry.id)
    this.selected = Math.min(this.selected, Math.max(0, this.entries().length - 1))
    this.options.changed()
  }

  handleInput(data: string): boolean {
    const count = this.entries().length
    if (matchesKey(data, 'escape')) return false
    if (matchesKey(data, 'up')) { this.selected = Math.max(0, this.selected - 1); this.options.changed(); return true }
    if (matchesKey(data, 'down')) { this.selected = Math.min(Math.max(0, count - 1), this.selected + 1); this.options.changed(); return true }
    const key = data.toLowerCase()
    if (key === 'e') { void this.act('edit'); return true }
    if (key === 's') { void this.act('send'); return true }
    if (key === 'd' || key === 'delete' || key === '\\x7f') { void this.act('remove'); return true }
    if (key === 'r') { void this.act('return'); return true }
    if (matchesKey(data, 'enter')) { void this.act('edit'); return true }
    return false
  }

  handleMouse(event: TerminalMouseInput) {
    if (!isPrimaryClick(event)) return
    const entries = this.entries()
    const rendered = this.render(120, 100)
    const line = Math.floor(event.y)
    const displayed = [...entries.filter(entry => entry.kind === 'steering'), ...entries.filter(entry => entry.kind === 'followUp')]
    let index = 0
    for (let row = 0; row < rendered.length; row++) {
      if (rendered[row]!.startsWith('› ') || rendered[row]!.startsWith('  Steer') || rendered[row]!.startsWith('  Follow-up')) {
        if (row === line) { this.selected = entries.indexOf(displayed[index]!); this.options.changed(); return { handled: true, render: true } }
        index++
      }
    }
    return undefined
  }
}
