// The server protocol (page 10) on a local Unix socket, one peer per connection, so more than one
// client can reach the same long-lived harness (ADR-0083, phase 3). The framing is the stdio
// protocol's: one JSON message per line.
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { HarnessError, toErrorShape, type ErrorShape } from '../core/errors'
import type { Harness } from '../harness'
import { PROTOCOL_VERSION, RpcPeer, type Transport } from './rpc'
import { attach } from './serve'
import type { HostHub } from './hostHub'

/** Protocol lines over one socket. */
export function socketTransport(socket: Socket): Transport {
  const reader = createInterface({ input: socket, crlfDelay: Infinity })
  return {
    write: (line) => { if (!socket.destroyed) socket.write(`${line}\n`) },
    onLine: (listener) => void reader.on('line', listener)
  }
}

export interface SocketServer {
  path: string
  close(): Promise<void>
  /** Connections open now. */
  connections(): number
}

/**
 * Serves `harness` on a socket at `path`, readable and writable by this user only. Each connection
 * gets the whole method table and the run events and notices while it is open.
 */
export async function serveSocket(harness: Harness, path: string, extra: Record<string, (params: Record<string, unknown>) => unknown> = {}, options: { hub?: HostHub } = {}): Promise<SocketServer> {
  const { hub } = options
  if (existsSync(path)) rmSync(path, { force: true })
  const open = new Set<Socket>()
  const server: Server = createServer((socket) => {
    open.add(socket)
    const peer = new RpcPeer(socketTransport(socket))
    // A host hears only its own sessions' events, and a run it starts makes its session its own (page 10).
    const stop = attach(harness, peer, hub ? {
      deliver: (event) => hub.deliver(peer, event),
      wrap: (name, handler) => name === 'sessions.run' || name === 'sessions.spawnSubagent'
        ? (params) => { hub.claim(peer, (params as { run?: { sessionId?: unknown } })?.run?.sessionId); return handler(params) }
        : handler
    } : undefined)
    for (const [name, handler] of Object.entries(extra)) peer.handle(name, handler)
    if (hub) peer.handle('host.register', (params) => hub.register(peer, params))
    const gone = (): void => {
      open.delete(socket)
      hub?.drop(peer)
      stop()
    }
    socket.once('close', gone)
    socket.on('error', () => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  chmodSync(path, 0o600)
  return {
    path,
    connections: () => open.size,
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(path, { force: true })
    }
  }
}

export interface HarnessClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  /** Run events and notices the harness sends while connected. */
  onMessage(listener: (message: { event?: unknown; notice?: unknown }) => void): () => void
  /** Answers a named operation the harness asks of this client (a host's secrets, policy, tools). */
  handle(call: string, handler: (params: any) => Promise<unknown> | unknown): void
  close(): void
  readonly closed: Promise<void>
}

/** Connects to a harness serving on `path`. */
export async function connectHarness(path: string): Promise<HarnessClient> {
  const socket = createConnection(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const reader = createInterface({ input: socket, crlfDelay: Infinity })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const listeners = new Set<(message: { event?: unknown; notice?: unknown }) => void>()
  const handlers = new Map<string, (params: any) => Promise<unknown> | unknown>()
  let next = 0
  const closed = new Promise<void>((resolve) => socket.once('close', () => {
    for (const [, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new HarnessError('harness_unavailable', 'The harness closed the connection.'))
    }
    pending.clear()
    resolve()
  }))
  socket.on('error', () => undefined)
  reader.on('line', (line) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (message.v !== PROTOCOL_VERSION) return
    // The harness asks this client to do something: answer with its result or its error.
    if (typeof message.id === 'string' && typeof message.call === 'string') {
      const id = message.id
      const reply = (body: Record<string, unknown>): void => { if (!socket.destroyed) socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, ...body })}\n`) }
      const handler = handlers.get(message.call)
      if (!handler) return reply({ error: { code: 'unknown_method', message: `Unknown call ${message.call}.` } })
      void (async () => {
        try {
          reply({ result: (await handler(message.params ?? {})) ?? null })
        } catch (error) {
          reply({ error: toErrorShape(error) })
        }
      })()
      return
    }
    if (typeof message.id === 'string' && pending.has(message.id)) {
      const call = pending.get(message.id)!
      pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) {
        const shape = message.error as ErrorShape
        call.reject(new HarnessError(shape.code, shape.message, shape.retryHint ?? null))
      } else call.resolve(message.result)
      return
    }
    if ('event' in message || 'notice' in message) for (const listener of listeners) listener(message as { event?: unknown; notice?: unknown })
  })
  return {
    call: <T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000) => new Promise<T>((resolve, reject) => {
      const id = `c${++next}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new HarnessError('harness_timeout', `The harness did not answer ${method}.`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`)
    }),
    onMessage: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    handle: (call, handler) => void handlers.set(call, handler),
    close: () => socket.end(),
    closed
  }
}
