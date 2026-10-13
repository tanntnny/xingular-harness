// The standalone entry point for people using the harness directly. Pi owns the interface;
// the harness prepares the isolated account, context, extension, and session socket.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHarness, type Harness, type HarnessOptions } from '../harness'
import type { TerminalLaunch } from './terminals'

export interface StandalonePaths {
  dataRoot: string
  stateDir: string
}

export interface StandaloneDependencies {
  home?: string
  cwd?: string
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  createSessionId?: () => string
  createHarness?: (options: HarnessOptions) => Harness
  spawn?: typeof nodeSpawn
}

export function standaloneArguments(argv: string[]): string[] | null {
  const command = argv[0]
  if (!command || command.startsWith('--') || command === '-h') return argv
  return command === 'terminal' ? argv.slice(1) : null
}

export function parseStandaloneOptions(argv: string[], home = homedir(), cwd = process.cwd()): StandalonePaths {
  const root = join(home, '.xingular-harness')
  const paths: StandalonePaths = {
    dataRoot: join(root, 'data'),
    stateDir: join(root, 'state')
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--data' && argument !== '--state') throw new Error(`Unknown standalone option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a directory path.`)
    paths[argument === '--data' ? 'dataRoot' : 'stateDir'] = resolve(cwd, value)
    index += 1
  }

  return paths
}

function processEnvironment(overrides: Record<string, string | null>): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete environment[name]
    else environment[name] = value
  }
  return environment
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  if (signal === 'SIGHUP') return 129
  return 1
}

function spawnPi(launch: TerminalLaunch, cwd: string, spawn = nodeSpawn): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(launch.program, launch.args, {
      cwd,
      env: processEnvironment(launch.env),
      stdio: 'inherit'
    })
    let settled = false
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      process.off('SIGHUP', onHangup)
    }
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    // Ctrl+C is delivered to both processes in the foreground process group. Keep this host
    // alive while Pi handles it so the account credentials and harness socket are cleaned up.
    const onInterrupt = (): void => undefined
    const onTerminate = (): void => {
      child.kill('SIGTERM')
    }
    const onHangup = (): void => undefined

    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    process.on('SIGHUP', onHangup)
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code, signal) => finish(() => resolveExit(exitCode(code, signal))))
  })
}

export async function runStandaloneTerminal(argv: string[], dependencies: StandaloneDependencies = {}): Promise<number> {
  if (!(dependencies.stdinIsTTY ?? process.stdin.isTTY) || !(dependencies.stdoutIsTTY ?? process.stdout.isTTY)) {
    throw new Error('The interactive Harness terminal needs a TTY. Run it from a terminal, or use `xingular-harness serve` for a host process.')
  }

  const cwd = resolve(dependencies.cwd ?? process.cwd())
  const paths = parseStandaloneOptions(argv, dependencies.home, cwd)
  const makeHarness = dependencies.createHarness ?? createHarness
  const harness = makeHarness({ dataRoot: paths.dataRoot, stateDir: paths.stateDir, productName: 'Xingular Harness' })
  const sessionId = (dependencies.createSessionId ?? randomUUID)()

  try {
    await harness.ready
    if (harness.accounts.overview().accounts.length === 0) harness.accounts.create('Default', 'subscription')

    const cwdHash = createHash('sha256').update(cwd).digest('hex')
    const sessionFolder = join(paths.dataRoot, 'sessions', 'terminal', cwdHash)
    const launch = await harness.terminals.prepare({ sessionId, cwd, sessionFolder })
    return await spawnPi(launch, cwd, dependencies.spawn)
  } finally {
    await harness.terminals.dispose(sessionId)
    await harness.close()
  }
}
