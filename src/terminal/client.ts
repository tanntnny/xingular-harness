// How a process outside the harness (the `pi` command's extension, the `xagent-wiki` and
// `xagent-mcp` commands) reaches it: newline-delimited JSON requests and replies on the session
// socket, authorized by the token the harness put in its environment. A reply leaves its connection
// open for the next request, so the terminal's frequent small calls do not each open a socket.
import { createConnection, type Socket } from 'node:net'

export const SOCKET_ENV = 'XINGULAR_HARNESS_SOCKET'
export const TOKEN_ENV = 'XINGULAR_HARNESS_TOKEN'
/** Set by `xagent --remote-control`: the terminal turns on `/remote-control` as it opens. */
export const REMOTE_CONTROL_ENV = 'XINGULAR_HARNESS_REMOTE_CONTROL'

export class SocketError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface SocketConnection {
  socket: string
  token: string
}

export function connectionFromEnv(env: NodeJS.ProcessEnv = process.env): SocketConnection {
  const socket = env[SOCKET_ENV]
  const token = env[TOKEN_ENV]
  if (!socket || !token) throw new SocketError('not_configured', `This command only works inside a terminal session the harness started (${SOCKET_ENV} and ${TOKEN_ENV} are not set).`)
  return { socket, token }
}

const MAX_IDLE_PER_SOCKET = 4
/** Open connections waiting for their next request, per socket path. Idle ones never keep a process alive. */
const idle = new Map<string, Set<{ stream: Socket; drop: () => void }>>()

function takeIdle(path: string): Socket | undefined {
  const entries = idle.get(path)
  const entry = entries?.values().next().value
  if (!entries || !entry) return undefined
  entries.delete(entry)
  entry.stream.off('close', entry.drop)
  entry.stream.off('error', entry.drop)
  entry.stream.ref()
  return entry.stream
}

function putIdle(path: string, stream: Socket): void {
  const entries = idle.get(path) ?? new Set()
  if (stream.destroyed || entries.size >= MAX_IDLE_PER_SOCKET) {
    stream.end()
    return
  }
  const entry = { stream, drop: () => { entries.delete(entry); stream.destroy() } }
  stream.once('close', entry.drop)
  stream.on('error', entry.drop)
  stream.unref()
  entries.add(entry)
  idle.set(path, entries)
}

function request<T>(connection: SocketConnection, body: Record<string, unknown>, what: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const reused = takeIdle(connection.socket)
  return attempt<T>(connection, body, what, timeoutMs, reused, signal).catch((error: unknown) => {
    // An idle connection the harness had already closed fails before any reply; one fresh retry.
    if (reused && error instanceof StaleConnection) return attempt<T>(connection, body, what, timeoutMs, undefined, signal)
    throw error
  })
}

class StaleConnection extends Error {}

function attempt<T>(connection: SocketConnection, body: Record<string, unknown>, what: string, timeoutMs: number, reused: Socket | undefined, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stream = reused ?? createConnection(connection.socket)
    let buffer = ''
    let replied = false
    let settled = false
    const send = () => stream.write(`${JSON.stringify({ token: connection.token, ...body, keep: true })}\n`)
    const onData = (chunk: Buffer) => {
      replied = true
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const rest = buffer.slice(newline + 1)
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { result?: T; error?: { code?: string; message?: string } | string }
        if (reply.error) {
          const error = typeof reply.error === 'string' ? { message: reply.error } : reply.error
          finish(() => reject(new SocketError(error.code ?? 'error', error.message ?? `${what} failed.`)), !rest)
        } else finish(() => resolve(reply.result as T), !rest)
      } catch {
        finish(() => reject(new SocketError('invalid_reply', 'The harness sent an unreadable reply.')))
      }
    }
    const onError = (error: Error) => finish(() => reject(
      reused && !replied ? new StaleConnection(error.message) : new SocketError('unavailable', `The harness is not reachable: ${error.message}.`)
    ))
    const onClose = () => finish(() => reject(
      reused && !replied ? new StaleConnection('closed') : new SocketError('unavailable', 'The harness closed the connection.')
    ))
    const finish = (action: () => void, keep = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      stream.off('connect', send)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('close', onClose)
      if (keep) putIdle(connection.socket, stream)
      else {
        stream.on('error', () => {})
        stream.end()
      }
      action()
    }
    const timer = setTimeout(() => {
      stream.destroy()
      finish(() => reject(new SocketError('timeout', `The harness did not answer ${what}.`)))
    }, timeoutMs)
    const onAbort = () => { stream.destroy(); finish(() => reject(new SocketError('aborted', `${what} was cancelled.`))) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('close', onClose)
    if (reused) send()
    else stream.on('connect', send)
  })
}

/** A memory, Wiki, recall, or connected-app call made on behalf of the session that owns the token. */
export function socketCall<T = unknown>(connection: SocketConnection, call: string, params: Record<string, unknown> = {}, timeoutMs = 120_000, control?: string, signal?: AbortSignal): Promise<T> {
  return request<T>(connection, { call, params, ...(control ? { control } : {}) }, call, timeoutMs, signal)
}

/** Telemetry and decisions from the native `pi` process. Approvals may wait on a person, so the default wait is long. */
export function terminalCall<T = Record<string, unknown>>(event: string, data: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<T> {
  return request<T>(connectionFromEnv(), { event, data }, event, timeoutMs)
}
