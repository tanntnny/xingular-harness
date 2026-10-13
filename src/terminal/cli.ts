// `agentx-wiki` and `agentx-mcp`: the harness's memory, Wiki, and connected apps as commands,
// for a `pi` terminal session's shell. Each command maps onto one call to the session socket.
import type { WikiCall } from '../tools/definitions'
import { connectionFromEnv, socketCall } from './client'

export const WIKI_COMMAND = 'agentx-wiki'
export const APPS_COMMAND = 'agentx-mcp'

export const USAGE = `Usage: ${WIKI_COMMAND} <command> [arguments]

  entrypoint                         Your context pack: memory blocks, rules, skills, project map
  search <query> [--kind K] [--namespace NS]
                                     Search every namespace (K: page, fact, skill, rule, prompt)
  read <id or path>                  Read one page, fact, skill, rule, or prompt
  list [namespace] [--kind K]        List namespaces and pages, or all entries of a kind
  skill [name]                       Load a skill, or list skills
  facts [query] [--namespace NS]     Recall facts (also: memory)
  history <query> [--scope all] [--since YYYY-MM-DD]
                                     Search earlier conversations and runs (also: recall)
  history-read <run id>              Read one earlier run (also: recall-read)
  block append <label> <text>        Add to a memory block (user, project, or a shared block)
  block replace <label> --old <text> --new <text>
                                     Replace one exact passage in a memory block
  block rethink <label> <text>       Rewrite a whole memory block
  propose <json | ->                 Record knowledge, e.g. {"kind":"fact","title":"…","body":"…",
                                     "type":"preference","sourceRefs":[{"kind":"run","ref":"current"}]}
`

export const APPS_USAGE = `Usage: ${APPS_COMMAND} <command>

  list                               The app and connected-app tools this session may use
  call <tool-name> '<JSON arguments>'
                                     Use one of them
`

export type CliCommand = { kind: 'call'; call: WikiCall; params: Record<string, unknown> } | { kind: 'help' } | { kind: 'stdin-propose' }

function options(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('--') && index + 1 < args.length) {
      flags[arg.slice(2)] = args[index + 1]
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
    case 'entrypoint':
      return { kind: 'call', call: 'wiki.entrypoint', params: {} }
    case 'search':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'wiki.search', params: { query: joined, ...(flags.kind ? { kinds: [flags.kind] } : {}), ...(flags.namespace ? { namespace: flags.namespace } : {}) } }
    case 'read':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'wiki.read', params: { id: joined } }
    case 'list':
      return { kind: 'call', call: 'wiki.list', params: { ...(joined ? { namespace: joined } : {}), ...(flags.kind ? { kind: flags.kind } : {}) } }
    case 'skill':
      return { kind: 'call', call: 'wiki.skill', params: joined ? { name: joined } : {} }
    case 'facts':
    case 'memory':
      return { kind: 'call', call: 'wiki.memory', params: { ...(joined ? { query: joined } : {}), ...(flags.namespace ? { namespace: flags.namespace } : {}) } }
    case 'history':
    case 'recall':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'recall.search', params: { query: joined, ...(flags.scope ? { scope: flags.scope } : {}), ...(flags.since ? { since: flags.since } : {}) } }
    case 'history-read':
    case 'recall-read':
      if (!joined) return { kind: 'help' }
      return { kind: 'call', call: 'recall.read', params: { run: joined } }
    case 'block': {
      const [action, label, ...words] = positional
      const body = words.join(' ').trim()
      if (action === 'append' && label && body) return { kind: 'call', call: 'memory.append', params: { block: label, text: body } }
      if (action === 'rethink' && label && body) return { kind: 'call', call: 'memory.rethink', params: { block: label, body } }
      if (action === 'replace' && label && flags.old !== undefined && flags.new !== undefined) return { kind: 'call', call: 'memory.replace', params: { block: label, old: flags.old, new: flags.new } }
      return { kind: 'help' }
    }
    case 'propose': {
      if (joined === '-') return { kind: 'stdin-propose' }
      try {
        const params = JSON.parse(joined) as unknown
        if (params && typeof params === 'object' && !Array.isArray(params)) return { kind: 'call', call: 'wiki.propose', params: params as Record<string, unknown> }
      } catch {
        // Falls through to help.
      }
      return { kind: 'help' }
    }
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

/** Runs `agentx-wiki <argv>`; returns the exit code. */
export async function runWikiCli(argv: string[]): Promise<number> {
  const command = parseCli(argv)
  if (command.kind === 'help') {
    process.stdout.write(USAGE)
    return argv.length ? 2 : 0
  }
  try {
    const connection = connectionFromEnv()
    const result =
      command.kind === 'stdin-propose'
        ? await socketCall<string>(connection, 'wiki.propose', JSON.parse(await readStdin()) as Record<string, unknown>)
        : await socketCall<string>(connection, command.call, command.params)
    process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    return 1
  }
}

/** Runs `agentx-mcp <argv>`; returns the exit code. */
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
