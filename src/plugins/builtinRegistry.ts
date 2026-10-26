import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import type { WorldOptions, WorldPart } from '../world/world'
import type { BrowserEngine } from '../browser/index'
import type { CallerContext } from '../core/caller'
import type { DispatchEnv } from '../tools/dispatch'
import type { ToolSpec } from '../tools/types'
import type { Subagents } from '../sessions/subagentService'
import type { ActiveRun } from '../sessions/registry'
import type { PluginDescriptor } from './types'

export interface BuiltinPluginCommand {
  pluginId: string
  prefix: string
  name: string
  description: string
  legacyBare: boolean
}

export interface BuiltinWorldContext {
  options: WorldOptions
  setting(pluginId: string, key: string): number
  browserEngine: BrowserEngine | null
}

export interface BuiltinToolContext {
  env: DispatchEnv
  caller: CallerContext
  variantDir: string | null
  run: ActiveRun
  runId: string
  allowedTools: readonly string[]
  harnessTools: boolean
  subagents: Subagents
  sessionName: ToolSpec
  connectionTools?: () => ToolSpec[]
}

export interface BuiltinPluginModule {
  descriptor: PluginDescriptor
  /** Stable terminal command namespace; defaults to the plugin id. */
  commandPrefix?: string
  /** Command invoked by the namespace root, such as `/annotate:`. */
  defaultCommand?: string
  /** Stable order for model tools, independent of descriptor display order. */
  toolOrder?: number
  tools?: (context: BuiltinToolContext) => ToolSpec[]
  commands?: readonly Omit<BuiltinPluginCommand, 'pluginId' | 'prefix' | 'legacyBare'>[]
  createWorldPart?: (context: BuiltinWorldContext) => WorldPart | null
  serverMethods?: (harness: Harness) => Record<string, Handler>
}

export interface BuiltinPluginRegistry {
  readonly modules: readonly BuiltinPluginModule[]
  descriptors(): PluginDescriptor[]
  commands(): BuiltinPluginCommand[]
  command(prefix: string, name: string): BuiltinPluginCommand | undefined
  commandsNamed(name: string): BuiltinPluginCommand[]
  defaultCommand(prefix: string): BuiltinPluginCommand | undefined
  tools(context: BuiltinToolContext): ToolSpec[]
  worldParts(context: BuiltinWorldContext): WorldPart[]
  serverMethods(harness: Harness): Record<string, Handler>
}

/** One checked registry for the Harness-owned plugin modules and their surface contributions. */
export function createBuiltinPluginRegistry(modules: readonly BuiltinPluginModule[]): BuiltinPluginRegistry {
  const pluginIds = new Set<string>()
  const prefixOwners = new Map<string, string>()
  const routeKeys = new Set<string>()
  for (const module of modules) {
    const id = module.descriptor.id
    if (pluginIds.has(id)) throw new Error(`Duplicate built-in plugin id: ${id}`)
    pluginIds.add(id)
    const prefix = module.commandPrefix ?? id
    if (!/^[a-z][a-z0-9-]*$/.test(prefix) || prefix === 'plugin' || prefix === 'skill') throw new Error(`Invalid built-in plugin command prefix: ${prefix}`)
    if ((module.commands?.length || module.defaultCommand) && prefixOwners.has(prefix)) {
      throw new Error(`Duplicate built-in plugin command prefix: ${prefix}`)
    }
    if (module.commands?.length || module.defaultCommand) prefixOwners.set(prefix, id)
    for (const command of module.commands ?? []) {
      if (!/^[a-z][a-z0-9-]*$/.test(command.name)) throw new Error(`Invalid built-in plugin command: ${command.name}`)
      const key = `${prefix}:${command.name}`
      if (routeKeys.has(key)) throw new Error(`Duplicate built-in plugin command: ${key}`)
      routeKeys.add(key)
    }
    if (module.defaultCommand && !module.commands?.some(command => command.name === module.defaultCommand)) {
      throw new Error(`Unknown default command for built-in plugin ${id}: ${module.defaultCommand}`)
    }
  }

  const commands = modules.flatMap(module => (module.commands ?? []).map(command => ({
    pluginId: module.descriptor.id,
    prefix: module.commandPrefix ?? module.descriptor.id,
    ...command,
    legacyBare: !!module.descriptor.required
  })))
  const byRoute = new Map(commands.map(command => [`${command.prefix}:${command.name}`, command]))
  const byName = new Map<string, BuiltinPluginCommand[]>()
  for (const command of commands) byName.set(command.name, [...(byName.get(command.name) ?? []), command])
  const defaults = new Map(modules.flatMap(module => module.defaultCommand
    ? [[module.commandPrefix ?? module.descriptor.id, byRoute.get(`${module.commandPrefix ?? module.descriptor.id}:${module.defaultCommand}`)!] as const]
    : []))
  const toolModules = modules.map((module, index) => ({ module, index })).filter(({ module }) => module.tools)
    .sort((left, right) => (left.module.toolOrder ?? left.index) - (right.module.toolOrder ?? right.index))

  return {
    modules,
    descriptors: () => modules.map(module => module.descriptor),
    commands: () => [...commands],
    command: (prefix, name) => byRoute.get(`${prefix}:${name}`),
    commandsNamed: name => [...(byName.get(name) ?? [])],
    defaultCommand: prefix => defaults.get(prefix),
    tools: context => toolModules.flatMap(({ module }) => module.tools!(context)),
    worldParts: context => modules.flatMap(module => {
      const part = module.createWorldPart?.(context)
      return part ? [part] : []
    }),
    serverMethods: harness => {
      const methods: Record<string, Handler> = {}
      for (const module of modules) {
        const contributed = module.serverMethods?.(harness) ?? {}
        for (const [name, handler] of Object.entries(contributed)) {
          if (name in methods) throw new Error(`Duplicate built-in server method: ${name}`)
          methods[name] = handler
        }
      }
      return methods
    }
  }
}
