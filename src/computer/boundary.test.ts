import { describe, expect, it, vi } from 'vitest'
import type { ToolSession } from '../tools/types'
import { createComputerBoundary, type ComputerBoundaryBackend } from './boundary'

function fixture() {
  const run = { finished: false, requestApproval: vi.fn().mockResolvedValue('approved') }
  const session = { run } as unknown as ToolSession
  const state = { attended: true, plan: false }
  const backend: ComputerBoundaryBackend = {
    target: vi.fn().mockResolvedValue('window-1'),
    screenshot: vi.fn().mockResolvedValue({ data: 'pixels', mimeType: 'image/png', width: 10, height: 20 }),
    click: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined),
    key: vi.fn().mockResolvedValue(undefined), activate: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn().mockResolvedValue(undefined)
  }
  return { run, state, backend, boundary: createComputerBoundary(session, backend, () => state) }
}

describe('computer parent boundary', () => {
  it('asks freshly for each action with exact parameters and capture identity, never standing', async () => {
    const { boundary, run, backend } = fixture()
    const { target } = await boundary.target({})
    const shot = await boundary.screenshot({ target })
    await boundary.click({ target, screenshot: shot.screenshot, x: 3, y: 4, button: 'left' })
    await boundary.type({ target, text: 'hello' })
    await boundary.key({ target, key: 'Enter' })
    await boundary.activate({ target })
    expect(run.requestApproval).toHaveBeenCalledTimes(4)
    const request = run.requestApproval.mock.calls[0][0]
    expect(request).toMatchObject({ target: 'computer_click', standing: 'none', rememberable: false })
    const details = JSON.parse(request.action)
    expect(details).toMatchObject({ action: 'click', target, handle: 'window-1', args: { x: 3, y: 4, button: 'left' }, capture: { id: shot.screenshot, width: 10, height: 20, mimeType: 'image/png' } })
    expect(details.capture.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(request.operation.args).toEqual(details)
    expect(backend.revalidate).toHaveBeenCalledTimes(4)
    expect(backend.click).toHaveBeenCalledTimes(1)
    expect(JSON.parse(run.requestApproval.mock.calls[1][0].action).args).toEqual({ text: 'hello' })
    await expect(boundary.click({ target, screenshot: shot.screenshot, x: 3, y: 4, button: 'left' })).rejects.toThrow('stale')
    expect(run.requestApproval).toHaveBeenCalledTimes(4)
  })
  it('fails closed for denial, native resolution, unattended, plan and stopped runs', async () => {
    const { boundary, run, state, backend } = fixture()
    const { target } = await boundary.target({})
    for (const decision of ['denied', 'native']) {
      run.requestApproval.mockResolvedValueOnce(decision)
      await expect(boundary.activate({ target })).rejects.toThrow('not approved')
    }
    state.attended = false
    await expect(boundary.activate({ target })).rejects.toThrow('attended')
    state.attended = true; state.plan = true
    await expect(boundary.activate({ target })).rejects.toThrow('attended')
    state.plan = false; run.finished = true
    await expect(boundary.activate({ target })).rejects.toThrow('stopped')
    expect(backend.revalidate).not.toHaveBeenCalled()
    expect(backend.activate).not.toHaveBeenCalled()
  })
  it('revalidates after approval and never retries a refused or failed effect', async () => {
    const { boundary, backend } = fixture()
    const { target } = await boundary.target({})
    vi.mocked(backend.revalidate).mockRejectedValueOnce(new Error('revoked'))
    await expect(boundary.activate({ target })).rejects.toThrow('revoked')
    expect(backend.activate).not.toHaveBeenCalled()
    vi.mocked(backend.activate).mockRejectedValueOnce(new Error('partial effect'))
    await expect(boundary.activate({ target })).rejects.toThrow('partial effect')
    expect(backend.activate).toHaveBeenCalledTimes(1)
  })
  it('cancels when the run or state changes during approval or revalidation', async () => {
    for (const stage of ['approval', 'revalidation'] as const) {
      const { boundary, backend, run, state } = fixture()
      const { target } = await boundary.target({})
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      if (stage === 'approval') run.requestApproval.mockImplementationOnce(async () => { await wait; return 'approved' })
      else vi.mocked(backend.revalidate).mockImplementationOnce(async () => { await wait })
      const pending = boundary.activate({ target })
      await vi.waitFor(() => expect(stage === 'approval' ? run.requestApproval : backend.revalidate).toHaveBeenCalled())
      if (stage === 'approval') run.finished = true
      else state.plan = true
      release()
      await expect(pending).rejects.toThrow(stage === 'approval' ? 'stopped' : 'attended')
      expect(backend.activate).not.toHaveBeenCalled()
    }
  })
  it('snapshots input, isolates approval and revalidation mutations, and rejects concurrent calls', async () => {
    const { boundary, run, backend } = fixture()
    const { target } = await boundary.target({})
    let release!: () => void
    run.requestApproval.mockImplementationOnce(async (request) => {
      request.operation.args.args.text = 'tampered'
      await new Promise<void>(resolve => { release = resolve })
      return 'approved'
    })
    vi.mocked(backend.revalidate).mockImplementationOnce(async (_session, details) => { details.args.text = 'tampered again' })
    const input = { target, text: 'original' }
    const pending = boundary.type(input)
    input.text = 'changed'
    await expect(boundary.activate({ target })).rejects.toThrow('already in progress')
    release()
    await pending
    expect(backend.type).toHaveBeenCalledWith(expect.anything(), 'window-1', 'original')
    expect(JSON.parse(run.requestApproval.mock.calls[0][0].action).args.text).toBe('original')
  })
})
