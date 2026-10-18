// The standalone host prepares an isolated Harness terminal and supervises its frontend.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { setLogSink } from '../core/bus'
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

  const given = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--data' && argument !== '--state') throw new Error(`Unknown standalone option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a directory path.`)
    paths[argument === '--data' ? 'dataRoot' : 'stateDir'] = resolve(cwd, value)
    given.add(argument)
    index += 1
  }

  // A home that is not a folder path (for example HOME set to the word "HOME") would put the
  // defaults, and the session socket, in whatever folder the command was started from.
  if (!isAbsolute(home) && !(given.has('--data') && given.has('--state'))) {
    throw new Error(`The home folder "${home}" is not an absolute path, so the default data and state folders cannot be placed. Set HOME to your home folder, or pass --data and --state with absolute folders.`)
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

function spawnError(error: Error, launch: TerminalLaunch): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') return error
  if (launch.program === process.execPath || launch.env.XINGULAR_HARNESS_NODE === launch.program) {
    return new Error(`Could not start the Harness terminal because Node could not run "${launch.args[0] ?? 'the bundled Harness CLI'}" (${code}). Verify Node and the Harness package are installed.`, { cause: error })
  }
  const problem = code === 'ENOENT' ? 'was not found' : `could not start (${code})`
  return new Error(`Could not start Pi terminal. Pi executable "${launch.program}" ${problem}; verify it is installed and executable or check the configured terminal executable.`, { cause: error })
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
    child.once('error', (error) => finish(() => reject(spawnError(error, launch))))
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
  const newSessionId = dependencies.createSessionId ?? randomUUID
  let current = { sessionId: newSessionId(), accountId: null as string | null, nativeSessionId: null as string | null }
  // The frontend draws on this terminal, so the host's diagnostics go to a file the person can read instead.
  const logFile = join(paths.stateDir, 'harness.log')
  setLogSink((text) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`)
    } catch {
      // Diagnostics are best effort; a full disk must not stop the terminal.
    }
  })

  try {
    await harness.ready
    if (harness.accounts.overview().accounts.length === 0) harness.accounts.create('Default', 'subscription')

    const cwdHash = createHash('sha256').update(cwd).digest('hex')
    const sessionFolder = join(paths.dataRoot, 'sessions', 'terminal', cwdHash)
    for (;;) {
      const launch = await harness.terminals.prepare({ ...current, cwd, sessionFolder })
      const code = await spawnPi(launch, cwd, dependencies.spawn)
      // `/accounts` asks for a switch and ends Pi. The conversation resumes on the chosen account.
      const next = harness.terminals.takeRelaunch(current.sessionId)
      if (!next) return code
      const label = harness.accounts.find(next.accountId).label
      process.stdout.write(`Switching this session to account ${label}.\n`)
      await harness.terminals.dispose(current.sessionId)
      current = { sessionId: newSessionId(), accountId: next.accountId, nativeSessionId: next.nativeSessionId }
    }
  } finally {
    await harness.terminals.dispose(current.sessionId)
    await harness.close()
    setLogSink(null)
  }
}
