// How a process outside the harness (the `pi` command's extension, the `agentx-wiki` and
// `agentx-mcp` commands) reaches it: one newline-delimited JSON request and reply per
// connection to the session socket, authorized by the token the harness put in its environment.
import { createConnection } from 'node:net'

export const SOCKET_ENV = 'XINGULAR_HARNESS_SOCKET'
export const TOKEN_ENV = 'XINGULAR_HARNESS_TOKEN'

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

function request<T>(connection: SocketConnection, body: Record<string, unknown>, what: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stream = createConnection(connection.socket)
    let buffer = ''
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.end()
      action()
    }
    const timer = setTimeout(() => {
      stream.destroy()
      finish(() => reject(new SocketError('timeout', `The harness did not answer ${what}.`)))
    }, timeoutMs)
    stream.on('connect', () => stream.write(`${JSON.stringify({ token: connection.token, ...body })}\n`))
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { result?: T; error?: { code?: string; message?: string } | string }
        if (reply.error) {
          const error = typeof reply.error === 'string' ? { message: reply.error } : reply.error
          finish(() => reject(new SocketError(error.code ?? 'error', error.message ?? `${what} failed.`)))
        } else finish(() => resolve(reply.result as T))
      } catch {
        finish(() => reject(new SocketError('invalid_reply', 'The harness sent an unreadable reply.')))
      }
    })
    stream.on('error', (error) => finish(() => reject(new SocketError('unavailable', `The harness is not reachable: ${error.message}.`))))
    stream.on('close', () => finish(() => reject(new SocketError('unavailable', 'The harness closed the connection.'))))
  })
}

/** A memory, Wiki, recall, or connected-app call made on behalf of the session that owns the token. */
export function socketCall<T = unknown>(connection: SocketConnection, call: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  return request<T>(connection, { call, params }, call, timeoutMs)
}

/** Telemetry and decisions from the native `pi` process. Approvals may wait on a person, so the default wait is long. */
export function terminalCall<T = Record<string, unknown>>(event: string, data: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<T> {
  return request<T>(connectionFromEnv(), { event, data }, event, timeoutMs)
}
