// Serves a harness to a host process over a transport: every method in the table, run events
// as they are recorded, and notices when state changes.
import type { Harness } from '../harness'
import { methods } from './methods'
import { RpcPeer, type Transport } from './rpc'

export interface Served {
  peer: RpcPeer
  /** Stops live work and releases what the harness holds. */
  shutdown(): Promise<void>
}

/** Registers the method table on `peer` and forwards events and notices to it. */
export function attach(harness: Harness, peer: RpcPeer): void {
  for (const [name, handler] of Object.entries(methods(harness))) peer.handle(name, handler)
  peer.handle('harness.methods', () => peer.methods())
  harness.runs.listen((event) => peer.send({ event }))
  harness.bus.on((notice) => peer.send({ notice }))
}

export function serve(harness: Harness, transport: Transport): Served {
  const peer = new RpcPeer(transport)
  attach(harness, peer)
  let closing: Promise<void> | null = null
  const shutdown = (): Promise<void> => (closing ??= harness.close())
  peer.handle('harness.shutdown', () => shutdown())
  return { peer, shutdown }
}
