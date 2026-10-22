import { describe, expect, it, vi } from 'vitest'
import { remoteTools } from '../server/remote'
import type { RpcPeer } from '../server/rpc'
import type { DoctorProbeContext } from './types'

const context = { caller: {}, cwd: '/tmp', accountId: null, model: null, tools: ['host_read'] }
describe('remote provider diagnostics', () => {
  it('keeps existing provider registrations compatible', async () => {
    const handlers = new Map<string, (params: any) => unknown>()
    const callHost = vi.fn()
    const provider = remoteTools({ handle: (name: string, action: (params: any) => unknown) => handlers.set(name, action), callHost } as unknown as RpcPeer)
    expect(handlers.get('tools.register')!({ tools: [] })).toEqual({ registered: [] })
    expect(await provider.diagnostics!(context)).toEqual([])
    expect(callHost).not.toHaveBeenCalled()
  })
  it('separates passive host inspection from a gated single-tool live recipe', async () => {
    const handlers = new Map<string, (params: any) => unknown>()
    const callHost = vi.fn(async () => ({ status: 'pass', evidence: 'Backend configured.' }))
    const provider = remoteTools({ handle: (name: string, action: (params: any) => unknown) => handlers.set(name, action), callHost } as unknown as RpcPeer)
    handlers.get('tools.register')!({ tools: [], diagnostics: [{ id: 'read', title: 'Host read', category: 'host', tools: ['host_read'], probe: { notice: 'Read a synthetic marker', tool: 'host_read', input: { test: true }, contains: 'expected' } }] })
    const [check] = await provider.diagnostics!(context)
    expect((await check.local(new AbortController().signal)).status).toBe('pass')
    expect(callHost).toHaveBeenCalledExactlyOnceWith('tools.diagnose', { id: 'read', context }, 8000)
    const call = vi.fn(async () => 'expected')
    expect((await check.live!.run({ call } as unknown as DoctorProbeContext)).status).toBe('pass')
    expect(call).toHaveBeenCalledExactlyOnceWith('host_read', { test: true })
  })
})
