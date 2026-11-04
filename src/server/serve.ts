// Serves a harness to a host process over a transport: every method in the table, run events
// as they are recorded, and notices when state changes.
import type { Harness } from '../harness'
import { methods } from './methods'
import type { RunEvent } from '../sessions/contracts'
import { RpcPeer, type Handler, type Transport } from './rpc'

export interface Served {
  peer: RpcPeer
  /** Stops live work and releases what the harness holds. */
  shutdown(): Promise<void>
}

/**
 * Registers the method table on `peer` and forwards events and notices to it. Returns what stops the
 * forwarding, for a peer that goes away before the harness does (a socket connection).
 */
export function attach(harness: Harness, peer: RpcPeer, options: { deliver?(event: RunEvent): boolean; wrap?(name: string, handler: Handler): Handler } = {}): () => void {
  for (const [name, handler] of Object.entries(methods(harness))) peer.handle(name, options.wrap ? options.wrap(name, handler) : handler)
  peer.handle('harness.methods', () => peer.methods())
  const stopEvents = harness.runs.listen((event) => {
    if (!options.deliver || options.deliver(event)) peer.send({ event })
  })
  const stopNotices = harness.bus.on((notice) => peer.send({ notice }))
  return () => {
    stopEvents()
    stopNotices()
  }
}

export function serve(harness: Harness, transport: Transport): Served {
  const peer = new RpcPeer(transport)
  attach(harness, peer)
  let closing: Promise<void> | null = null
  const shutdown = (): Promise<void> => (closing ??= harness.close())
  peer.handle('harness.shutdown', () => shutdown())
  return { peer, shutdown }
}
