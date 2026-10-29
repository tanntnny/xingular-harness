// `/remote-control` (`/rc`): the link and QR code a phone or iPad scans to continue this session,
// who is connected, and the person's answer to a waiting pairing request. Remote control keeps
// running after the page closes (Esc); `x` or `/rc off` stops it.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { RemoteStatus } from '../../../remote/service'
import { safeText } from '../chrome'
import type { TerminalPage } from '../page'
import { qrLines } from '../qr'

export interface RemoteControlPageOptions {
  theme(): Theme
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  changed(): void
  copy(text: string): Promise<void>
  notify(message: string, type?: 'info' | 'warning' | 'error'): void
}

const KIND_LABEL = { tailscale: 'Tailscale', lan: 'Wi-Fi' } as const

export class RemoteControlPage implements TerminalPage {
  presentation = 'fullscreen' as const
  private status: RemoteStatus | null = null
  private error: string | null = null
  private showQr = true
  private busy = false
  private disposed = false
  private watching: AbortController | null = null

  constructor(private readonly options: RemoteControlPageOptions) {}

  tabs() {
    return [{ id: 'remote', title: 'Remote Control' }]
  }

  activeTab(): string {
    return 'remote'
  }

  hint(): string {
    const status = this.status
    if (status?.request) return 'a allow · d deny'
    if (!status?.running) return 's start'
    const parts = ['space QR', 'c copy link', 'n new link']
    if (status.kinds.length > 1) parts.push(`t use ${status.kind === 'tailscale' ? 'Wi-Fi' : 'Tailscale'}`)
    parts.push('x stop')
    return parts.join(' · ')
  }

  activate(): void {
    void this.watch()
  }

  dispose(): void {
    this.disposed = true
    this.watching?.abort()
  }

  private async watch(): Promise<void> {
    const watching = new AbortController()
    this.watching = watching
    let revision: number | undefined
    while (!this.disposed && !watching.signal.aborted) {
      try {
        const status = await this.options.call<RemoteStatus>(revision === undefined ? 'terminal.remoteControl.status' : 'terminal.remoteControl.status.wait', { revision })
        if (this.disposed) return
        this.status = status
        this.error = null
        revision = status.revision
      } catch (error) {
        if (this.disposed) return
        this.error = error instanceof Error ? error.message : String(error)
        revision = undefined
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      this.options.changed()
    }
  }

  private async act(method: string, params: Record<string, unknown> = {}, done?: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.options.changed()
    try {
      this.status = await this.options.call<RemoteStatus>(method, params)
      this.error = null
      if (done) this.options.notify(done)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.busy = false
      this.options.changed()
    }
  }

  handleInput(data: string): boolean {
    const status = this.status
    if (status?.request) {
      if (data === 'a' || data === 'y') void this.act('terminal.remoteControl.confirm', { requestId: status.request.id, allow: true }, `${status.request.label} can now control this session.`)
      else if (data === 'd' || data === 'n') void this.act('terminal.remoteControl.confirm', { requestId: status.request.id, allow: false })
      return true
    }
    if (!status?.running) {
      if (data === 's') void this.act('terminal.remoteControl.start')
      return data === 's'
    }
    if (data === ' ') this.showQr = !this.showQr
    else if (data === 'c' && status.url) void this.options.copy(status.url).then(() => this.options.notify('Remote-control link copied'), (error) => this.options.notify(error instanceof Error ? error.message : String(error), 'error'))
    else if (data === 'n') void this.act('terminal.remoteControl.rotate', {}, 'New link. Paired devices were disconnected.')
    else if (data === 't' && status.kinds.length > 1) void this.act('terminal.remoteControl.start', { interface: status.kind === 'tailscale' ? 'lan' : 'tailscale' })
    else if (data === 'x') void this.act('terminal.remoteControl.stop', {}, 'Remote control stopped.')
    else return false
    return true
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    const status = this.status
    const lines: string[] = []
    const wrap = (text: string, color: 'text' | 'dim' | 'accent' | 'warning' | 'error' | 'success' = 'text') => {
      for (const line of wrapTextWithAnsi(text, Math.max(1, width))) lines.push(theme.fg(color, line))
    }
    if (this.error) {
      wrap(this.error, 'error')
      lines.push('')
    }
    if (!status) {
      wrap('Starting remote control…', 'dim')
      return lines.slice(0, rows)
    }
    if (status.request) {
      wrap(`${safeText(status.request.label)} wants to control this session.`, 'warning')
      wrap('It will be able to send messages, stop replies, and answer approvals and questions. Press a to allow or d to deny.', 'text')
      lines.push('')
    }
    if (!status.running) {
      wrap('Remote control is off.', 'dim')
      wrap('Press s to start it, then scan the QR code with your phone or iPad.', 'dim')
      return lines.slice(0, rows)
    }
    const kind = status.kind ? KIND_LABEL[status.kind] : ''
    lines.push(theme.fg('success', '● ') + theme.bold(`Remote control is on${kind ? ` · ${kind}` : ''}`))
    wrap(status.kind === 'tailscale'
      ? 'Scan with a phone or iPad signed in to the same Tailscale network, or open this link on it:'
      : 'Scan with a phone or iPad on the same Wi-Fi, or open this link on it:', 'dim')
    if (status.url) wrap(status.url, 'accent')
    if (status.warning) wrap(safeText(status.warning), 'warning')
    if (status.kind === 'lan') wrap('On a network you do not trust, use Tailscale instead: anyone there can see that this computer is listening.', 'dim')
    const devices = status.devices.length
      ? status.devices.map((device) => `${device.connected ? theme.fg('success', '●') : theme.fg('dim', '○')} ${safeText(device.label)}${device.connected ? '' : theme.fg('dim', ' (paired, not connected)')}`)
      : [theme.fg('dim', 'No device paired yet.')]
    const footer = ['', ...devices]
    if (this.showQr && status.url) {
      const qr = qrLines(status.url)
      const room = rows - lines.length - footer.length - 1
      const qrWidth = visibleWidth(qr[0] ?? '')
      if (qr.length <= room && qrWidth <= width) {
        lines.push('')
        const pad = ' '.repeat(Math.max(0, Math.floor((width - qrWidth) / 2)))
        for (const line of qr) lines.push(pad + line)
      } else {
        lines.push('', theme.fg('dim', 'Make the terminal larger to show the QR code, or press c to copy the link.'))
      }
    }
    lines.push(...footer)
    return lines.slice(0, rows).map((line) => truncateToWidth(line, width, ''))
  }
}
