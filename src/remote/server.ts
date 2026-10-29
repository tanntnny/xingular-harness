// The remote-control HTTP server: the phone page, pairing, sealed calls and a sealed event stream.
// It listens on exactly one private or Tailscale address (INV-RC-1). Bodies are sealed (seal.ts),
// so this layer only checks the Host and Origin, caps sizes, and routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { HarnessError, toErrorShape } from '../core/errors'

const MAX_HELLO = 64_000
const MAX_CALL = 1_200_000
const PING_MS = 15_000

export interface RemoteAsset {
  type: string
  body: string
}

export interface RemoteStream {
  /** Sends one sealed frame as an SSE message. */
  send(frame: string): void
  end(): void
}

export interface RemoteRoutes {
  /** The page and its scripts, by path. */
  asset(path: string): RemoteAsset | null
  hello(body: Record<string, unknown>): Promise<{ f: string }>
  call(body: Record<string, unknown>): Promise<{ f: string }>
  /** Opens a stream for a paired device; returns what to run when the phone hangs up. */
  stream(deviceId: string, frame: string, stream: RemoteStream): () => void
}

export interface RemoteListening {
  host: string
  port: number
  close(): Promise<void>
}

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin'
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const STATUS: Record<string, number> = { unauthorized: 401, remote_denied: 403, rate_limited: 429, remote_busy: 409, remote_full: 409, session_busy: 409, terminal_has_draft: 409, too_large: 413, not_found: 404 }

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function failure(response: ServerResponse, error: unknown): void {
  const shape = toErrorShape(error)
  reply(response, STATUS[shape.code] ?? 400, { error: { code: shape.code, message: shape.message } })
}

async function readBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HarnessError('too_large', 'This message is too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  throw new HarnessError('invalid_request', 'The request is not JSON.')
}

/** Starts the server on one address. `port` 0 picks a free one. */
export async function listenRemote(host: string, port: number, routes: RemoteRoutes): Promise<RemoteListening> {
  const sockets = new Set<Socket>()
  const streams = new Set<RemoteStream>()
  let authority = ''

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // A page on another site cannot reach this server through DNS it controls (rebinding), and no
    // other origin may post to it.
    if (request.headers.host !== authority) return reply(response, 421, { error: { code: 'wrong_host', message: 'Open the link shown in the terminal.' } })
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${authority}`) return reply(response, 403, { error: { code: 'wrong_origin', message: 'Requests from other sites are refused.' } })
    const url = new URL(request.url ?? '/', `http://${authority}`)
    if (request.method === 'GET' && url.pathname === '/rc/events') {
      const deviceId = url.searchParams.get('d') ?? ''
      const frame = url.searchParams.get('f') ?? ''
      let ended = false
      let opened = false
      let ping: ReturnType<typeof setInterval> | null = null
      // The route sends its first frame as the stream opens, so the headers go out with it.
      const begin = () => {
        if (opened) return
        opened = true
        response.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' })
        response.write(': open\n\n')
      }
      const stream: RemoteStream = {
        send: (data) => {
          if (ended) return
          begin()
          response.write(`data: ${data}\n\n`)
        },
        end: () => {
          if (ended) return
          ended = true
          streams.delete(stream)
          if (ping) clearInterval(ping)
          response.end()
        }
      }
      let release: () => void
      try {
        release = routes.stream(deviceId, frame, stream)
      } catch (error) {
        return failure(response, error)
      }
      begin()
      if (ended) return release()
      streams.add(stream)
      ping = setInterval(() => { if (!ended) response.write(': ping\n\n') }, PING_MS)
      ping.unref?.()
      request.on('close', () => {
        stream.end()
        release()
      })
      return
    }
    if (request.method === 'POST' && (url.pathname === '/rc/hello' || url.pathname === '/rc/call')) {
      try {
        const hello = url.pathname === '/rc/hello'
        const body = await readBody(request, hello ? MAX_HELLO : MAX_CALL)
        return reply(response, 200, hello ? await routes.hello(body) : await routes.call(body))
      } catch (error) {
        return failure(response, error)
      }
    }
    if (request.method === 'GET') {
      const asset = routes.asset(url.pathname)
      if (asset) {
        response.writeHead(200, { ...HEADERS, 'content-type': asset.type, 'content-security-policy': CSP })
        response.end(asset.body)
        return
      }
    }
    reply(response, 404, { error: { code: 'not_found', message: 'Not found.' } })
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error) => { if (!response.headersSent) failure(response, error) })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const bound = (server.address() as AddressInfo).port
  authority = `${host.includes(':') ? `[${host}]` : host}:${bound}`
  return {
    host,
    port: bound,
    close: async () => {
      for (const stream of [...streams]) stream.end()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
    }
  }
}
