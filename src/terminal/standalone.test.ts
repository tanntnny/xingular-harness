import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { adoptInteractiveProfile, interactiveProfilePath, type InteractiveProfile } from '../core/interactiveProfile'
import { createHarness, type Harness, type HarnessOptions } from '../harness'
import * as variantStore from '../variant/store'
import { seedVariant } from '../variant/seed'
import { defaultAssets, type TerminalPrepareInput } from './terminals'
import { parseStandaloneOptions, runStandaloneTerminal, standaloneArguments } from './standalone'
import { socketPath } from './socket'
import { SOCKET_ENV, TOKEN_ENV, socketCall } from './client'

const scratch: string[] = []
const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

function fakeSpawn(onSpawn: (program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: string }) => void, outcome: { code?: number; error?: Error } = {}): typeof nodeSpawn {
  return ((program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: string }) => {
    onSpawn(program, args, options)
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn(() => true)
    queueMicrotask(() => {
      if (outcome.error) child.emit('error', outcome.error)
      else child.emit('exit', outcome.code ?? 0, null)
    })
    return child
  }) as unknown as typeof nodeSpawn
}

function harnessFactory(options: HarnessOptions): Harness {
  const harness = createHarness({ ...options, secrets: options.secrets ?? memorySecretStore() })
  harnesses.push(harness)
  return harness
}

function makeProfile(home: string, overrides: Partial<InteractiveProfile> = {}): InteractiveProfile {
  return {
    version: 1,
    dataRoot: join(home, 'profile-data'),
    stateDir: join(home, 'profile-state'),
    defaultVariantScope: 'profile-default',
    secretBackend: { kind: 'file', path: join(home, 'selected-secrets', 'credentials.json') },
    ...overrides
  }
}

function saveProfile(home: string, profile: InteractiveProfile): void {
  adoptInteractiveProfile(profile, { home })
}

describe('standalone terminal startup', () => {
  it('routes the no-command and terminal invocations to the frontend, leaving host commands explicit', () => {
    expect(standaloneArguments([])).toEqual([])
    expect(standaloneArguments(['--data', '/tmp/data'])).toEqual(['--data', '/tmp/data'])
    expect(standaloneArguments(['terminal', '--state', '/tmp/state'])).toEqual(['--state', '/tmp/state'])
    expect(standaloneArguments(['serve', '--state', '/tmp/state'])).toBeNull()
  })

  it('uses a dedicated default data and state root and accepts path overrides', () => {
    expect(parseStandaloneOptions([], '/home/test', '/work/project')).toEqual({
      dataRoot: '/home/test/.xingular-harness/data',
      stateDir: '/home/test/.xingular-harness/state'
    })
    expect(parseStandaloneOptions(['--data', './knowledge', '--state', './device'], '/home/test', '/work/project')).toEqual({
      dataRoot: '/work/project/knowledge',
      stateDir: '/work/project/device'
    })
    expect(() => parseStandaloneOptions(['--data'])).toThrow('--data needs a directory path.')
    expect(() => parseStandaloneOptions(['--model', 'unknown'])).toThrow('Unknown standalone option: --model')
  })

  it('resolves profile roots while letting explicit data and state roots win independently', () => {
    const home = temporaryDirectory('harness-profile-roots-')
    const cwd = temporaryDirectory('harness-profile-cwd-')
    const profile = makeProfile(home)
    saveProfile(home, profile)

    expect(existsSync(interactiveProfilePath(home))).toBe(true)
    expect(parseStandaloneOptions([], home, cwd)).toEqual({ dataRoot: profile.dataRoot, stateDir: profile.stateDir })
    expect(parseStandaloneOptions(['--data', './explicit-data'], home, cwd)).toEqual({ dataRoot: join(cwd, 'explicit-data'), stateDir: profile.stateDir })
    expect(parseStandaloneOptions(['--state', './explicit-state'], home, cwd)).toEqual({ dataRoot: profile.dataRoot, stateDir: join(cwd, 'explicit-state') })
  })

  it('keeps npm run dev roots, scope and credentials isolated from the installed profile', async () => {
    const home = temporaryDirectory('harness-profile-dev-')
    const cwd = temporaryDirectory('harness-profile-dev-cwd-')
    const installed = makeProfile(home, { secretBackend: { kind: 'host', id: 'installed-only' } })
    saveProfile(home, installed)
    const devRoot = join(home, '.xingular-harness-dev')
    const dataRoot = join(devRoot, 'data')
    const stateDir = join(devRoot, 'state')
    const developmentProfile = makeProfile(home, {
      defaultVariantScope: 'default',
      secretBackend: { kind: 'host', id: 'dev-host-only' }
    })
    adoptInteractiveProfile(developmentProfile, { configPath: join(devRoot, 'profile.json') })
    let received: HarnessOptions | undefined
    let prepared: TerminalPrepareInput | undefined
    const createHarness = (options: HarnessOptions): Harness => {
      received = options
      const harness = harnessFactory(options)
      const prepare = harness.terminals.prepare.bind(harness.terminals)
      vi.spyOn(harness.terminals, 'prepare').mockImplementation(async input => {
        prepared = structuredClone(input)
        return prepare(input)
      })
      return harness
    }

    await runStandaloneTerminal(['--data', dataRoot, '--state', stateDir], {
      home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createHarness, spawn: fakeSpawn(() => undefined)
    })
    await received!.secrets!.set('fake-account/test', 'fake-credential')

    expect(received).toMatchObject({ dataRoot, stateDir })
    expect(prepared?.variant).toEqual({ scope: 'default' })
    expect(variantStore.head(dataRoot, 'default')).not.toBeNull()
    expect(variantStore.head(dataRoot, installed.defaultVariantScope)).toBeNull()
    expect(existsSync(join(stateDir, 'secrets.json'))).toBe(true)
    expect(existsSync(join(developmentProfile.stateDir, 'secrets.json'))).toBe(false)
    expect(installed.secretBackend).toEqual({ kind: 'host', id: 'installed-only' })
    expect(developmentProfile.secretBackend).toEqual({ kind: 'host', id: 'dev-host-only' })
    expect(existsSync(join(installed.stateDir, 'secrets.json'))).toBe(false)
  })

  it('runs on the profile default scope unless --variant selects another scope', async () => {
    const home = temporaryDirectory('harness-profile-variant-')
    const cwd = temporaryDirectory('harness-profile-variant-cwd-')
    const profile = makeProfile(home)
    saveProfile(home, profile)
    const explicitData = join(cwd, 'explicit-data')
    const explicitScope = 'manual-scope'
    variantStore.seed(profile.dataRoot, explicitScope, seedVariant(profile.dataRoot, {}))

    const harnessOptions: HarnessOptions[] = []
    const prepared: TerminalPrepareInput[] = []
    const createHarness = (options: HarnessOptions): Harness => {
      harnessOptions.push(options)
      const harness = harnessFactory(options)
      const prepare = harness.terminals.prepare.bind(harness.terminals)
      vi.spyOn(harness.terminals, 'prepare').mockImplementation(async input => {
        prepared.push(structuredClone(input))
        return prepare(input)
      })
      return harness
    }
    const spawn = fakeSpawn(() => undefined)

    await runStandaloneTerminal(['--data', explicitData], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => 'profile-default', createHarness, spawn })
    await runStandaloneTerminal(['--state', './explicit-state', '--variant', explicitScope], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => 'profile-explicit', createHarness, spawn })

    expect(harnessOptions[0]).toMatchObject({ dataRoot: explicitData, stateDir: profile.stateDir })
    expect(prepared[0]?.variant).toEqual({ scope: profile.defaultVariantScope })
    expect(variantStore.head(explicitData, profile.defaultVariantScope)).not.toBeNull()
    expect(harnessOptions[1]).toMatchObject({ dataRoot: profile.dataRoot, stateDir: join(cwd, 'explicit-state') })
    expect(prepared[1]?.variant).toEqual({ scope: explicitScope })
    expect(variantStore.head(profile.dataRoot, profile.defaultVariantScope)).toBeNull()
  })

  it('uses the selected profile file path for credentials', async () => {
    const home = temporaryDirectory('harness-profile-secrets-')
    const cwd = temporaryDirectory('harness-profile-secrets-cwd-')
    const profile = makeProfile(home)
    saveProfile(home, profile)
    let received: HarnessOptions | undefined
    const createHarness = (options: HarnessOptions): Harness => {
      received = options
      return harnessFactory(options)
    }

    await runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createHarness, spawn: fakeSpawn(() => undefined) })
    await received!.secrets!.set('fake-account/test', 'fake-credential')

    expect(existsSync(profile.secretBackend.kind === 'file' ? profile.secretBackend.path : '')).toBe(true)
    expect(existsSync(join(profile.stateDir, 'secrets.json'))).toBe(false)
  })

  it('fails closed before startup when a selected host credential backend has no adapter', async () => {
    const home = temporaryDirectory('harness-profile-host-secrets-')
    const cwd = temporaryDirectory('harness-profile-host-secrets-cwd-')
    const profile = makeProfile(home, { secretBackend: { kind: 'host', id: 'missing-adapter' } })
    saveProfile(home, profile)
    const createHarness = vi.fn(harnessFactory)

    await expect(runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createHarness, spawn: fakeSpawn(() => undefined) }))
      .rejects.toThrow('selected credential backend is unavailable')
    expect(createHarness).not.toHaveBeenCalled()
    expect(existsSync(profile.stateDir)).toBe(false)
  })

  it('seeds the profile scope only once and leaves a later head untouched', async () => {
    const home = temporaryDirectory('harness-profile-seed-')
    const cwd = temporaryDirectory('harness-profile-seed-cwd-')
    const profile = makeProfile(home)
    saveProfile(home, profile)
    const run = (id: string): Promise<number> => runStandaloneTerminal([], {
      home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => id,
      createHarness: harnessFactory, spawn: fakeSpawn(() => undefined)
    })

    await run('seed-first')
    const first = variantStore.head(profile.dataRoot, profile.defaultVariantScope)!
    expect(variantStore.lineage(profile.dataRoot, profile.defaultVariantScope)).toHaveLength(1)
    await run('seed-repeat')
    expect(variantStore.head(profile.dataRoot, profile.defaultVariantScope)?.fingerprint).toBe(first.fingerprint)
    expect(variantStore.lineage(profile.dataRoot, profile.defaultVariantScope)).toHaveLength(1)

    const existing = variantStore.headVariant(profile.dataRoot, profile.defaultVariantScope)!.variant
    const changed = { ...existing, 'systemprompt.md': 'An existing pinned profile head.\n' }
    const saved = variantStore.commit(profile.dataRoot, profile.defaultVariantScope, changed, { kind: 'edit', note: 'test existing head' })
    await run('seed-preserve-head')
    expect(variantStore.head(profile.dataRoot, profile.defaultVariantScope)?.fingerprint).toBe(saved.fingerprint)
    expect(variantStore.exists(profile.dataRoot, profile.defaultVariantScope, first.fingerprint)).toBe(true)
    expect(variantStore.lineage(profile.dataRoot, profile.defaultVariantScope)).toHaveLength(2)
  })

  it('runs on a named variant scope with --variant, as a host agent of that scope does', () => {
    expect(parseStandaloneOptions(['--variant', 'assistant', '--data', '/d'], '/home/test', '/work/project')).toMatchObject({ variant: 'assistant', dataRoot: '/d' })
    expect(() => parseStandaloneOptions(['--variant'])).toThrow('--variant needs a variant scope.')
  })

  it('starts in a managed worktree with --worktree or -w, optionally named', () => {
    expect(standaloneArguments(['-w'])).toEqual(['-w'])
    expect(parseStandaloneOptions(['--worktree'], '/home/test', '/work/project').worktree).toBe(true)
    expect(parseStandaloneOptions(['-w', 'fix-login', '--data', '/d'], '/home/test', '/work/project')).toMatchObject({ worktree: 'fix-login', dataRoot: '/d' })
    expect(parseStandaloneOptions(['--worktree', '--state', '/s'], '/home/test', '/work/project')).toMatchObject({ worktree: true, stateDir: '/s' })
  })

  it('refuses default folders under a home that is not a folder path, and accepts explicit absolute folders', () => {
    expect(() => parseStandaloneOptions([], 'HOME', '/work/project')).toThrow('is not an absolute path')
    expect(parseStandaloneOptions(['--data', '/data', '--state', '/state'], 'HOME', '/work/project')).toEqual({ dataRoot: '/data', stateDir: '/state' })
  })

  it('starts OpenTUI in the current directory, creates the first isolated account, and cleans up on exit', async () => {
    const home = temporaryDirectory('harness-standalone-')
    const cwd = temporaryDirectory('harness-cwd-')
    const paths = parseStandaloneOptions([], home)
    let invocation: { program: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: string } } | undefined
    const spawn = fakeSpawn((program, args, options) => {
      invocation = { program, args, options }
    })

    expect(await runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => 'standalone', createHarness: harnessFactory, spawn })).toBe(0)

    const harness = harnesses.shift()!
    expect(harness.accounts.overview().accounts).toMatchObject([{ label: 'Default', isDefault: true }])
    expect(invocation?.program).toBe(process.env.XINGULAR_HARNESS_BUN || 'bun')
    expect(invocation?.args.slice(0, 2)).toEqual(['--conditions=browser', defaultAssets().openTui])
    expect(invocation?.options).toMatchObject({ cwd, stdio: 'inherit' })
    expect(invocation?.args).toContain('--extension')
    expect(invocation?.args).toContain(defaultAssets().piExtension)
    expect(invocation?.args).toContain(join(paths.dataRoot, 'sessions', 'terminal', createHash('sha256').update(resolve(cwd)).digest('hex'), 'pi'))
    expect(invocation?.options.env?.PI_CODING_AGENT_DIR).toContain(join(paths.stateDir, 'accounts'))
    expect(invocation?.options.env?.XINGULAR_HARNESS_SOCKET).toBeTruthy()
    expect(invocation?.options.env?.XINGULAR_HARNESS_TOKEN).toBeTruthy()
    expect(existsSync(join(paths.stateDir, 'accounts', harness.accounts.overview().accounts[0].id, 'home', 'pi', 'auth.json'))).toBe(false)
    expect(existsSync(socketPath(paths.stateDir))).toBe(false)
    expect(harness.terminals.has('standalone')).toBe(false)
  })

  it('requires an interactive TTY before creating Harness data', async () => {
    const create = vi.fn(harnessFactory)
    await expect(runStandaloneTerminal([], { stdinIsTTY: false, stdoutIsTTY: true, createHarness: create })).rejects.toThrow('needs a TTY')
    expect(create).not.toHaveBeenCalled()
  })

  it('cleans up the prepared terminal when the frontend cannot be spawned', async () => {
    const home = temporaryDirectory('harness-standalone-fail-')
    const cwd = temporaryDirectory('harness-cwd-fail-')
    const spawn = fakeSpawn(() => undefined, { error: new Error('spawn failed') })

    await expect(runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => 'failed', createHarness: harnessFactory, spawn })).rejects.toThrow('spawn failed')

    const harness = harnesses.shift()!
    const account = harness.accounts.overview().accounts[0]
    expect(existsSync(join(harness.accounts.dir, account.id, 'home', 'pi', 'auth.json'))).toBe(false)
    expect(existsSync(socketPath(harness.stateDir))).toBe(false)
    expect(harness.terminals.has('failed')).toBe(false)
  })

  it('explains a missing Bun executable in terms of the terminal launch', async () => {
    const home = temporaryDirectory('harness-standalone-enoent-')
    const cwd = temporaryDirectory('harness-cwd-enoent-')
    const error = Object.assign(new Error('spawn bun ENOENT'), { code: 'ENOENT' })
    const spawn = fakeSpawn(() => undefined, { error })

    await expect(runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createSessionId: () => 'missing-bun', createHarness: harnessFactory, spawn }))
      .rejects.toThrow(/Could not start the Harness terminal.*Bun executable.*bun.*install Bun or set XINGULAR_HARNESS_BUN/)
  })
})

describe('switching the account of a running terminal', () => {
  it('ends the frontend when the person asks for another account, and starts it again on that account', async () => {
    const home = temporaryDirectory('harness-switch-')
    const cwd = temporaryDirectory('harness-switch-cwd-')
    const paths = parseStandaloneOptions([], home)
    const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    let spareId = ''
    const spawn = ((_program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: string }) => {
      spawned.push({ args, env: options.env ?? {} })
      const child = new EventEmitter() as ChildProcess
      child.kill = vi.fn(() => true)
      void (async () => {
        // Deferred, as a real process is: the launcher attaches its listeners after spawn returns.
        await Promise.resolve()
        if (spawned.length === 1) {
          // The first frontend asks for the other account through its own extension, then ends.
          spareId = harnesses[0].accounts.create('Spare', 'apiKey').accounts.find((account) => account.label === 'Spare')!.id
          const connection = { socket: options.env![SOCKET_ENV]!, token: options.env![TOKEN_ENV]! }
          const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
          await socketCall(connection, 'accounts.relaunch', { accountId: spareId }, 5_000, key)
        }
        child.emit('exit', 0, null)
      })()
      return child
    }) as unknown as typeof nodeSpawn

    expect(await runStandaloneTerminal([], { home, cwd, stdinIsTTY: true, stdoutIsTTY: true, createHarness: harnessFactory, spawn })).toBe(0)

    expect(spawned).toHaveLength(2)
    expect(spawned[1].env.PI_CODING_AGENT_DIR).toContain(join(paths.stateDir, 'accounts', spareId))
    expect(spawned[1].env[TOKEN_ENV]).not.toBe(spawned[0].env[TOKEN_ENV])
    // The session it ended is closed; nothing is left running in the harness.
    expect(harnesses[0].terminals.has('standalone')).toBe(false)
  })
})
