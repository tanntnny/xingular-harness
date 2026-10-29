import { HarnessError } from '../core/errors'
import type { ToolSession } from '../tools/types'
import type { ComputerScreenshot, ComputerScreenshotBackend } from './screenshot'

/** Trusted host code only. Selection must be a person-controlled choice of one exact window,
 * not a model-supplied identifier or a remembered tool grant. Null means no approval. */
export interface TerminalCaptureHost<Window> {
  selectWindow(session: ToolSession): Promise<Window | null>
  /** A fresh human decision for this exact window and capture, never a standing approval. */
  approveCapture(session: ToolSession, window: Window): Promise<boolean>
  /** At the point of capture, enforce the screenshot.ts isolation contract, exact window identity,
   * current person approval, run/session liveness and revocation atomically with capture. Call
   * check() at that point; it is necessary but not sufficient to enforce OS/host isolation.
   * Never fall back to a display or another window. Refuse if any guarantee is unavailable. */
  captureWindow(session: ToolSession, window: Window, check: () => void): Promise<ComputerScreenshot>
}

export interface TerminalCaptureBridge {
  /** Only expose this backend to the normal gated screenshot tool. */
  backend: ComputerScreenshotBackend
  /** Trusted person-facing wiring only; never expose selection/revocation as model tools. */
  selectWindow(): Promise<boolean>
  revoke(): void
  /** Permanently closes the session bridge. */
  close(): void
}

/** One parent-owned instance per ToolSession and run. Neither this adapter nor an opaque window
 * handle proves that an injected host can enforce isolation; the host is the security boundary. */
export function createTerminalCaptureBridge<Window>(session: ToolSession, host: TerminalCaptureHost<Window>): TerminalCaptureBridge {
  const run = session.run
  let closed = false
  let generation = 0
  let selected: { window: Window; generation: number } | undefined
  let busy = false

  function live(): void {
    if (closed) throw new HarnessError('computer_unavailable', 'The capture session is closed.')
    if (session.run !== run || run.finished) throw new HarnessError('run_stopped', 'The run was stopped; capture is cancelled.')
  }
  function revoke(): void { generation++; selected = undefined }
  function current(selection: NonNullable<typeof selected>): void {
    live()
    if (selected !== selection || generation !== selection.generation) throw new HarnessError('computer_target_unavailable', 'The approved window is unavailable or revoked.')
  }
  return {
    backend: {
      async capture(request): Promise<ComputerScreenshot> {
        live()
        if (request !== session || request.run !== run) throw new HarnessError('computer_unavailable', 'Capture belongs to another session or run.')
        if (busy) throw new HarnessError('computer_busy', 'A capture is already in progress.')
        const selection = selected
        if (!selection) throw new HarnessError('computer_target_unavailable', 'No window is approved for this session.')
        busy = true
        try {
          const approved = await host.approveCapture(session, selection.window)
          current(selection)
          if (approved !== true) throw new HarnessError('computer_denied', 'Window capture was not approved.')
          const shot = await host.captureWindow(session, selection.window, () => current(selection))
          current(selection)
          return shot
        } finally { busy = false }
      }
    },
    async selectWindow(): Promise<boolean> {
      live()
      revoke()
      const revision = generation
      const window = await host.selectWindow(session)
      live()
      if (revision !== generation) throw new HarnessError('computer_target_unavailable', 'Window selection was revoked or replaced.')
      if (window === null || window === undefined) return false
      selected = { window, generation: revision }
      return true
    },
    revoke,
    close(): void { closed = true; revoke() }
  }
}
