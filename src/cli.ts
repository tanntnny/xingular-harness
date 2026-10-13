#!/usr/bin/env node
// The `xingular-harness` command.
//
//   xingular-harness serve --state <dir> [--data <dir>] [--name <product>] [--builtins <dir>]…
//                          [--host-secrets] [--host-policy] [--host-tools] [--host-directory]
//       Serves the harness to a host process over stdin/stdout (newline-delimited JSON).
//   xingular-harness wiki <command>     Memory and Wiki, from inside a terminal session.
//   xingular-harness mcp <command>      Connected apps, from inside a terminal session.
//   xingular-harness plugins <command>  List, install, switch and trust plugins.
import { log } from './core/bus'
import { createHarness, type HarnessOptions } from './harness'
import { runPluginsCli, terminalAsk } from './plugins/cli'
import { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './server/remote'
import { RpcPeer, stdioTransport } from './server/rpc'
import { attach } from './server/serve'
import { runAppsCli, runWikiCli } from './terminal/cli'
import { runStandaloneTerminal, standaloneArguments } from './terminal/standalone'

const USAGE = `Usage: xingular-harness [--data <dir>] [--state <dir>]
       xingular-harness <terminal | serve | wiki | mcp | plugins> [arguments]

  (no command)       Start the interactive Pi terminal
  terminal           Start the interactive Pi terminal
  serve --state <dir> [--data <dir>] [--name <product>] [--builtins <dir>]
        [--host-secrets] [--host-policy] [--host-tools] [--host-directory]
                     Serve the harness over newline-delimited JSON
  wiki <command>     Memory and Wiki commands for a terminal session
  mcp <command>      Connected-app commands for a terminal session
  plugins <command>  List, install, switch and trust plugins (plugins help)

Standalone terminal options:
  --data <dir>       Data directory (default: ~/.xingular-harness/data)
  --state <dir>      State directory (default: ~/.xingular-harness/state)
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
  const stateDir = values.state?.[0]
  if (!stateDir) {
    process.stderr.write('serve needs --state <dir>.\n')
    return Promise.resolve(2)
  }
  const peer = new RpcPeer(stdioTransport())
  const options: HarnessOptions = {
    stateDir,
    dataRoot: values.data?.[0] ?? null,
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
