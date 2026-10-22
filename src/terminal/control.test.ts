import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ socket: vi.fn(async (_connection: unknown, call: string) => call === 'control.claim' ? { key: 'lexical-secret' } : { done: true }), env: { socket: '/fake/socket', token: 'unique-control-test' } }))
vi.mock('./client', () => ({ connectionFromEnv: () => calls.env, socketCall: calls.socket }))

import { claimTerminalControl, controlCall } from './control'

describe('the process-lifetime terminal control claim', () => {
  it('shares one concurrent claim with the bridge and frontend and passes the key only in protected calls', async () => {
    const [first, second] = await Promise.all([claimTerminalControl(), claimTerminalControl()])
    expect(first).toBe('lexical-secret')
    expect(second).toBe(first)
    await expect(controlCall('terminal.pending', { cursor: 'question' }, 321)).resolves.toEqual({ done: true })
    expect(calls.socket.mock.calls.filter(([, call]) => call === 'control.claim')).toHaveLength(1)
    expect(calls.socket).toHaveBeenLastCalledWith(calls.env, 'terminal.pending', { cursor: 'question' }, 321, 'lexical-secret')
    expect(calls.env).toEqual({ socket: '/fake/socket', token: 'unique-control-test' })
  })

  it('keeps a different terminal grant separate', async () => {
    await claimTerminalControl({ socket: '/fake/socket', token: 'different-terminal' })
    expect(calls.socket.mock.calls.filter(([, call]) => call === 'control.claim')).toHaveLength(2)
  })

  it('retries a claim that failed instead of keeping the failure', async () => {
    const terminal = { socket: '/fake/socket', token: 'retry-after-failure' }
    calls.socket.mockRejectedValueOnce(new Error('The harness did not answer control.claim.'))
    await expect(claimTerminalControl(terminal)).rejects.toThrow('did not answer')
    await expect(claimTerminalControl(terminal)).resolves.toBe('lexical-secret')
  })
})
