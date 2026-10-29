import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { RemoteStatus } from '../../../remote/service'
import { qrLines, qrModules } from '../qr'
import { createHarnessTheme } from '../theme'
import { RemoteControlPage } from './remoteControlPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const URL = 'http://192.168.1.20:51234/#pairing-id.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

const status = (overrides: Partial<RemoteStatus> = {}): RemoteStatus => ({
  running: true, revision: 1, url: URL, kind: 'lan', kinds: ['lan', 'tailscale'], devices: [], request: null, warning: null, ...overrides
})

function page(current: RemoteStatus) {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'terminal.remoteControl.status.wait') return new Promise(() => {})
    void params
    return current
  })
  const options = { theme: () => theme, call: call as never, changed: vi.fn(), copy: vi.fn(async () => {}), notify: vi.fn() }
  const remote = new RemoteControlPage(options)
  remote.activate()
  return { remote, call, options }
}

const text = (lines: string[]) => lines.map((line) => stripTerminalSequences(line)).join('\n')

describe('the remote-control page', () => {
  it('draws a square QR code with a light quiet zone, two modules per row', () => {
    const modules = qrModules(URL)
    expect(modules.length).toBe(modules[0]!.length)
    expect(modules[0]!.every((dark) => !dark)).toBe(true)
    const lines = qrLines(URL)
    expect(lines).toHaveLength(Math.ceil(modules.length / 2))
    expect(stripTerminalSequences(lines[0]!)).toHaveLength(modules.length)
  })

  it('shows the link, the QR code and the paired devices, and toggles the code', async () => {
    const { remote } = page(status({ devices: [{ id: 'd1', label: 'iPhone · Safari', connected: true }] }))
    await vi.waitFor(() => expect(text(remote.render(100, 60))).toContain('Remote control is on · Wi-Fi'))
    const shown = text(remote.render(100, 60))
    expect(shown).toContain(URL)
    expect(shown).toContain('● iPhone · Safari')
    expect(shown).toContain('█')
    expect(remote.hint()).toContain('t use Tailscale')
    expect(remote.handleInput(' ')).toBe(true)
    expect(text(remote.render(100, 60))).not.toContain('█')
    expect(text(remote.render(100, 12))).not.toContain('█')
    remote.dispose()
  })

  it('asks the person about a waiting phone and sends their answer', async () => {
    const { remote, call } = page(status({ request: { id: 'p1', label: 'iPad · Safari', at: 0 } }))
    await vi.waitFor(() => expect(text(remote.render(100, 60))).toContain('iPad · Safari wants to control this session'))
    expect(remote.hint()).toBe('a allow · d deny')
    expect(remote.handleInput('a')).toBe(true)
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.remoteControl.confirm', { requestId: 'p1', allow: true }))
    remote.dispose()
  })

  it('copies the link, makes a new one, switches network and stops', async () => {
    const { remote, call, options } = page(status())
    await vi.waitFor(() => expect(remote.hint()).toContain('c copy link'))
    remote.handleInput('c')
    expect(options.copy).toHaveBeenCalledWith(URL)
    remote.handleInput('t')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.remoteControl.start', { interface: 'tailscale' }))
    remote.handleInput('n')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.remoteControl.rotate', {}))
    remote.handleInput('x')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.remoteControl.stop', {}))
    remote.dispose()
  })
})
