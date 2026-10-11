// Where credentials live. The harness never writes a secret to its own files: it asks the
// store the embedding application provides (a Keychain, an encrypted vault), by key.
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { atomicWrite, readJsonOr } from '../core/fs'

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
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
    atomicWrite(path, `${JSON.stringify(values, null, 2)}\n`)
    chmodSync(path, 0o600)
  }
  return {
    get: async (key) => read()[key] ?? null,
    set: async (key, value) => write({ ...read(), [key]: value }),
    delete: async (key) => {
      const values = read()
      if (key in values) {
        delete values[key]
        write(values)
      }
    }
  }
}
