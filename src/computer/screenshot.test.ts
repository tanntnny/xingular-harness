import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import { COMPUTER_SCREENSHOT_DEFINITION, COMPUTER_SCREENSHOT_UNAVAILABLE, computerScreenshotTool } from './screenshot'
import type { ToolSession } from '../tools/types'

function session(): ToolSession {
  return { run: { finished: false }, caller: {}, allow: ['computer_screenshot'] } as unknown as ToolSession
}

describe('host-backed computer screenshot', () => {
  it('exposes an empty closed schema and explicit unavailability', () => {
    const tool = computerScreenshotTool(session(), { capture: vi.fn() })
    expect(tool.parameters(Type)).toMatchObject(COMPUTER_SCREENSHOT_DEFINITION.inputSchema)
    expect(COMPUTER_SCREENSHOT_UNAVAILABLE).toContain('unavailable')
    expect(tool.readOnly).toBeUndefined()
  })

  it('passes trusted session to the backend and preserves image and attachment references', async () => {
    const current = session()
    const attachments = [{ id: 'a', name: 'capture', mimeType: 'image/png' }]
    const capture = vi.fn().mockResolvedValue({ data: 'pixels', mimeType: 'image/png', width: 10, height: 20, attachments })
    expect(await computerScreenshotTool(current, { capture }).execute({})).toEqual({ text: 'Screenshot 10×20.', image: { data: 'pixels', mimeType: 'image/png' }, attachments })
    expect(capture).toHaveBeenCalledWith(current)
  })

  it('refuses arguments, stopped runs, invalid captures and propagates backend refusals', async () => {
    const current = session()
    const capture = vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png', width: 10, height: 20 })
    const tool = computerScreenshotTool(current, { capture })
    await expect(tool.execute({ window: 'other' })).rejects.toThrow('takes no arguments')
    expect(capture).not.toHaveBeenCalled()
    await expect(tool.execute({})).rejects.toThrow('invalid window capture')
    capture.mockRejectedValueOnce(new Error('not approved'))
    await expect(tool.execute({})).rejects.toThrow('not approved')
    Object.assign(current.run, { finished: true })
    await expect(tool.execute({})).rejects.toThrow('run was stopped')
  })

  it('discards a capture when the run stops while the backend is capturing', async () => {
    const current = session()
    const tool = computerScreenshotTool(current, { capture: async () => {
      Object.assign(current.run, { finished: true })
      return { data: 'pixels', mimeType: 'image/jpeg', width: 1, height: 1 }
    } })
    await expect(tool.execute({})).rejects.toThrow('run was stopped')
  })
})
