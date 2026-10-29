import { randomUUID } from 'node:crypto'
import { HarnessError } from '../core/errors'
import type { ToolSession } from '../tools/types'
import { COMPUTER_KEYS, COMPUTER_LIMITS, type ComputerButton, type ComputerControlScreenshot, type ComputerKey, type ComputerTarget } from './contracts'
import type { ComputerScreenshot } from './screenshot'

/**
 * The host resolves only the window currently approved for this session. The opaque handle must
 * identify that exact window, not a display or a mutable selection. Each operation must atomically
 * revalidate session approval, window identity and run liveness at the point of effect. Capture
 * obeys ComputerScreenshotBackend's isolation contract. Click coordinates are capture pixels;
 * the host must refuse if geometry, scaling, visibility or focus makes that mapping unsafe.
 * Type and key must not reach another window or sensitive fields. Unsupported operations refuse;
 * there is no fallback. A host unable to guarantee these conditions must not supply a backend.
 */
export interface ComputerControlBackend {
  target(session: ToolSession): Promise<string>
  screenshot(session: ToolSession, handle: string): Promise<ComputerScreenshot>
  click(session: ToolSession, handle: string, screenshot: ComputerScreenshot, input: { x: number; y: number; button: ComputerButton }): Promise<void>
  type(session: ToolSession, handle: string, text: string): Promise<void>
  key(session: ToolSession, handle: string, key: ComputerKey): Promise<void>
  activate(session: ToolSession, handle: string): Promise<void>
}

function invalid(): never { throw new HarnessError('invalid_input', 'Invalid computer control input.') }
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid()
  return value
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= COMPUTER_LIMITS.id && !/[\x00-\x1f\x7f]/.test(value)
}
function stopped(session: ToolSession): void {
  if (session.run.finished) throw new HarnessError('run_stopped', 'The run was stopped; computer control is cancelled.')
}

/** One instance is bound to one trusted ToolSession. Calls must still pass the normal tool gate;
 * this adapter does not implement human per-action approval. Do not share instances across runs. */
export function createComputerControl(session: ToolSession, backend?: ComputerControlBackend) {
  let selected: { id: string; handle: string } | undefined
  let captured: { id: string; shot: ComputerScreenshot } | undefined
  let busy = false
  async function operation<T>(fn: (backend: ComputerControlBackend) => Promise<T>): Promise<T> {
    stopped(session)
    if (!backend) throw new HarnessError('computer_unavailable', 'Computer control is unavailable: no approved-window backend.')
    if (busy) throw new HarnessError('computer_busy', 'A computer operation is already in progress.')
    busy = true
    try {
      const result = await fn(backend)
      stopped(session)
      return result
    } finally { busy = false }
  }
  function handle(input: Record<string, unknown>): string {
    if (!identifier(input.target)) return invalid()
    if (!selected || input.target !== selected.id) throw new HarnessError('computer_target_unavailable', 'The approved target is unavailable or stale.')
    return selected.handle
  }
  return {
    async target(input: unknown): Promise<ComputerTarget> {
      object(input, [])
      return operation(async host => {
        selected = undefined
        captured = undefined
        const resolved = await host.target(session)
        if (!identifier(resolved)) throw new HarnessError('computer_error', 'The host returned an invalid target.')
        stopped(session)
        selected = { id: randomUUID(), handle: resolved }
        return { target: selected.id }
      })
    },
    async screenshot(input: unknown): Promise<ComputerControlScreenshot> {
      const args = object(input, ['target'])
      const target = handle(args)
      return operation(async host => {
        captured = undefined
        const shot = await host.screenshot(session, target)
        if (!shot || typeof shot.data !== 'string' || !shot.data || shot.data.length > COMPUTER_LIMITS.imageData || !['image/png', 'image/jpeg'].includes(shot.mimeType) || !Number.isSafeInteger(shot.width) || shot.width <= 0 || shot.width > COMPUTER_LIMITS.dimension || !Number.isSafeInteger(shot.height) || shot.height <= 0 || shot.height > COMPUTER_LIMITS.dimension) throw new HarnessError('computer_error', 'The host returned an invalid window capture.')
        stopped(session)
        captured = { id: randomUUID(), shot: { ...shot } }
        return { screenshot: captured.id, data: shot.data, mimeType: shot.mimeType, width: shot.width, height: shot.height }
      })
    },
    async click(input: unknown): Promise<void> {
      const args = object(input, ['target', 'screenshot', 'x', 'y', 'button'])
      const target = handle(args)
      if (!identifier(args.screenshot) || !Number.isSafeInteger(args.x) || !Number.isSafeInteger(args.y) || !['left', 'right', 'middle'].includes(args.button as string)) return invalid()
      if (!captured || args.screenshot !== captured.id) throw new HarnessError('computer_screenshot_stale', 'The screenshot is unavailable or stale.')
      const shot = captured.shot
      const x = args.x as number, y = args.y as number
      if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) return invalid()
      const button = args.button as ComputerButton
      return operation(async host => { captured = undefined; await host.click(session, target, shot, { x, y, button }) })
    },
    async type(input: unknown): Promise<void> {
      const args = object(input, ['target', 'text'])
      const target = handle(args)
      if (typeof args.text !== 'string' || !args.text.length || args.text.length > COMPUTER_LIMITS.text || /[\x00-\x1f\x7f]/.test(args.text)) return invalid()
      const text = args.text
      return operation(async host => { captured = undefined; await host.type(session, target, text) })
    },
    async key(input: unknown): Promise<void> {
      const args = object(input, ['target', 'key'])
      const target = handle(args)
      if (typeof args.key !== 'string' || !(COMPUTER_KEYS as readonly string[]).includes(args.key)) return invalid()
      const key = args.key as ComputerKey
      return operation(async host => { captured = undefined; await host.key(session, target, key) })
    },
    async activate(input: unknown): Promise<void> {
      const args = object(input, ['target'])
      const target = handle(args)
      return operation(async host => { captured = undefined; await host.activate(session, target) })
    }
  }
}
