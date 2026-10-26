import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { fileSecretStore, type SecretStore } from '../accounts/secrets'

export type SecretBackendDescriptor =
  | { kind: 'file'; path: string }
  | { kind: 'host'; id: string }

export interface InteractiveProfile {
  version: 1
  dataRoot: string
  stateDir: string
  defaultVariantScope: string
  secretBackend: SecretBackendDescriptor
}

export type InteractiveProfileOverrides = Partial<Omit<InteractiveProfile, 'version'>>

export interface InteractiveProfileLocation {
  /** Overrides the home used for the default profile path. */
  home?: string
  /** Selects a profile file directly, without searching any application-specific locations. */
  configPath?: string
}

const fail = (): never => { throw new Error('Invalid interactive profile configuration.') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, expected: string[]): void => {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail()
}
const absolute = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) return fail()
  return value
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail()
  return value
}

/** Strict, bounded, credential-free configuration. Unknown fields are errors, not ignored secrets. */
export function validateInteractiveProfile(value: unknown): InteractiveProfile {
  const record = object(value)
  keys(record, ['version', 'dataRoot', 'stateDir', 'defaultVariantScope', 'secretBackend'])
  if (record.version !== 1) return fail()
  const backend = object(record.secretBackend)
  let secretBackend: SecretBackendDescriptor
  if (backend.kind === 'file') {
    keys(backend, ['kind', 'path'])
    secretBackend = { kind: 'file', path: absolute(backend.path) }
  } else if (backend.kind === 'host') {
    keys(backend, ['kind', 'id'])
    secretBackend = { kind: 'host', id: identifier(backend.id) }
  } else return fail()
  return {
    version: 1,
    dataRoot: absolute(record.dataRoot),
    stateDir: absolute(record.stateDir),
    defaultVariantScope: identifier(record.defaultVariantScope),
    secretBackend
  }
}

export function interactiveProfilePath(home = homedir()): string {
  return join(absolute(home), '.xingular-harness', 'profile.json')
}

function selectedConfigPath(location: InteractiveProfileLocation = {}): string {
  return location.configPath === undefined ? interactiveProfilePath(location.home) : absolute(location.configPath)
}

/** Read only. Missing is legacy mode; malformed or inaccessible is never silently ignored. */
export function readInteractiveProfile(location: InteractiveProfileLocation = {}): InteractiveProfile | null {
  const path = selectedConfigPath(location)
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > 16_384) return fail()
    return validateInteractiveProfile(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Do not include JSON contents, paths, or backend details in diagnostics.
    throw new Error('Interactive profile could not be read or validated.')
  }
}

function overrides(value: InteractiveProfileOverrides | undefined): InteractiveProfileOverrides {
  if (value === undefined) return {}
  const record = object(value)
  if (Object.keys(record).some(key => !['dataRoot', 'stateDir', 'defaultVariantScope', 'secretBackend'].includes(key))) return fail()
  return record as InteractiveProfileOverrides
}

/** Explicit roots > selected profile > caller's legacy defaults. Never creates roots or merges data. */
export function resolveInteractiveProfile(options: InteractiveProfileLocation & {
  legacyDefaults?: InteractiveProfileOverrides
  overrides?: InteractiveProfileOverrides
} = {}): InteractiveProfile {
  const home = absolute(options.home ?? homedir())
  const root = join(home, '.xingular-harness')
  const selected = readInteractiveProfile(options)
  const legacy = overrides(options.legacyDefaults)
  const explicit = overrides(options.overrides)
  const dataRoot = explicit.dataRoot ?? selected?.dataRoot ?? legacy.dataRoot ?? join(root, 'data')
  const stateDir = explicit.stateDir ?? selected?.stateDir ?? legacy.stateDir ?? join(root, 'state')
  const defaultVariantScope = explicit.defaultVariantScope ?? selected?.defaultVariantScope ?? legacy.defaultVariantScope ?? 'default'
  const secretBackend = explicit.secretBackend ?? selected?.secretBackend ?? legacy.secretBackend ?? {
    kind: 'file' as const,
    path: join(stateDir, 'secrets.json')
  }
  return validateInteractiveProfile({ version: 1, dataRoot, stateDir, defaultVariantScope, secretBackend })
}

/**
 * Explicit adoption only. Creates the profile file, never roots or credentials; it never replaces
 * an existing profile or merges data. A pre-profile host must supply its selected backend in
 * `legacyDefaults` so an absent profile cannot silently downgrade it to the file store.
 */
export function adoptInteractiveProfile(profile: InteractiveProfile, location: InteractiveProfileLocation = {}): void {
  const validated = validateInteractiveProfile(profile)
  const path = selectedConfigPath(location)
  const folder = dirname(path)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const temporary = join(folder, `.profile-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(temporary, path)
  } catch {
    throw new Error('Interactive profile adoption failed; existing configuration was not replaced.')
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Every participating process must map this host id to the same credential store. The account
 * lock serializes access but cannot unify distinct native Keychain identities; no file fallback is
 * allowed when a selected host adapter is unavailable.
 */
export async function interactiveProfileSecretStore(
  profile: InteractiveProfile,
  host?: (descriptor: Extract<SecretBackendDescriptor, { kind: 'host' }>) => SecretStore | Promise<SecretStore>
): Promise<SecretStore> {
  const { secretBackend } = validateInteractiveProfile(profile)
  if (secretBackend.kind === 'file') return fileSecretStore(secretBackend.path)
  if (!host) throw new Error('The selected credential backend is unavailable; supply its host SecretStore adapter.')
  const store = await host(secretBackend)
  if (!store || !['get', 'set', 'delete'].every(key => typeof store[key as keyof SecretStore] === 'function')) {
    throw new Error('The selected credential backend did not provide a SecretStore.')
  }
  return store
}
