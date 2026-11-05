import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveRun } from '../sessions/registry'
import { TerminalController, type ControllerHooks } from './controller'

function controllerWithRun() {
  const run = { runId: 'parent', finished: false, emit: vi.fn(), onInterrupt: vi.fn(), finish: vi.fn(), requestAnswer: vi.fn(), requestApproval: vi.fn() } as unknown as ActiveRun
  const hooks = { sessionId: 's1', nativeSessionId: null, begin: () => run, telemetry: vi.fn(), interrupt: vi.fn(async () => {}), policy: vi.fn(), workspaceRoot: () => '/tmp' } as unknown as ControllerHooks
  return new TerminalController(hooks)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a poll that asks to wait', () => {
  it('answers at once without waitMs, as before', async () => {
    const controller = controllerWithRun()
    expect(await controller.accept('poll', {})).toEqual({ command: null })
  })

  it('is held until a command arrives, then returns it', async () => {
    const controller = controllerWithRun()
    let settled = false
    const parked = controller.accept('poll', { waitMs: 20_000 }).then((reply) => { settled = true; return reply })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toBe(false)
    controller.disconnected()
    expect(await parked).toEqual({ command: { type: 'interrupt' } })
  })

  it('returns no command when the wait ends quietly', async () => {
    const controller = controllerWithRun()
    const parked = controller.accept('poll', { waitMs: 3_000 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await parked).toEqual({ command: null })
  })

  it('caps the wait a caller may ask for', async () => {
    const controller = controllerWithRun()
    let settled = false
    void controller.accept('poll', { waitMs: 10 * 60_000 }).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(settled).toBe(true)
  })

  it('hands the parked wait to a newer poll, so one command is delivered once', async () => {
    const controller = controllerWithRun()
    const older = controller.accept('poll', { waitMs: 20_000 })
    const newer = controller.accept('poll', { waitMs: 20_000 })
    expect(await older).toEqual({ command: null })
    controller.disconnected()
    expect(await newer).toEqual({ command: { type: 'interrupt' } })
  })

  it('is released when the controller is disposed', async () => {
    const controller = controllerWithRun()
    const parked = controller.accept('poll', { waitMs: 20_000 })
    controller.dispose()
    expect(await parked).toEqual({ command: null })
  })

  it('ignores a waitMs that is not a number', async () => {
    const controller = controllerWithRun()
    expect(await controller.accept('poll', { waitMs: 'long' })).toEqual({ command: null })
  })
})
