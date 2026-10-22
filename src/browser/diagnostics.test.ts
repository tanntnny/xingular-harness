import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { browserPart } from './index'
import { writeBrowserConfig } from './config'
import { describe, expect, it, vi } from 'vitest'
import { browserDiagnostic } from './diagnostics'
import type { BrowserConfig } from './config'
import type { DoctorProbeContext } from '../doctor/types'

const harness = (cdpUrl: string | null = null) => (() => ({ cdpUrl }) as BrowserConfig)
const context = { caller: {}, cwd: '/tmp', accountId: null, model: null, tools: ['browser_navigate', 'browser_read', 'browser_snapshot', 'browser_click'] }

describe('browser diagnostic', () => {
  it('reads and clicks only the synthetic offline page through gated calls', async () => {
    const call = vi.fn().mockResolvedValueOnce('Opened').mockResolvedValueOnce('doctor-ready').mockResolvedValueOnce('- button "Diagnostic test" [ref=e4]').mockResolvedValueOnce('Clicked').mockResolvedValueOnce('doctor-clicked')
    const result = await browserDiagnostic(harness()).live!.run({ context, call } as unknown as DoctorProbeContext)
    expect(result.status).toBe('pass')
    expect(call.mock.calls[0][0]).toBe('browser_navigate')
    expect(call.mock.calls[0][1].url).toMatch(/^data:text\/html,/)
    expect(call).toHaveBeenCalledWith('browser_click', { ref: 'e4' })
  })
  it('refuses to attach to a configured existing browser', async () => {
    const call = vi.fn()
    const result = await browserDiagnostic(harness('http://localhost:9222')).live!.run({ context, call } as unknown as DoctorProbeContext)
    expect(result.status).toBe('blocked')
    expect(call).not.toHaveBeenCalled()
  })
  it('does not claim success when page reading or interaction fails', async () => {
    const call = vi.fn().mockResolvedValue('No expected marker')
    const result = await browserDiagnostic(harness()).live!.run({ context, call } as unknown as DoctorProbeContext)
    expect(result.status).toBe('fail')
    expect(call).toHaveBeenCalledTimes(2)
  })
})


describe('diagnostic browser isolation', () => {
  it('launches without a kept profile or visible window and removes its own downloads folder', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'doctor-browser-'))
    writeBrowserConfig(stateDir, { headed: true })
    const launch = vi.fn(async () => { throw new Error('Synthetic launch failure') })
    const part = browserPart({ stateDir, launch })
    try {
      await part.tools({ caller: { surface: 'doctor' }, run: null, attended: true, subagent: false, sessionKey: 'doctor-session', cwd: stateDir }).find(tool => tool.name === 'browser_navigate')!.execute({ url: 'data:text/html,diagnostic' })
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ profileDir: null, config: expect.objectContaining({ headed: false, cdpUrl: null }) }))
      await part.release!('doctor-session')
      expect(existsSync(join(stateDir, 'browser', 'downloads', 'doctor-session'))).toBe(false)
    } finally { await part.close!(); rmSync(stateDir, { recursive: true, force: true }) }
  })
  it('cleans up a browser that finishes launching after cancellation', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'doctor-browser-cancel-'))
    let complete: (value: { context: BrowserContext; browser: null; attached: boolean }) => void = () => undefined
    const launch = vi.fn(() => new Promise<{ context: BrowserContext; browser: null; attached: boolean }>(resolve => { complete = resolve }))
    const close = vi.fn(async () => {})
    const backend = { setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), route: vi.fn(async () => {}), on: vi.fn(), pages: () => [], close } as unknown as BrowserContext
    const part = browserPart({ stateDir, launch })
    try {
      const navigation = part.tools({ caller: { surface: 'doctor' }, run: null, attended: true, subagent: false, sessionKey: 'cancelled', cwd: stateDir }).find(tool => tool.name === 'browser_navigate')!.execute({ url: 'data:text/html,test' })
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
      const release = part.release!('cancelled')
      complete({ context: backend, browser: null, attached: false })
      await Promise.all([navigation, release])
      expect(close).toHaveBeenCalledOnce()
      expect(part.sessions.size).toBe(0)
      expect(existsSync(join(stateDir, 'browser', 'downloads', 'cancelled'))).toBe(false)
    } finally { await part.close!(); rmSync(stateDir, { recursive: true, force: true }) }
  })
})
