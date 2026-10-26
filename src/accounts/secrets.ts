// Where credentials live. The harness never writes a secret to its own files: it asks the
// store the embedding application provides (a Keychain, an encrypted vault), by key.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { readJsonOr } from '../core/fs'

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Exclusive temporary files are private before the first byte is written, not just after rename. */
function privateWrite(path: string, value: string): void {
  const temporary = join(dirname(path), `.credential-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, value)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export interface CredentialLockOptions {
  /** Acquisition only; an acquired callback is never unlocked while still running. */
  timeoutMs?: number
  pollMs?: number
}

/**
 * Cross-process Lamport bakery lock. Unique participant directories make dead-pid reclamation
 * safe: a stale cleanup can never unlink a successor's lock. No age-based stealing of live refreshes.
 * The directory contains only hashed keys, pids, random IDs and tickets, never credential contents.
 * All processes sharing a backend must use the same coordination directory on a local filesystem.
 */
export async function withCredentialLock<T>(dir: string, key: string, work: () => Promise<T>, options: CredentialLockOptions = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 30_000
  const poll = options.pollMs ?? 20
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 300_000 || !Number.isFinite(poll) || poll < 1 || poll > 1000) {
    throw new Error('Invalid credential lock wait bounds.')
  }
  const started = performance.now()
  const folder = join(dir, createHash('sha256').update(key).digest('hex'))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory() || !lstatSync(folder).isDirectory()) throw new Error('Invalid credential lock directory.')
  chmodSync(dir, 0o700)
  chmodSync(folder, 0o700)
  const id = `${process.pid}-${randomUUID()}`
  const own = join(folder, id)
  mkdirSync(own, { mode: 0o700 })
  const participants = (): { id: string; ticket: number | null }[] => {
    const entries: { id: string; ticket: number | null }[] = []
    for (const name of readdirSync(folder)) {
      if (!/^\d+-[0-9a-f-]{36}$/.test(name)) throw new Error('Invalid credential lock metadata.')
      const pid = Number(name.slice(0, name.indexOf('-')))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid credential lock metadata.')
      let alive = true
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
      }
      const participant = join(folder, name)
      if (!alive) {
        rmSync(participant, { recursive: true, force: true })
        continue
      }
      try {
        // The absent ticket is the bakery algorithm's choosing flag.
        const text = readFileSync(join(participant, 'ticket'), 'utf8')
        const ticket = Number(text)
        if (!Number.isSafeInteger(ticket) || ticket <= 0) throw new Error('Invalid credential lock metadata.')
        entries.push({ id: name, ticket })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (lstatExists(participant)) entries.push({ id: name, ticket: null })
      }
    }
    return entries
  }
  try {
    const ticket = Math.max(0, ...participants().map(entry => entry.ticket ?? 0)) + 1
    privateWrite(join(own, 'ticket'), String(ticket))
    for (;;) {
      const blocked = participants().some(entry => entry.id !== id && (entry.ticket === null || entry.ticket < ticket || (entry.ticket === ticket && entry.id < id)))
      if (!blocked) return await work()
      if (performance.now() - started >= timeout) throw new Error('Timed out waiting for credential modification; no credentials were changed.')
      await new Promise(resolve => setTimeout(resolve, Math.min(poll, Math.max(1, timeout - (performance.now() - started)))))
    }
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** `<account id>/<secret name>`: the key an account's secret is stored under. */
export const secretKey = (accountId: string, name: string): string => `${accountId}/${name}`

/** Secrets held only for the life of the process. For tests and throwaway runs. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key)
  }
}

/**
 * Secrets in one owner-only JSON file. For a host with no Keychain to offer; anything that can
 * read the file can read every secret in it.
 */
export function fileSecretStore(path: string): SecretStore {
  const read = (): Record<string, string> => readJsonOr<Record<string, string>>(path, {})
  const write = (values: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    privateWrite(path, `${JSON.stringify(values, null, 2)}\n`)
    chmodSync(path, 0o600)
  }
  return {
    get: async (key) => read()[key] ?? null,
    set: (key, value) => withCredentialLock(`${path}.locks`, 'file', async () => write({ ...read(), [key]: value })),
    delete: (key) => withCredentialLock(`${path}.locks`, 'file', async () => {
      const values = read()
      if (key in values) {
        delete values[key]
        write(values)
      }
    })
  }
}
