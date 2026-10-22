import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { socketCall } from './client'
import { SessionSocket, socketPath } from './socket'

const handlers = { memory: () => '', apps: async () => null }

/** Runs `body` as if on another operating system; `process.platform` is read at call time. */
function onPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return body()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('session socket path', () => {
  it('keeps the socket file in the state folder on Unix', () => {
    expect(onPlatform('darwin', () => socketPath('/tmp/state'))).toBe(join('/tmp/state', 'run', 'harness.sock'))
  })

  it('uses a named pipe on Windows, with a random name each time', () => {
    const first = onPlatform('win32', () => socketPath('C:\\Users\\someone\\.xingular-harness\\state'))
    const second = onPlatform('win32', () => socketPath('C:\\Users\\someone\\.xingular-harness\\state'))
    expect(first).toMatch(/^\\\\\.\\pipe\\xingular-harness-[0-9a-f]{24}$/)
    expect(second).not.toBe(first)
  })
})

describe('session socket', () => {
  it.skipIf(process.platform === 'win32')('keeps an existing Harness socket reachable when another instance uses the same state folder', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sock-shared-state-'))
    const path = socketPath(base)
    const first = new SessionSocket(path, handlers)
    const second = new SessionSocket(path, handlers)
    const canConnect = (socketPath: string): Promise<void> => new Promise((resolve, reject) => {
      const client = createConnection(socketPath)
      client.once('connect', () => { client.end(); resolve() })
      client.once('error', reject)
    })
    try {
      await first.listen()
      await second.listen()
      expect(second.path).not.toBe(first.path)
      await second.close()
      await expect(canConnect(first.path)).resolves.toBeUndefined()
    } finally {
      await first.close()
      await second.close()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('listens on a named pipe and answers a request on Windows', async () => {
    const socket = new SessionSocket(socketPath('unused'), handlers)
    await socket.listen()
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const client = createConnection(socket.path)
        let buffer = ''
        client.on('connect', () => client.write('{"token":"nope","call":"wiki.read"}\n'))
        client.on('data', (chunk) => (buffer += chunk.toString('utf8')))
        client.on('end', () => resolve(buffer))
        client.on('error', reject)
      })
      expect(JSON.parse(reply)).toMatchObject({ error: { code: 'unauthorized' } })
    } finally {
      await socket.close()
    }
  })

  it('names the folder and the user when the operating system refuses to create the socket', async () => {
    // Root can write anywhere, so the refusal cannot be produced there.
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const base = mkdtempSync(join(tmpdir(), 'sock-'))
    const run = join(base, 'run')
    mkdirSync(run)
    chmodSync(run, 0o500)
    try {
      await expect(new SessionSocket(join(run, 'harness.sock'), handlers).listen()).rejects.toMatchObject({
        code: 'session_socket_denied',
        message: expect.stringMatching(/could not be created \((?:EACCES|EPERM)\)\. .*mode 500; this process runs as uid \d+\./)
      })
    } finally {
      chmodSync(run, 0o700)
      rmSync(base, { recursive: true, force: true })
    }
  })

  describe.skipIf(process.platform === 'win32')('connection reuse', () => {
    const open = async () => {
      const base = mkdtempSync(join(tmpdir(), 'sock-keep-'))
      const reads: string[] = []
      const socket = new SessionSocket(socketPath(base), { memory: (_caller, _call, params) => { reads.push(String(params.name)); return `page ${String(params.name)}` }, apps: async () => null })
      await socket.listen()
      const token = socket.issue({ sessionId: 's', caller: () => ({ agentId: 'a' }) as never, broker: null })
      const clients = () => (socket as unknown as { clients: Set<unknown> }).clients.size
      return { socket, token, reads, clients, close: async () => { await socket.close(); rmSync(base, { recursive: true, force: true }) } }
    }

    it('answers consecutive requests on one kept connection, in order', async () => {
      const server = await open()
      try {
        const connection = { socket: server.socket.path, token: server.token }
        expect(await socketCall(connection, 'wiki.read', { name: 'one' })).toBe('page one')
        expect(await socketCall(connection, 'wiki.read', { name: 'two' })).toBe('page two')
        const both = await Promise.all([socketCall(connection, 'wiki.read', { name: 'three' }), socketCall(connection, 'wiki.read', { name: 'four' })])
        expect(both).toEqual(['page three', 'page four'])
        expect(server.reads).toEqual(['one', 'two', 'three', 'four'])
        // The sequential calls shared a connection; the concurrent pair needed a second one.
        expect(server.clients()).toBe(2)
      } finally {
        await server.close()
      }
    })

    it('still closes a connection after a request that does not ask to keep it', async () => {
      const server = await open()
      try {
        const reply = await new Promise<string>((resolve, reject) => {
          const client = createConnection(server.socket.path)
          let buffer = ''
          client.on('connect', () => client.write(`${JSON.stringify({ token: server.token, call: 'wiki.read', params: { name: 'once' } })}\n`))
          client.on('data', (chunk) => (buffer += chunk.toString('utf8')))
          client.on('end', () => resolve(buffer))
          client.on('error', reject)
        })
        expect(JSON.parse(reply)).toEqual({ result: 'page once' })
      } finally {
        await server.close()
      }
    })

    it('opens a fresh connection when the harness closed an idle one', async () => {
      const server = await open()
      try {
        const connection = { socket: server.socket.path, token: server.token }
        expect(await socketCall(connection, 'wiki.read', { name: 'first' })).toBe('page first')
        for (const client of (server.socket as unknown as { clients: Set<{ destroy(): void }> }).clients) client.destroy()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(await socketCall(connection, 'wiki.read', { name: 'second' })).toBe('page second')
      } finally {
        await server.close()
      }
    })
  })
})
