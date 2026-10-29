import { describe, expect, it, vi } from 'vitest'
import type { ToolSession } from '../tools/types'
import { COMPUTER_CONTROL_SCHEMAS, COMPUTER_LIMITS } from './contracts'
import { createComputerControl, type ComputerControlBackend } from './control'

function fixture() {
  const session = { run: { finished: false } } as unknown as ToolSession
  const backend: ComputerControlBackend = {
    target: vi.fn().mockResolvedValue('host-window'),
    screenshot: vi.fn().mockResolvedValue({ data: 'pixels', mimeType: 'image/png', width: 10, height: 20 }),
    click: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined),
    key: vi.fn().mockResolvedValue(undefined), activate: vi.fn().mockResolvedValue(undefined)
  }
  return { session, backend, control: createComputerControl(session, backend) }
}

describe('bounded computer control', () => {
  it('publishes closed schemas for each operation', () => {
    expect(Object.keys(COMPUTER_CONTROL_SCHEMAS)).toEqual(['target', 'screenshot', 'click', 'type', 'key', 'activate'])
    for (const schema of Object.values(COMPUTER_CONTROL_SCHEMAS)) expect(schema.additionalProperties).toBe(false)
  })
  it('binds opaque targets and screenshot pixels to one session and invalidates after an action', async () => {
    const { session, backend, control } = fixture()
    const { target } = await control.target({})
    expect(target).not.toBe('host-window')
    const shot = await control.screenshot({ target })
    await control.click({ target, screenshot: shot.screenshot, x: 9, y: 19, button: 'left' })
    expect(backend.click).toHaveBeenCalledWith(session, 'host-window', expect.objectContaining({ width: 10 }), { x: 9, y: 19, button: 'left' })
    await expect(control.click({ target, screenshot: shot.screenshot, x: 0, y: 0, button: 'left' })).rejects.toThrow('stale')
    await expect(fixture().control.screenshot({ target })).rejects.toThrow('stale')
    await control.type({ target, text: 'hello' })
    await control.key({ target, key: 'Enter' })
    await control.activate({ target })
    expect(backend.type).toHaveBeenCalledWith(session, 'host-window', 'hello')
    expect(backend.key).toHaveBeenCalledWith(session, 'host-window', 'Enter')
    expect(backend.activate).toHaveBeenCalledWith(session, 'host-window')
  })
  it('rejects malformed inputs and out-of-bounds actions without calling the backend', async () => {
    const { control, backend } = fixture()
    await expect(control.target(null)).rejects.toThrow('Invalid')
    await expect(control.target({ extra: 1 })).rejects.toThrow('Invalid')
    const { target } = await control.target({})
    const shot = await control.screenshot({ target })
    for (const args of [
      { target, screenshot: shot.screenshot, x: -1, y: 0, button: 'left' },
      { target, screenshot: shot.screenshot, x: 10, y: 0, button: 'left' },
      { target, screenshot: shot.screenshot, x: 0, y: 20, button: 'left' },
      { target, screenshot: shot.screenshot, x: 0.5, y: 0, button: 'left' },
      { target, screenshot: shot.screenshot, x: 0, y: 0, button: 'other' }
    ]) await expect(control.click(args)).rejects.toThrow('Invalid')
    for (const text of ['', 'a\n', 'x'.repeat(COMPUTER_LIMITS.text + 1)]) await expect(control.type({ target, text })).rejects.toThrow('Invalid')
    await expect(control.key({ target, key: 'Meta+Q' })).rejects.toThrow('Invalid')
    await expect(control.activate({ target, other: true })).rejects.toThrow('Invalid')
    expect(backend.click).not.toHaveBeenCalled()
    expect(backend.type).not.toHaveBeenCalled()
    expect(backend.key).not.toHaveBeenCalled()
  })
  it('fails closed for absent backends, invalid results, backend refusals and stopped runs', async () => {
    const { session, backend, control } = fixture()
    await expect(createComputerControl(session).target({})).rejects.toThrow('unavailable')
    vi.mocked(backend.target).mockResolvedValueOnce('')
    await expect(control.target({})).rejects.toThrow('invalid target')
    const { target } = await control.target({})
    vi.mocked(backend.screenshot).mockResolvedValueOnce({ data: 'x', mimeType: 'image/png', width: Infinity, height: 1 })
    await expect(control.screenshot({ target })).rejects.toThrow('invalid window capture')
    vi.mocked(backend.activate).mockRejectedValueOnce(new Error('not approved'))
    await expect(control.activate({ target })).rejects.toThrow('not approved')
    Object.assign(session.run, { finished: true })
    await expect(control.activate({ target })).rejects.toThrow('run was stopped')
  })
  it('discards captures when stopped and rejects concurrent operations', async () => {
    const { session, backend, control } = fixture()
    const { target } = await control.target({})
    let release!: () => void
    vi.mocked(backend.screenshot).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { data: 'x', mimeType: 'image/jpeg', width: 1, height: 1 }
    })
    const pending = control.screenshot({ target })
    await expect(control.activate({ target })).rejects.toThrow('already in progress')
    Object.assign(session.run, { finished: true })
    release()
    await expect(pending).rejects.toThrow('run was stopped')
  })
  it('invalidates old targets and captures after reselection or a failed action', async () => {
    const { control, backend } = fixture()
    const first = await control.target({})
    const shot = await control.screenshot(first)
    vi.mocked(backend.click).mockRejectedValueOnce(new Error('refused'))
    await expect(control.click({ ...first, screenshot: shot.screenshot, x: 0, y: 0, button: 'left' })).rejects.toThrow('refused')
    await expect(control.click({ ...first, screenshot: shot.screenshot, x: 0, y: 0, button: 'left' })).rejects.toThrow('stale')
    await control.target({})
    await expect(control.screenshot(first)).rejects.toThrow('stale')
  })
})
