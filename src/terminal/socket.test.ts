import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SessionSocket } from './socket'

const handlers = { memory: () => '', apps: async () => null }

describe('session socket', () => {
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
