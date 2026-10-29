import { createHash } from 'node:crypto'
import { HarnessError } from '../core/errors'
import type { ToolSession } from '../tools/types'
import { createComputerControl, type ComputerControlBackend } from './control'
import type { ComputerScreenshot } from './screenshot'

export type ComputerAction = 'click' | 'type' | 'key' | 'activate'
export interface ComputerApprovalDetails {
  action: ComputerAction
  target: string
  /** Backend window identity; the host must not use a mutable selection as its handle. */
  handle: string
  args: Record<string, unknown>
  capture?: { id: string; sha256: string; width: number; height: number; mimeType: string }
}

/** Trusted parent backend. Revalidation must refuse revoked or changed targets/captures. Each
 * effect must itself atomically enforce the control backend's point-of-effect requirements;
 * a separate revalidation cannot close the race with revocation or window changes. */
export interface ComputerBoundaryBackend extends ComputerControlBackend {
  revalidate(session: ToolSession, details: Readonly<ComputerApprovalDetails>): Promise<void>
}

/** Trusted live state, not model input. Missing/unknown state must not be reported as attended. */
export interface ComputerBoundaryState { attended: boolean; plan: boolean }

/** An unregistered parent-side boundary for one ToolSession. The caller must still route every
 * tool call through the normal gate, and keep this instance and its backend in the parent process.
 * Target selection and capture are observations; click, type, key and activate each ask anew.
 * The approval includes typed text and window identity in run events: do not use for secrets. */
export function createComputerBoundary(session: ToolSession, backend: ComputerBoundaryBackend, state: () => ComputerBoundaryState) {
  const run = session.run
  let current: { action: ComputerAction; input: Record<string, unknown> } | undefined
  let busy = false
  function check(): void {
    if (session.run !== run || run.finished) throw new HarnessError('run_stopped', 'The run was stopped; computer control is cancelled.')
    const live = state()
    if (!live || live.attended !== true || live.plan !== false) throw new HarnessError('computer_unavailable', 'Computer control requires an attended, non-plan run.')
  }
  async function approve(handle: string, shot?: ComputerScreenshot): Promise<void> {
    check()
    if (!current) throw new HarnessError('computer_error', 'Missing computer action.')
    const { action, input } = current
    const details: ComputerApprovalDetails = {
      action, target: input.target as string, handle,
      args: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'target' && key !== 'screenshot')),
      ...(shot ? { capture: { id: input.screenshot as string, sha256: createHash('sha256').update(shot.data).digest('hex'), width: shot.width, height: shot.height, mimeType: shot.mimeType } } : {})
    }
    // Pass independent copies across trust boundaries; neither approval presentation nor a backend
    // may mutate the private, approved action before the effect.
    const description = JSON.stringify(details)
    const decision = await run.requestApproval({ target: `computer_${action}`, action: description, operation: { tool: `computer_${action}`, args: JSON.parse(description) }, rememberable: false, standing: 'none' })
    check()
    if (decision !== 'approved') throw new HarnessError('computer_denied', 'Computer action was not approved.')
    await backend.revalidate(session, JSON.parse(description) as ComputerApprovalDetails)
    check()
  }
  const guarded: ComputerControlBackend = {
    target: (s) => backend.target(s),
    screenshot: (s, handle) => backend.screenshot(s, handle),
    click: async (s, handle, shot, input) => { await approve(handle, shot); check(); await backend.click(s, handle, shot, input) },
    type: async (s, handle, text) => { await approve(handle); check(); await backend.type(s, handle, text) },
    key: async (s, handle, key) => { await approve(handle); check(); await backend.key(s, handle, key) },
    activate: async (s, handle) => { await approve(handle); check(); await backend.activate(s, handle) }
  }
  const control = createComputerControl(session, guarded)
  async function call<T>(input: unknown, action: ComputerAction | undefined, execute: (copy: unknown) => Promise<T>): Promise<T> {
    check()
    if (busy) throw new HarnessError('computer_busy', 'A computer operation is already in progress.')
    // Clone before the first await, including while another actor can hold the input object.
    let copy: unknown
    try { copy = structuredClone(input) } catch { throw new HarnessError('invalid_input', 'Invalid computer control input.') }
    busy = true
    try {
      if (action) current = { action, input: copy as Record<string, unknown> }
      return await execute(copy)
    } finally { current = undefined; busy = false }
  }
  return {
    target: (input: unknown) => call(input, undefined, control.target),
    screenshot: (input: unknown) => call(input, undefined, control.screenshot),
    click: (input: unknown) => call(input, 'click', control.click),
    type: (input: unknown) => call(input, 'type', control.type),
    key: (input: unknown) => call(input, 'key', control.key),
    activate: (input: unknown) => call(input, 'activate', control.activate)
  }
}
