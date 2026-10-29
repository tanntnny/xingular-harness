import { describe, expect, it, vi } from 'vitest'
import type { ToolSession } from '../tools/types'
import { computerScreenshotTool } from './screenshot'
import { createTerminalCaptureBridge, type TerminalCaptureHost } from './terminalCapture'

const shot = { data: 'pixels', mimeType: 'image/png' as const, width: 10, height: 20 }
function session(): ToolSession { return { run: { finished: false } } as unknown as ToolSession }
function finish(s: ToolSession, value: boolean): void { (s.run as unknown as { finished: boolean }).finished = value }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function fixture() {
  const s = session()
  const host: TerminalCaptureHost<string> = {
    selectWindow: vi.fn().mockResolvedValue('window-a'),
    approveCapture: vi.fn().mockResolvedValue(true),
    captureWindow: vi.fn(async (_session, _window, check) => { check(); return shot })
  }
  return { s, host, bridge: createTerminalCaptureBridge(s, host) }
}

describe('terminal capture bridge', () => {
  it('requires person selection and a fresh approval for every gated capture, with no target input', async () => {
    const { s, host, bridge } = fixture()
    const tool = computerScreenshotTool(s, bridge.backend)
    await expect(tool.execute({})).rejects.toThrow('No window')
    expect(await bridge.selectWindow()).toBe(true)
    await expect(tool.execute({ target: 'window-b' })).rejects.toThrow('no arguments')
    await tool.execute({})
    await tool.execute({})
    expect(host.approveCapture).toHaveBeenCalledTimes(2)
    expect(host.captureWindow).toHaveBeenCalledTimes(2)
    expect(vi.mocked(host.captureWindow).mock.calls.map(call => call[1])).toEqual(['window-a', 'window-a'])
    vi.mocked(host.approveCapture).mockResolvedValueOnce(false)
    await expect(tool.execute({})).rejects.toThrow('not approved')
    expect(host.captureWindow).toHaveBeenCalledTimes(2)
  })

  it('isolates sessions and refuses revoked, closed and stopped runs', async () => {
    const { s, host, bridge } = fixture()
    const other = session()
    const otherBridge = createTerminalCaptureBridge(other, host)
    await bridge.selectWindow()
    await expect(bridge.backend.capture(other)).rejects.toThrow('another session')
    await expect(otherBridge.backend.capture(other)).rejects.toThrow('No window')
    bridge.revoke()
    await expect(bridge.backend.capture(s)).rejects.toThrow('No window')
    await bridge.selectWindow()
    finish(s, true)
    await expect(bridge.backend.capture(s)).rejects.toThrow('run was stopped')
    finish(s, false)
    const original = s.run
    s.run = other.run
    await expect(bridge.backend.capture(s)).rejects.toThrow('run was stopped')
    s.run = original
    bridge.close()
    await expect(bridge.selectWindow()).rejects.toThrow('closed')
    await expect(bridge.backend.capture(s)).rejects.toThrow('closed')
  })

  it('invalidates in-flight selection and capture on revoke or close', async () => {
    const { s, host, bridge } = fixture()
    const choice = deferred<string | null>()
    vi.mocked(host.selectWindow).mockReturnValueOnce(choice.promise)
    const selecting = bridge.selectWindow()
    bridge.revoke()
    choice.resolve('window-a')
    await expect(selecting).rejects.toThrow('revoked')
    await bridge.selectWindow()
    const approval = deferred<boolean>()
    vi.mocked(host.approveCapture).mockReturnValueOnce(approval.promise)
    const pending = bridge.backend.capture(s)
    bridge.revoke()
    approval.resolve(true)
    await expect(pending).rejects.toThrow('revoked')
    expect(host.captureWindow).not.toHaveBeenCalled()
    await bridge.selectWindow()
    const capture = deferred<typeof shot>()
    vi.mocked(host.captureWindow).mockImplementationOnce(async (_s, _w, check) => {
      await capture.promise
      check()
      return shot
    })
    const running = bridge.backend.capture(s)
    await vi.waitFor(() => expect(host.captureWindow).toHaveBeenCalled())
    bridge.close()
    capture.resolve(shot)
    await expect(running).rejects.toThrow('closed')
  })

  it('discards late pixels, rejects concurrent captures and does not fall back on failure', async () => {
    const { s, host, bridge } = fixture()
    await bridge.selectWindow()
    const capture = deferred<typeof shot>()
    vi.mocked(host.captureWindow).mockReturnValueOnce(capture.promise)
    const pending = bridge.backend.capture(s)
    await vi.waitFor(() => expect(host.captureWindow).toHaveBeenCalled())
    await expect(bridge.backend.capture(s)).rejects.toThrow('already in progress')
    finish(s, true)
    capture.resolve(shot)
    await expect(pending).rejects.toThrow('run was stopped')
    finish(s, false)
    vi.mocked(host.captureWindow).mockRejectedValueOnce(new Error('window unavailable'))
    await expect(bridge.backend.capture(s)).rejects.toThrow('window unavailable')
    expect(host.captureWindow).toHaveBeenCalledTimes(2)
  })

  it('clears previous approval on cancelled or racing selection', async () => {
    const { s, host, bridge } = fixture()
    await bridge.selectWindow()
    vi.mocked(host.selectWindow).mockResolvedValueOnce(null)
    expect(await bridge.selectWindow()).toBe(false)
    await expect(bridge.backend.capture(s)).rejects.toThrow('No window')
    const choice = deferred<string | null>()
    vi.mocked(host.selectWindow).mockReturnValueOnce(choice.promise)
    const old = bridge.selectWindow()
    vi.mocked(host.selectWindow).mockResolvedValueOnce('window-b')
    await bridge.selectWindow()
    choice.resolve('window-a')
    await expect(old).rejects.toThrow('replaced')
    await bridge.backend.capture(s)
    expect(vi.mocked(host.captureWindow).mock.lastCall?.[1]).toBe('window-b')
  })
})
