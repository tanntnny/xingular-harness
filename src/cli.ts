#!/usr/bin/env node
// The `xagent` command.
//
//   xagent serve --state <dir> [--data <dir>] [--name <product>] [--builtins <dir>]…
//                [--host-secrets] [--host-policy] [--host-tools] [--host-directory]
//       Serves the harness to a host process over stdin/stdout (newline-delimited JSON).
//   xagent wiki <command>     Project notes, skills and history, from inside a terminal session.
//   xagent refine <command>   Refine a variant from evidence (refine demo needs no model).
//   xagent mcp <command>      Connected apps, from inside a terminal session.
//   xagent plugins <command>  List, install, switch and trust plugins.
//   xagent web <command>      Search keys for web_search.
//   xagent browser <command>  How the agent's browser runs.
//   xagent worktree <command> Managed git worktrees of the repository you are in.
import { resolve } from 'node:path'
import manifest from '../package.json' with { type: 'json' }

import { log } from './core/bus'
import { createHarness, type HarnessOptions } from './harness'
import { runPluginsCli, terminalAsk } from './plugins/cli'
import { runHubCli } from './hub/cli'
import { runRefineCli } from './refine/cli'
import { runBrowserCli, runWebCli } from './world/cli'
import { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './server/remote'
import { RpcPeer, stdioTransport } from './server/rpc'
import { attach } from './server/serve'
import { runAppsCli, runWikiCli } from './terminal/cli'
import { runStandaloneTerminal, standaloneArguments } from './terminal/standalone'
import { runWorktreeCli } from './worktrees/cli'

const USAGE = `Usage: xagent [--data <dir>] [--state <dir>]
       xagent <terminal | serve | wiki | mcp | plugins | hub | refine | web | browser | worktree> [arguments]

  --version          Print the package version
  (no command)       Start the interactive Harness terminal
  terminal           Start the interactive Harness terminal
  serve --state <dir> [--data <dir>] [--name <product>] [--builtins <dir>]
        [--host-secrets] [--host-policy] [--host-tools] [--host-directory]
                     Serve the harness over newline-delimited JSON
  wiki <command>     Wiki, skill and history commands for a terminal session
  mcp <command>      Connected-app commands for a terminal session
  plugins <command>  List, install, switch and trust plugins (plugins help)
  hub <command>      Browse and install curated items (hub help)
  refine <command>   Refine a harness from evidence (refine demo, refine run)
  web <command>      Search keys for the web tools (web help)
  browser <command>  How the agent's browser runs (browser help)
  worktree <command> Managed git worktrees (worktree help)

Standalone terminal options:
  --data <dir>       Data directory (interactive profile default; otherwise
                     ~/.xingular-harness/data; npm run dev passes its own data root)
  --state <dir>      State directory (interactive profile default; otherwise
                     ~/.xingular-harness/state; npm run dev passes its own state directory)
  --account-state <dir>
                     Sign in as the accounts kept in that state directory (its
                     accounts folder and secrets file); npm run dev shares the
                     installed command's account state by default
  --worktree [name], -w [name]
                     Start in a new managed worktree of this repository, or in
                     the named one
  --variant <scope>  Run on this variant scope's head (default: interactive profile scope)
  --remote-control, --rc
                     Turn on /remote-control at start, to continue from a phone or iPad
`

function flags(argv: string[]): { values: Record<string, string[]>; switches: Set<string> } {
  const values: Record<string, string[]> = {}
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name.startsWith('--')) continue
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      ;(values[name.slice(2)] ??= []).push(next)
      index += 1
    } else switches.add(name.slice(2))
  }
  return { values, switches }
}

function serveCommand(argv: string[]): Promise<number> {
  const { values, switches } = flags(argv)
  const stateArgument = values.state?.[0]
  if (!stateArgument) {
    process.stderr.write('serve needs --state <dir>.\n')
    return Promise.resolve(2)
  }
  // The socket path is built from this folder, so a relative one would depend on where the host ran.
  const stateDir = resolve(stateArgument)
  const peer = new RpcPeer(stdioTransport())
  const options: HarnessOptions = {
    stateDir,
    dataRoot: values.data?.[0] ? resolve(values.data[0]) : null,
    productName: values.name?.[0],
    builtins: values.builtins,
    ...(switches.has('host-secrets') ? { secrets: remoteSecrets(peer) } : {}),
    ...(switches.has('host-policy') ? { policy: remotePolicy(peer) } : {}),
    ...(switches.has('host-directory') ? { directory: remoteDirectory(peer) } : {})
  }
  const harness = createHarness(options)
  if (switches.has('host-tools')) harness.sessions.provide(remoteTools(peer))
  attach(harness, peer)
  return new Promise<number>((resolve) => {
    let closing = false
    const shutdown = (): void => {
      if (closing) return
      closing = true
      void Promise.race([harness.close(), new Promise((done) => setTimeout(done, 5000))]).then(() => resolve(0))
    }
    peer.handle('harness.shutdown', () => void setImmediate(shutdown))
    process.stdin.on('end', shutdown)
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    peer.send({ notice: { type: 'ready' } })
    log('ready')
  })
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    process.stdout.write(`${manifest.version}\n`)
    return 0
  }
  const [command, ...rest] = argv
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const terminalArgs = standaloneArguments(argv)
  if (terminalArgs !== null) return runStandaloneTerminal(terminalArgs)
  if (command === 'serve') return serveCommand(rest)
  if (command === 'wiki') return runWikiCli(rest)
  if (command === 'mcp') return runAppsCli(rest)
  if (command === 'plugins') return runPluginsCli(rest, { ask: terminalAsk() })
  if (command === 'hub') return runHubCli(rest)
  if (command === 'refine') return runRefineCli(rest)
  if (command === 'web') return runWebCli(rest)
  if (command === 'browser') return runBrowserCli(rest)
  if (command === 'worktree') return runWorktreeCli(rest)
  process.stdout.write(USAGE)
  return command ? 2 : 0
}

void main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
)
