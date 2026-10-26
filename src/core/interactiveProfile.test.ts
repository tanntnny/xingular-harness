import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  adoptInteractiveProfile,
  interactiveProfilePath,
  interactiveProfileSecretStore,
  readInteractiveProfile,
  resolveInteractiveProfile,
  validateInteractiveProfile,
  type InteractiveProfile
} from './interactiveProfile'

const temporaryHomes: string[] = []
const tempHome = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'harness-profile-'))
  temporaryHomes.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) rmSync(path, { recursive: true, force: true })
})

function profile(home: string, overrides: Partial<InteractiveProfile> = {}): InteractiveProfile {
  return {
    version: 1,
    dataRoot: join(home, 'data'),
    stateDir: join(home, 'state'),
    defaultVariantScope: 'default',
    secretBackend: { kind: 'file', path: join(home, 'state', 'secrets.json') },
    ...overrides
  }
}

test('an absent profile falls back to caller legacy roots and backend without creating defaults', () => {
  const home = tempHome()
  const legacy = {
    dataRoot: join(home, 'existing-data'),
    stateDir: join(home, 'existing-state'),
    defaultVariantScope: 'existing-scope',
    secretBackend: { kind: 'host' as const, id: 'existing-store' }
  }

  expect(readInteractiveProfile({ home })).toBeNull()
  expect(resolveInteractiveProfile({ home, legacyDefaults: legacy })).toEqual({ version: 1, ...legacy })
  expect(interactiveProfilePath(home)).toBe(join(home, '.xingular-harness', 'profile.json'))
  expect(existsSync(join(home, '.xingular-harness'))).toBe(false)
  expect(existsSync(legacy.dataRoot)).toBe(false)
  expect(existsSync(legacy.stateDir)).toBe(false)
})

test('an explicit config path selects a profile while explicit roots win without moving its secret backend', () => {
  const home = tempHome()
  const otherHome = tempHome()
  const configPath = join(home, 'custom', 'profile.json')
  const selected = profile(home, {
    dataRoot: join(home, 'profile-data'),
    stateDir: join(home, 'profile-state'),
    defaultVariantScope: 'profile-scope',
    secretBackend: { kind: 'file', path: join(home, 'selected-secrets.json') }
  })
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(selected))

  expect(readInteractiveProfile({ home: otherHome, configPath })).toEqual(selected)
  expect(readInteractiveProfile({ home: otherHome })).toBeNull()
  const resolved = resolveInteractiveProfile({
    home: otherHome,
    configPath,
    legacyDefaults: {
      dataRoot: join(otherHome, 'legacy-data'),
      stateDir: join(otherHome, 'legacy-state'),
      defaultVariantScope: 'legacy-scope',
      secretBackend: { kind: 'host', id: 'legacy-store' }
    },
    overrides: {
      dataRoot: join(otherHome, 'explicit-data'),
      stateDir: join(otherHome, 'explicit-state'),
      defaultVariantScope: 'explicit-scope'
    }
  })

  expect(resolved).toEqual({
    ...selected,
    dataRoot: join(otherHome, 'explicit-data'),
    stateDir: join(otherHome, 'explicit-state'),
    defaultVariantScope: 'explicit-scope'
  })
  expect(existsSync(join(otherHome, 'explicit-data'))).toBe(false)
  expect(existsSync(join(otherHome, 'explicit-state'))).toBe(false)
})

test('malformed profiles fail closed instead of falling back to a default account or backend', () => {
  const home = tempHome()
  const configPath = join(home, 'profile.json')
  writeFileSync(configPath, '{not-json')

  expect(() => resolveInteractiveProfile({ home, configPath, legacyDefaults: { defaultVariantScope: 'legacy' } })).toThrow('could not be read or validated')
  expect(() => validateInteractiveProfile({ ...profile(home), token: 'must-not-be-accepted' })).toThrow('Invalid interactive profile')
  expect(() => validateInteractiveProfile({ ...profile(home), secretBackend: { kind: 'host', id: 'store', token: 'secret' } })).toThrow('Invalid interactive profile')
})

test('profile adoption is explicit, private, no-clobber, and does not create data or state roots', () => {
  const home = tempHome()
  const selected = profile(home, { secretBackend: { kind: 'host', id: 'test-host-store' } })

  adoptInteractiveProfile(selected, { home })
  const path = interactiveProfilePath(home)
  expect(readInteractiveProfile({ home })).toEqual(selected)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path, 'utf8')).not.toContain('credential')
  expect(existsSync(selected.dataRoot)).toBe(false)
  expect(existsSync(selected.stateDir)).toBe(false)

  expect(() => adoptInteractiveProfile({ ...selected, defaultVariantScope: 'replacement' }, { home })).toThrow('existing configuration was not replaced')
  expect(readInteractiveProfile({ home })).toEqual(selected)
})

test('a selected host backend never falls back to a file secret store', async () => {
  const home = tempHome()
  const selected = profile(home, { secretBackend: { kind: 'host', id: 'fake-host-store' } })
  const resolved = resolveInteractiveProfile({
    home,
    configPath: join(home, 'profile.json'),
    overrides: {
      dataRoot: selected.dataRoot,
      stateDir: selected.stateDir,
      defaultVariantScope: selected.defaultVariantScope,
      secretBackend: selected.secretBackend
    }
  })

  await expect(interactiveProfileSecretStore(resolved)).rejects.toThrow('selected credential backend is unavailable')
  expect(existsSync(join(selected.stateDir, 'secrets.json'))).toBe(false)

  const values = new Map<string, string>()
  const seen: string[] = []
  const store = await interactiveProfileSecretStore(resolved, async descriptor => {
    seen.push(descriptor.id)
    return {
      get: async key => values.get(key) ?? null,
      set: async (key, value) => void values.set(key, value),
      delete: async key => void values.delete(key)
    }
  })
  await store.set('fake-account/pi-auth/fake-provider', 'fake-credential')
  expect(await store.get('fake-account/pi-auth/fake-provider')).toBe('fake-credential')
  expect(seen).toEqual(['fake-host-store'])
  expect(existsSync(join(selected.stateDir, 'secrets.json'))).toBe(false)
})

test('the explicit file backend writes only to its selected temporary path', async () => {
  const home = tempHome()
  const path = join(home, 'selected', 'secrets.json')
  const selected = profile(home, { secretBackend: { kind: 'file', path } })
  const store = await interactiveProfileSecretStore(selected)

  await store.set('fake-account/pi-auth/fake-provider', 'fake-credential')
  expect(await store.get('fake-account/pi-auth/fake-provider')).toBe('fake-credential')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(existsSync(join(selected.stateDir, 'secrets.json'))).toBe(false)
})
