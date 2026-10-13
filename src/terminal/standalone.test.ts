import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness, type HarnessOptions } from '../harness'
import { defaultAssets } from './terminals'
import { parseStandaloneOptions, runStandaloneTerminal, standaloneArguments } from './standalone'
import { socketPath } from './socket'

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
  const harness = createHarness({ ...options, secrets: memorySecretStore(), piProgram: () => '/opt/pi/bin/pi' })
  harnesses.push(harness)
  return harness
}

describe('standalone terminal startup', () => {
  it('routes the no-command and terminal invocations to Pi, leaving host commands explicit', () => {
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

  it('starts Pi in the current directory, creates the first isolated account, and cleans up on exit', async () => {
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
    expect(invocation?.program).toBe('/opt/pi/bin/pi')
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

  it('cleans up the prepared terminal when Pi cannot be spawned', async () => {
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
})
