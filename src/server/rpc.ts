// Newline-delimited JSON between the harness and a host process that embeds it.
//
//   host → harness  { v, id, method, params }        request
//   harness → host  { v, id, result } | { v, id, error }
//   harness → host  { v, event }                     run event (validated before sending)
//   harness → host  { v, notice }                    some state changed and should be read again
//   harness → host  { v, id, call, params }          the harness asks the host for a named operation
//   host → harness  { v, id, result } | { v, id, error }  reply to a call
//
// stdout carries only protocol lines; diagnostics go to stderr.
import { createInterface } from 'node:readline'

import { log } from '../core/bus'
import { HarnessError, toErrorShape, type ErrorShape } from '../core/errors'

export const PROTOCOL_VERSION = 1

export type Handler = (params: any) => Promise<unknown> | unknown

export interface Transport {
  write(line: string): void
  onLine(listener: (line: string) => void): void
}

export function stdioTransport(): Transport {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  return {
    write: (line) => void process.stdout.write(`${line}\n`),
    onLine: (listener) => void reader.on('line', listener)
  }
}

export class RpcPeer {
  private readonly handlers = new Map<string, Handler>()
  private readonly pendingCalls = new Map<string, { resolve: (value: unknown) => void; reject: (error: HarnessError) => void }>()
  private nextCallId = 0

  constructor(private readonly transport: Transport) {
    transport.onLine((line) => void this.receive(line))
  }

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler)
  }

  methods(): string[] {
    return [...this.handlers.keys()].sort()
  }

  send(message: Record<string, unknown>): void {
    this.transport.write(JSON.stringify({ v: PROTOCOL_VERSION, ...message }))
  }

  /** Asks the host to perform a named operation. */
  callHost<T = unknown>(call: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = `s${++this.nextCallId}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id)
        reject(new HarnessError('host_timeout', `The host did not answer ${call}.`))
      }, timeoutMs)
      this.pendingCalls.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.send({ id, call, params })
    })
  }

  private async receive(line: string): Promise<void> {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      log('ignored a non-JSON line')
      return
    }
    if (message.v !== PROTOCOL_VERSION || typeof message.id !== 'string') {
      log('ignored a message with an unknown version or no id')
      return
    }
    const id = message.id

    if (typeof message.method === 'string') {
      const handler = this.handlers.get(message.method)
      if (!handler) {
        this.send({ id, error: { code: 'unknown_method', message: `Unknown method ${message.method}.` } })
        return
      }
      try {
        const result = await handler(message.params ?? {})
        this.send({ id, result: result ?? null })
      } catch (error) {
        this.send({ id, error: toErrorShape(error) })
      }
      return
    }

    const pending = this.pendingCalls.get(id)
    if (pending) {
      this.pendingCalls.delete(id)
      if (message.error) {
        const shape = message.error as ErrorShape
        pending.reject(new HarnessError(shape.code, shape.message, shape.retryHint ?? null))
      } else {
        pending.resolve(message.result)
      }
    }
  }
}
