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
  /** `--worktree [name]`: start in a new managed worktree (true) or the named one. */
  worktree?: string | true | null
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
  if (!command || command.startsWith('-')) return argv
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
    if (argument === '--worktree' || argument === '-w') {
      const name = argv[index + 1]
      if (name && !name.startsWith('-')) {
        paths.worktree = name
        index += 1
      } else paths.worktree = true
      continue
    }
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
  const problem = code === 'ENOENT' ? 'was not found' : `could not start (${code})`
  return new Error(`Could not start the Harness terminal. The Bun executable "${launch.program}" ${problem}; install Bun or set XINGULAR_HARNESS_BUN, then run npm run build:tui.`, { cause: error })
}

function spawnFrontend(launch: TerminalLaunch, cwd: string, spawn = nodeSpawn): Promise<number> {
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
    // alive while the frontend handles it so the account credentials and harness socket are cleaned up.
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

/**
 * `--worktree`: the named worktree of the repository in `cwd`, or a new managed one. Older managed
 * worktrees beyond the kept number are pruned (unsaved work is kept as a snapshot).
 */
async function enterWorktree(harness: Harness, cwd: string, wanted: string | true): Promise<{ id: string; path: string }> {
  const name = wanted === true ? undefined : wanted
  const existing = name ? (await harness.worktrees.list(cwd)).find((record) => record.name === name) : undefined
  if (existing) return existing
  const created = await harness.worktrees.create({ repo: cwd, ...(name ? { name } : {}) })
  process.stdout.write(`Working in worktree ${created.worktree.name} (${created.worktree.path}).\n`)
  if (created.setup.state === 'untrusted') process.stdout.write('This repository has a setup script you have not trusted; read .xharness/worktree-setup, then run: xharness worktree trust-setup\n')
  if (created.setup.state === 'failed') process.stdout.write(`The worktree setup script failed; see ${created.setup.log}.\n`)
  await harness.worktrees.prune({ repo: cwd }).catch(() => undefined)
  return created.worktree
}

export async function runStandaloneTerminal(argv: string[], dependencies: StandaloneDependencies = {}): Promise<number> {
  if (!(dependencies.stdinIsTTY ?? process.stdin.isTTY) || !(dependencies.stdoutIsTTY ?? process.stdout.isTTY)) {
    throw new Error('The interactive Harness terminal needs a TTY. Run it from a terminal, or use `xharness serve` for a host process.')
  }

  let cwd = resolve(dependencies.cwd ?? process.cwd())
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

    let worktreeId: string | null = null
    if (paths.worktree) {
      const worktree = await enterWorktree(harness, cwd, paths.worktree)
      cwd = worktree.path
      worktreeId = worktree.id
    }
    for (;;) {
      const sessionFolder = join(paths.dataRoot, 'sessions', 'terminal', createHash('sha256').update(cwd).digest('hex'))
      const launch = await harness.terminals.prepare({ ...current, cwd, sessionFolder, ...(worktreeId ? { run: { worktreeId } } : {}) })
      const code = await spawnFrontend(launch, cwd, dependencies.spawn)
      // `/accounts` and `/plugin:worktree` ask for a switch and end the frontend. An account switch resumes
      // the conversation; a folder switch starts a new one there.
      const next = harness.terminals.takeRelaunch(current.sessionId)
      if (!next) return code
      if (next.cwd) {
        process.stdout.write(`Opening ${next.cwd}.\n`)
        cwd = next.cwd
        worktreeId = next.worktreeId ?? null
      } else process.stdout.write(`Switching this session to account ${harness.accounts.find(next.accountId).label}.\n`)
      await harness.terminals.dispose(current.sessionId)
      current = { sessionId: newSessionId(), accountId: next.accountId, nativeSessionId: next.nativeSessionId }
    }
  } finally {
    await harness.terminals.dispose(current.sessionId)
    await harness.close()
    setLogSink(null)
  }
}
