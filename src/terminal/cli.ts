// `xagent-wiki` and `xagent-mcp`: the harness's notes, skills, history and connected apps as
// commands, for a `pi` terminal session's shell. Each command maps onto one call to the session socket.
import type { HarnessCall } from '../tools/definitions'
import { connectionFromEnv, socketCall } from './client'

export const WIKI_COMMAND = 'xagent-wiki'
export const APPS_COMMAND = 'xagent-mcp'

export const USAGE = `Usage: ${WIKI_COMMAND} <command> [arguments]

  search <query> [--project SLUG]    Search the Wiki's project notes
  read <path>                        Read one note, e.g. projects/<slug>/decisions
  list [project slug | library]      List notes
  write <path> <text | ->            Save a note (when this session may write the Wiki)
  skill [name]                       Load one of your skills, or list them
  history <query> [--scope all] [--since YYYY-MM-DD]
                                     Search earlier conversations and runs (also: recall)
  history-read <run id>              Read one earlier run (also: recall-read)
`

export const APPS_USAGE = `Usage: ${APPS_COMMAND} <command>

  list                               The app and connected-app tools this session may use
  call <tool-name> '<JSON arguments>'
                                     Use one of them
`

export type CliCommand = { kind: 'call'; call: HarnessCall; params: Record<string, unknown> } | { kind: 'help' } | { kind: 'stdin-write'; path: string }

function options(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--') && index + 1 < args.length) {
      flags[arg.slice(2)] = args[index + 1]!
      index += 1
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

export function parseCli(argv: string[]): CliCommand {
  const [command, ...rest] = argv
  const { positional, flags } = options(rest)
  const joined = positional.join(' ').trim()
  switch (command) {
    case 'search':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'wiki.search', params: { query: joined, ...(flags.project ? { project: flags.project } : {}) } }
    case 'read':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'wiki.read', params: { path: joined } }
    case 'list':
      return { kind: 'call', call: 'wiki.list', params: joined ? { project: joined } : {} }
    case 'write': {
      const [path, ...words] = positional
      if (!path) return { kind: 'help' }
      if (words.join(' ').trim() === '-') return { kind: 'stdin-write', path }
      if (!words.length) return { kind: 'help' }
      return { kind: 'call', call: 'wiki.write', params: { path, text: words.join(' ') } }
    }
    case 'skill':
      return { kind: 'call', call: 'skill.load', params: joined ? { name: joined } : {} }
    case 'history':
    case 'recall':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'recall.search', params: { query: joined, ...(flags.scope ? { scope: flags.scope } : {}), ...(flags.since ? { since: flags.since } : {}) } }
    case 'history-read':
    case 'recall-read':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'recall.read', params: { run: joined } }
    default:
      return { kind: 'help' }
  }
}

async function readStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk.toString()
  return text
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs `xagent-wiki <argv>`; returns the exit code. */
export async function runWikiCli(argv: string[]): Promise<number> {
  const command = parseCli(argv)
  if (command.kind === 'help') {
    process.stdout.write(USAGE)
    return argv.length ? 2 : 0
  }
  try {
    const connection = connectionFromEnv()
    const result =
      command.kind === 'stdin-write'
        ? await socketCall<string>(connection, 'wiki.write', { path: command.path, text: await readStdin() })
        : await socketCall<string>(connection, command.call, command.params)
    process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    return 1
  }
}

/** Runs `xagent-mcp <argv>`; returns the exit code. */
export async function runAppsCli(argv: string[]): Promise<number> {
  const [command, name, args] = argv
  if (command !== 'list' && !(command === 'call' && name)) {
    process.stdout.write(APPS_USAGE)
    return argv.length ? 2 : 0
  }
  try {
    const connection = connectionFromEnv()
    const result = command === 'list' ? await socketCall(connection, 'mcp.list', {}, 90_000) : await socketCall(connection, 'mcp.call', { name, args: JSON.parse(args ?? '{}') as unknown }, 1_230_000)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    return 1
  }
}
