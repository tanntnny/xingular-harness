import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
