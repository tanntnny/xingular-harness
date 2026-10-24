// A repository's setup script runs in each new worktree (installing dependencies, say), but only
// once a person trusted its exact text. The hash is the trust; a changed script asks again.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { readJsonOr, writeJson } from '../core/fs'
import type { SetupReport } from './types'

export const SETUP_SCRIPT = '.xharness/worktree-setup'
const TIMEOUT_MS = 10 * 60 * 1000

type TrustFile = Record<string, string[]>

export function scriptHash(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export class SetupTrust {
  constructor(private readonly file: string) {}

  private read(): TrustFile {
    return readJsonOr<TrustFile>(this.file, {})
  }

  trusted(repoRoot: string, hash: string): boolean {
    return this.read()[repoRoot]?.includes(hash) ?? false
  }

  trust(repoRoot: string, hash: string): void {
    const all = this.read()
    all[repoRoot] = [...new Set([...(all[repoRoot] ?? []), hash])]
    writeJson(this.file, all)
    chmodSync(this.file, 0o600)
  }
}

/** The setup script a checkout carries, with its hash, or null. */
export function setupScript(checkout: string): { path: string; hash: string } | null {
  const path = join(checkout, SETUP_SCRIPT)
  if (!existsSync(path) || !statSync(path).isFile()) return null
  return { path, hash: scriptHash(readFileSync(path)) }
}

export function runSetup(input: { checkout: string; source: string; name: string; repoRoot: string; logFile: string; trust: SetupTrust }): Promise<SetupReport> {
  const script = setupScript(input.checkout)
  if (!script) return Promise.resolve({ state: 'none', hash: null, log: null })
  if (!input.trust.trusted(input.repoRoot, script.hash)) return Promise.resolve({ state: 'untrusted', hash: script.hash, log: null })
  mkdirSync(dirname(input.logFile), { recursive: true })
  const log = openSync(input.logFile, 'w')
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [script.path], {
      cwd: input.checkout,
      env: { ...process.env, HARNESS_WORKTREE_PATH: input.checkout, HARNESS_WORKTREE_SOURCE: input.source, HARNESS_WORKTREE_NAME: input.name },
      stdio: ['ignore', log, log]
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS)
    let settled = false
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeSync(log)
      resolve({ state: exitCode === 0 ? 'ran' : 'failed', hash: script.hash, log: input.logFile, exitCode })
    }
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code))
  })
}
