// The session socket: how a process the harness did not start in-process (the `pi` command in
// a terminal, with its extension and the `agentx-wiki` / `agentx-mcp` commands) reaches the
// session it belongs to. Owner-only Unix socket (a named pipe on Windows), newline-delimited JSON,
// one request per connection. Each terminal session holds a random token bound to its caller, its
// connected-apps grant, and its controller; the token stops working when the terminal ends.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs'
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
  /**
   * `plugins.*`. `control` is true only for the session's own extension, which holds a key the
   * session's shell never sees; anything that changes what loads needs it.
   */
  plugins?(grant: SocketGrant, call: string, params: Record<string, unknown>, control: boolean): Promise<unknown>
}

const MAX_REQUEST_BYTES = 1024 * 1024
/** macOS refuses a socket path longer than 103 bytes. */
const MAX_SOCKET_PATH = 100

/**
 * Windows has no socket files for Node's `net`: it listens on a named pipe, which lives in a
 * machine-wide namespace. A random name keeps another local process from guessing it and standing
 * in front of the session; the token still decides what a caller may do.
 */
export function socketPath(stateDir: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\xingular-harness-${randomBytes(12).toString('hex')}`
  const path = join(stateDir, 'run', 'harness.sock')
  if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path
  return join(tmpdir(), `xh-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.sock`)
}

/** A named pipe has no folder, file mode, or owner to check or clean up. */
const isPipePath = (path: string): boolean => path.startsWith('\\\\.\\pipe\\')

/** Names the folder and the user when the operating system refuses the socket, so the cause shows. */
function refusedBind(path: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  if (code !== 'EACCES' && code !== 'EPERM') return error
  if (isPipePath(path)) {
    return new HarnessError(
      'session_socket_denied',
      `The session pipe ${path} could not be created (${code}).`,
      'Start the harness again from your own user session. If it keeps failing, report this code and the Windows version.'
    )
  }
  let folder: string
  try {
    const stat = statSync(dirname(path))
    folder = `${dirname(path)} is owned by uid ${stat.uid} with mode ${(stat.mode & 0o777).toString(8)}`
  } catch {
    folder = `${dirname(path)} could not be read`
  }
  const uid = process.getuid?.() ?? 'unknown'
  return new HarnessError(
    'session_socket_denied',
    `The session socket ${path} could not be created (${code}). ${folder}; this process runs as uid ${uid}.`,
    'Run the harness from your own terminal, as the user that owns its state folder, or choose a state folder you own with --state.'
  )
}

export class SessionSocket {
  private server: Server | null = null
  private listening: Promise<void> | null = null
  private readonly grants = new Map<string, SocketGrant>()
  /**
   * A second key per token, handed out once. The token is in the session's environment, where a
   * command the model runs can read it; this key is claimed by the session's extension as it
   * loads, before any model turn, and kept in its memory only.
   */
  private readonly controls = new Map<string, string>()
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
    this.controls.delete(token)
  }

  revokeSession(sessionId: string): void {
    for (const [token, grant] of this.grants) if (grant.sessionId === sessionId) this.revoke(token)
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
      const token = typeof request.token === 'string' ? request.token : ''
      const grant = this.grants.get(token)
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
      if (call === 'control.claim') {
        if (this.controls.has(token)) throw new HarnessError('unauthorized', "This session's control key was already claimed.")
        const key = `${newId()}${newId()}`.replaceAll('-', '')
        this.controls.set(token, key)
        return { result: { key } }
      }
      if (call.startsWith('plugins.') && this.handlers.plugins) {
        const key = this.controls.get(token)
        return { result: await this.handlers.plugins(grant, call, params, key !== undefined && request.control === key) }
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
      if (!isPipePath(this.path)) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
        rmSync(this.path, { force: true })
      }
      const server = createServer((client) => this.serve(client))
      server.once('error', (error) => {
        this.listening = null
        reject(refusedBind(this.path, error))
      })
      server.listen(this.path, () => {
        if (!isPipePath(this.path)) {
          try {
            chmodSync(this.path, 0o600)
          } catch (error) {
            log('session socket permissions', error instanceof Error ? error.message : String(error))
          }
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
    if (!isPipePath(this.path)) rmSync(this.path, { force: true })
  }
}
