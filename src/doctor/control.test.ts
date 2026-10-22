import { describe, expect, it, vi } from 'vitest'
import { SessionSocket } from '../terminal/socket'

describe('Doctor terminal authorization', () => {
  it('requires the private control key for starts, reads and cancellation', async () => {
    const control = vi.fn(async () => ({ id: 'diagnostic' }))
    const socket = new SessionSocket('/unused-doctor-test.sock', { memory: () => '', apps: async () => null })
    const token = socket.issue({ sessionId: 'session', caller: () => ({}), broker: null, terminal: { accept: async () => null, disconnected: () => {}, control } })
    for (const call of ['terminal.doctor.start', 'terminal.doctor.read', 'terminal.doctor.cancel']) {
      expect(await socket.handle(JSON.stringify({ token, call }))).toMatchObject({ error: { code: 'unauthorized' } })
    }
    expect(control).not.toHaveBeenCalled()
    const claimed = await socket.handle(JSON.stringify({ token, call: 'control.claim' })) as { result: { key: string } }
    expect(await socket.handle(JSON.stringify({ token, control: claimed.result.key, call: 'terminal.doctor.start' }))).toEqual({ result: { id: 'diagnostic' } })
    expect(control).toHaveBeenCalledExactlyOnceWith('terminal.doctor.start', {})
    socket.revoke(token)
    expect(await socket.handle(JSON.stringify({ token, control: claimed.result.key, call: 'terminal.doctor.read' }))).toMatchObject({ error: { code: 'unauthorized' } })
  })
})
