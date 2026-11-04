// The remote-control pairings of a harness, one per conversation (PAR-018, INV-RC-9). A terminal
// window and a host's chat both reach theirs here; a pairing outlives the window that opened it, and
// moves to a port with no terminal behind it when the window closes during a reply.
import type { Sessions } from '../sessions/sessions'
import type { RunRegistry } from '../sessions/registry'
import type { RunEvent } from '../sessions/contracts'
import { liveSessionPort } from './liveSessionPort'
import { RemoteControl, type RemoteControlOptions, type RemoteSessionPort } from './service'

/**
 * A port whose backing can change without the phone noticing: its listeners follow the new backing,
 * and a call made after the change goes to it.
 */
export class SwitchablePort implements RemoteSessionPort {
  private readonly listeners = new Set<{ listener: (event: RunEvent) => void; stop: () => void }>()

  constructor(readonly sessionId: string, private current: RemoteSessionPort) {}

  rebind(next: RemoteSessionPort): void {
    const previous = this.current
    this.current = next
    for (const entry of this.listeners) {
      entry.stop()
      entry.stop = next.listen(entry.listener)
    }
    if (previous !== next) previous.close?.()
  }

  title(): string { return this.current.title() }
  send(text: string): Promise<{ runId: string }> { return this.current.send(text) }
  control(call: Parameters<RemoteSessionPort['control']>[0], params: Record<string, unknown>): Promise<unknown> { return this.current.control(call, params) }
  history(): RunEvent[] { return this.current.history() }
  state(): { ready: boolean; active: boolean } { return this.current.state() }

  listen(listener: (event: RunEvent) => void): () => void {
    const entry = { listener, stop: this.current.listen(listener) }
    this.listeners.add(entry)
    return () => {
      entry.stop()
      this.listeners.delete(entry)
    }
  }

  close(): void {
    for (const entry of this.listeners) entry.stop()
    this.listeners.clear()
    this.current.close?.()
  }
}

/** Who ends a pairing besides `stop`: a terminal window ends its own; a host's lasts as long as the live session. */
export type PairingOwner = 'terminal' | 'host'

interface Pairing {
  control: RemoteControl
  port: SwitchablePort
  owner: PairingOwner
  /** What the port is bound to, so the same binding is not made twice. */
  binding: unknown
}

export interface RemoteSessionsOptions {
  root(): string
  runs: RunRegistry
  sessions: Sessions
  productName: string
  allowTool(target: string): void
  remoteControl?: RemoteControlOptions
}

export class RemoteSessions {
  private readonly pairings = new Map<string, Pairing>()
  private readonly stopEnd: () => void

  constructor(private readonly options: RemoteSessionsOptions) {
    // A host's pairing ends with the conversation's live session; a terminal's ends with its window.
    this.stopEnd = options.sessions.live.onEnd((sessionId) => {
      if (this.pairings.get(sessionId)?.owner === 'host') void this.end(sessionId)
    })
  }

  has(sessionId: string): boolean {
    return this.pairings.has(sessionId)
  }

  /** The pairing of a conversation, made with `make` for `binding` when it has none; a new binding replaces the old port. */
  open(sessionId: string, owner: PairingOwner, binding: unknown, make: () => RemoteSessionPort): RemoteControl {
    const existing = this.pairings.get(sessionId)
    if (existing) {
      if (existing.binding !== binding) {
        existing.port.rebind(make())
        existing.binding = binding
        existing.owner = owner
      }
      return existing.control
    }
    const port = new SwitchablePort(sessionId, make())
    const control = new RemoteControl(port, { productName: this.options.productName, ...this.options.remoteControl })
    this.pairings.set(sessionId, { control, port, owner, binding })
    return control
  }

  /** A host's pairing for a conversation with a live session, opened on first use. */
  forLive(sessionId: string): RemoteControl | null {
    const existing = this.pairings.get(sessionId)
    if (existing) return existing.control
    if (!this.options.sessions.live.status(sessionId)) return null
    return this.open(sessionId, 'host', 'live', () => this.livePort(sessionId))
  }

  /** The window closed with a reply running: the pairing stays, served by the live session alone. */
  keepLive(sessionId: string): void {
    const pairing = this.pairings.get(sessionId)
    if (!pairing) return
    pairing.port.rebind(this.livePort(sessionId))
    pairing.binding = 'live'
  }

  livePort(sessionId: string): RemoteSessionPort {
    return liveSessionPort({
      sessionId, root: this.options.root(), runs: this.options.runs, sessions: this.options.sessions,
      productName: this.options.productName, allowTool: this.options.allowTool
    })
  }

  /** Pairings listening for a phone now, so a harness that is otherwise idle knows it is not. */
  running(): number {
    let count = 0
    for (const { control } of this.pairings.values()) if (control.status().running) count += 1
    return count
  }

  /** Ends a conversation's pairing: the server closes, connected phones are told, every key is forgotten. */
  async end(sessionId: string): Promise<void> {
    const pairing = this.pairings.get(sessionId)
    if (!pairing) return
    this.pairings.delete(sessionId)
    await pairing.control.dispose().catch(() => undefined)
    pairing.port.close()
  }

  async close(): Promise<void> {
    this.stopEnd()
    await Promise.all([...this.pairings.keys()].map((sessionId) => this.end(sessionId)))
  }
}
