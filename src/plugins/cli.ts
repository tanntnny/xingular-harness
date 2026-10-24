// `xagent plugins …`: plugin control for a person using the harness without an
// application. It runs outside any session, as the person who typed it, and acts directly.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { DEFAULT_PRODUCT_NAME } from '../core/env'
import { Harness, type HarnessOptions } from '../harness'
import * as api from './api'
import * as install from './install'
import type { Plugin } from './types'

export const PLUGINS_USAGE = `Usage: xagent plugins <command> [options]

  list                         Every plugin and whether it is on
  show <plugin id>             One plugin: what it brings, where it is on, its code
  install <source>             A folder, an npm name, or a git address. It arrives off and untrusted
  remove <plugin id>           Remove a plugin you installed
  update [plugin id]           Fetch a newer version of one installed plugin, or of all
  attach <id>                  Switch a plugin, or one thing it brings, on
  detach <id>                  Switch it off
  trust <plugin id> [--yes]    Show the files of its code, then trust them
  untrust <plugin id>          Stop trusting its code

Options:
  --data <dir>       Data directory (default: ~/.xingular-harness/data)
  --state <dir>      State directory (default: ~/.xingular-harness/state)
  --cwd <dir>        Also list what this working folder brings
  --project <id>     attach/detach for one project instead of everywhere
  --agent <id>       attach/detach for one agent instead of everywhere
`

export interface PluginsCliDependencies {
  home?: string
  cwd?: string
  write?: (text: string) => void
  /** Asks the person a question and returns what they typed. Without it, a trust needs `--yes`. */
  ask?: (question: string) => Promise<string>
  createHarness?: (options: HarnessOptions) => Harness
}

function parse(argv: string[]): { positional: string[]; values: Record<string, string>; switches: Set<string> } {
  const positional: string[] = []
  const values: Record<string, string> = {}
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) positional.push(arg)
    else if (arg === '--yes') switches.add('yes')
    else if (index + 1 < argv.length) {
      values[arg.slice(2)] = argv[index + 1]
      index += 1
    } else throw new Error(`${arg} needs a value.`)
  }
  return { positional, values, switches }
}

const stateOf = (plugin: Plugin): string => {
  if (plugin.required) return 'required'
  if (plugin.trust === 'untrusted') return plugin.attachment && !plugin.attachment.global ? 'off, code not trusted' : 'code not trusted'
  if (plugin.attachment) return plugin.attachment.global ? 'on' : 'off'
  const on = plugin.contributions.filter((entry) => entry.state === 'on').length
  return `${on} of ${plugin.contributions.length} on`
}

function describe(plugin: Plugin): string {
  const lines = [`${plugin.title} (${plugin.id})`, `  ${plugin.description || 'No description.'}`, `  Source: ${plugin.source}${plugin.version ? ` ${plugin.version}` : ''}${plugin.path ? ` · ${plugin.path}` : ''}`, `  State: ${stateOf(plugin)}`]
  if (plugin.extends.length) lines.push(`  Extends: ${plugin.extends.join(', ')}`)
  if (plugin.code) lines.push(`  Code (${plugin.trust}), fingerprint ${plugin.code.hash.slice(0, 12)}:`, ...plugin.code.files.map((file) => `    ${file}`))
  for (const entry of plugin.contributions) lines.push(`  ${entry.state === 'on' ? '●' : '○'} ${entry.kind} ${entry.name} (${entry.id})${entry.scope ? ` · ${entry.scope}` : ''}${entry.problem ? ` · last run failed: ${entry.problem}` : ''}`)
  return lines.join('\n')
}

export async function runPluginsCli(argv: string[], dependencies: PluginsCliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => void process.stdout.write(text))
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const [command, target] = parsed.positional
  if (!command || command === 'help') {
    write(PLUGINS_USAGE)
    return command ? 0 : 2
  }
  const base = dependencies.cwd ?? process.cwd()
  const root = join(dependencies.home ?? homedir(), '.xingular-harness')
  const options: HarnessOptions = { dataRoot: parsed.values.data ? resolve(base, parsed.values.data) : join(root, 'data'), stateDir: parsed.values.state ? resolve(base, parsed.values.state) : join(root, 'state'), productName: DEFAULT_PRODUCT_NAME }
  // Built without opening the data root: a plugin command must not settle runs or migrate a Wiki
  // that another process may be using.
  const harness = dependencies.createHarness ? dependencies.createHarness(options) : new Harness(options)
  const scope = { cwd: parsed.values.cwd ? resolve(base, parsed.values.cwd) : null }
  const need = (what: string): string => {
    if (!target) throw new Error(`${command} needs ${what}.`)
    return target
  }
  const find = async (id: string): Promise<Plugin> => {
    const plugin = (await api.list(harness, scope)).find((candidate) => candidate.id === id)
    if (!plugin) throw new Error(`There is no plugin with the id "${id}". Run "plugins list" to see the ids.`)
    return plugin
  }
  try {
    switch (command) {
      case 'list': {
        const plugins = await api.list(harness, scope)
        const width = Math.max(...plugins.map((plugin) => plugin.id.length))
        write(`${plugins.map((plugin) => `${plugin.id.padEnd(width)}  ${stateOf(plugin).padEnd(22)}  ${plugin.title}`).join('\n')}\n`)
        return 0
      }
      case 'show':
        write(`${describe(await find(need('a plugin id')))}\n`)
        return 0
      case 'install': {
        const before = new Set((await api.list(harness, scope)).map((plugin) => plugin.id))
        const added = (await install.install(harness, { ...scope, source: need('a folder, an npm name, or a git address') })).filter((plugin) => !before.has(plugin.id))
        write(added.length ? `${added.map(describe).join('\n\n')}\n\nInstalled, switched off. Switch it on with "plugins attach <id>"${added.some((plugin) => plugin.code) ? ' and trust its code with "plugins trust <id>"' : ''}.\n` : 'Nothing new was installed.\n')
        return 0
      }
      case 'remove':
        await install.remove(harness, { ...scope, pluginId: need('a plugin id') })
        write(`Removed ${target}.\n`)
        return 0
      case 'update':
        await install.update(harness, { ...scope, pluginId: target ?? null })
        write(target ? `Updated ${target}. If its code changed, trust it again.\n` : 'Updated the installed plugins. Any whose code changed needs trust again.\n')
        return 0
      case 'attach':
      case 'detach': {
        const where = parsed.values.agent ? { agentId: parsed.values.agent } : parsed.values.project ? { projectId: parsed.values.project } : {}
        await api.attach(harness, { ...scope, id: need('a plugin or contribution id'), scope: where }, command === 'attach')
        write(`${target} is ${command === 'attach' ? 'on' : 'off'} ${parsed.values.agent ? `for agent ${parsed.values.agent}` : parsed.values.project ? `for project ${parsed.values.project}` : 'everywhere'}. It applies from the next session start.\n`)
        return 0
      }
      case 'trust': {
        const plugin = await find(need('a plugin id'))
        if (!plugin.code) throw new Error(`${plugin.title} has no code that waits for trust.`)
        if (plugin.trust === 'trusted') {
          write(`${plugin.title} is already trusted.\n`)
          return 0
        }
        write(`${plugin.title} brings code that runs inside the harness and its sessions. It can do anything you can, including reading your files and credentials.\n\nFiles:\n${plugin.code.files.map((file) => `  ${file}`).join('\n')}\n\nFingerprint ${plugin.code.hash.slice(0, 12)}\n`)
        if (!parsed.switches.has('yes')) {
          if (!dependencies.ask) throw new Error('Read the files, then run this again with --yes to trust them.')
          if ((await dependencies.ask('Trust this code? Type yes: ')).trim().toLowerCase() !== 'yes') {
            write('Not trusted.\n')
            return 1
          }
        }
        await api.trust(harness, { ...scope, hash: plugin.code.hash })
        write(`Trusted. If any of these files changes, it asks again.\n`)
        return 0
      }
      case 'untrust': {
        const plugin = await find(need('a plugin id'))
        if (!plugin.code) throw new Error(`${plugin.title} has no code to stop trusting.`)
        await api.untrust(harness, { ...scope, hash: plugin.code.hash })
        write(`${plugin.title} is not trusted any more.\n`)
        return 0
      }
      default:
        write(PLUGINS_USAGE)
        return 2
    }
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    await harness.close()
  }
}

/** Asks on the terminal, when there is one to ask on. */
export function terminalAsk(): ((question: string) => Promise<string>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined
  return async (question) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await reader.question(question)
    } finally {
      reader.close()
    }
  }
}
