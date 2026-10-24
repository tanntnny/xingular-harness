import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { git } from './git'

test.skipIf(process.platform === 'win32')('an early-exiting git process may close stdin without crashing its caller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-git-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'git')
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" != "config" ]; then sleep 0.05; fi\nexit 0\n')
  chmodSync(executable, 0o755)

  try {
    const result = await git(root, ['apply'], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      input: 'x'.repeat(4 * 1024 * 1024)
    })
    expect(result.code).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
