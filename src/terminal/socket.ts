// The session socket: how a process the harness did not start in-process (the `pi` command in
// a terminal, with its extension and the `agentx-wiki` / `agentx-mcp` commands) reaches the
// session it belongs to. Owner-only Unix socket, newline-delimited JSON, one request per
// connection. Each terminal session holds a random token bound to its caller, its connected-apps
// grant, and its controller; the token stops working when the terminal ends.
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { log } from '../core/bus'
import { HarnessError, toErrorShape } from '../core/errors'
import { newId } from '../core/fs'
import type { BrokerSession } from '../mcp/service'
import type { CallerContext } from '../memory/caller'

/** What a token stands for. */
export interface SocketGrant {
  sessionId: string
  /** Who memory, Wiki, and recall calls are made as. The run is filled in while a turn is live. */
  caller: () => CallerContext
  /** The session's connected-apps grant, when it has one. */
  broker: BrokerSession | null
  /** Telemetry from the native process, and what to do when it hangs up mid-request. */
  terminal?: { accept(event: string, data: Record<string, unknown>): Promise<unknown>; disconnected(): void }
}

export interface SocketHandlers {
  /** `wiki.*`, `memory.*`, `recall.*`. */
  memory(caller: CallerContext, call: string, params: Record<string, unknown>): string
  /** `mcp.list`, `mcp.call`, `mcp.revision`, `tools.list`, `tools.call`. */
  apps(session: BrokerSession, call: string, params: Record<string, unknown>): Promise<unknown>
}

const MAX_REQUEST_BYTES = 1024 * 1024
/** macOS refuses a socket path longer than 103 bytes. */
const MAX_SOCKET_PATH = 100

export function socketPath(stateDir: string): string {
  const path = join(stateDir, 'run', 'harness.sock')
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path
  return join(tmpdir(), `xh-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.sock`)
}

export class SessionSocket {
  private server: Server | null = null
  private listening: Promise<void> | null = null
  private readonly grants = new Map<string, SocketGrant>()
  private readonly clients = new Set<Socket>()

  constructor(
    readonly path: string,
    private readonly handlers: SocketHandlers
  ) {}

  issue(grant: SocketGrant): string {
    const token = `${newId()}${newId()}`.replaceAll('-', '')
    this.grants.set(token, grant)
    return token
  }

  revoke(token: string): void {
    this.grants.delete(token)
  }

  revokeSession(sessionId: string): void {
    for (const [token, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(token)
  }

  /** Runs one request line and returns the reply line's object. */
  async handle(line: string, connection?: { waiting: (grant: SocketGrant | null) => void }): Promise<{ result: unknown } | { error: unknown }> {
    try {
      let request: Record<string, unknown>
      try {
        request = JSON.parse(line) as Record<string, unknown>
      } catch {
        throw new HarnessError('invalid_request', 'The request is not JSON.')
      }
      const grant = this.grants.get(typeof request.token === 'string' ? request.token : '')
      if (!grant) throw new HarnessError('unauthorized', 'This session token is not valid. It ends when its terminal session ends.')
      if (typeof request.event === 'string') {
        if (!grant.terminal) throw new HarnessError('unknown_method', 'This session has no terminal controller.')
        connection?.waiting(grant)
        try {
          return { result: (await grant.terminal.accept(request.event, (request.data ?? {}) as Record<string, unknown>)) ?? {} }
        } finally {
          connection?.waiting(null)
        }
      }
      const call = typeof request.call === 'string' ? request.call : ''
      const params = (request.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>
      if (['wiki.', 'memory.', 'recall.'].some((prefix) => call.startsWith(prefix))) return { result: this.handlers.memory(grant.caller(), call, params) }
      if (['mcp.', 'tools.'].some((prefix) => call.startsWith(prefix))) {
        if (!grant.broker) throw new HarnessError('mcp_unauthorized', 'Connected apps are not available to this session.')
        return { result: await this.handlers.apps(grant.broker, call, params) }
      }
      throw new HarnessError('unknown_method', `Unknown call ${call}.`)
    } catch (error) {
      return { error: toErrorShape(error) }
    }
  }

  private serve(client: Socket): void {
    let buffer = ''
    let waiting: SocketGrant | null = null
    this.clients.add(client)
    client.on('error', () => {})
    client.once('close', () => {
      this.clients.delete(client)
      // A decision the native process was waiting on can no longer reach it.
      waiting?.terminal?.disconnected()
    })
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        client.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      client.pause()
      void this.handle(buffer.slice(0, newline), { waiting: (grant) => void (waiting = grant) }).then((reply) => client.end(`${JSON.stringify(reply)}\n`))
    })
  }

  /** Binds the socket once; later calls wait for the same bind. */
  listen(): Promise<void> {
    this.listening ??= new Promise<void>((resolve, reject) => {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      rmSync(this.path, { force: true })
      const server = createServer((client) => this.serve(client))
      server.once('error', (error) => {
        this.listening = null
        reject(error)
      })
      server.listen(this.path, () => {
        try {
          chmodSync(this.path, 0o600)
        } catch (error) {
          log('session socket permissions', error instanceof Error ? error.message : String(error))
        }
        this.server = server
        resolve()
      })
    })
    return this.listening
  }

  async close(): Promise<void> {
    this.grants.clear()
    const server = this.server
    this.server = null
    this.listening = null
    for (const client of this.clients) client.destroy()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.path, { force: true })
  }
}
