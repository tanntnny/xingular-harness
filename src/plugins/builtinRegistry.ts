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
  name: string
  description: string
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
  /** Stable order for model tools, independent of descriptor display order. */
  toolOrder?: number
  tools?: (context: BuiltinToolContext) => ToolSpec[]
  commands?: readonly Omit<BuiltinPluginCommand, 'pluginId'>[]
  createWorldPart?: (context: BuiltinWorldContext) => WorldPart | null
  serverMethods?: (harness: Harness) => Record<string, Handler>
}

export interface BuiltinPluginRegistry {
  readonly modules: readonly BuiltinPluginModule[]
  descriptors(): PluginDescriptor[]
  commands(): BuiltinPluginCommand[]
  command(name: string): BuiltinPluginCommand | undefined
  tools(context: BuiltinToolContext): ToolSpec[]
  worldParts(context: BuiltinWorldContext): WorldPart[]
  serverMethods(harness: Harness): Record<string, Handler>
}

/** One checked registry for the Harness-owned plugin modules and their surface contributions. */
export function createBuiltinPluginRegistry(modules: readonly BuiltinPluginModule[]): BuiltinPluginRegistry {
  const pluginIds = new Set<string>()
  const commandNames = new Set<string>()
  for (const module of modules) {
    const id = module.descriptor.id
    if (pluginIds.has(id)) throw new Error(`Duplicate built-in plugin id: ${id}`)
    pluginIds.add(id)
    for (const command of module.commands ?? []) {
      if (!/^[a-z][a-z0-9-]*$/i.test(command.name)) throw new Error(`Invalid built-in plugin command: ${command.name}`)
      if (commandNames.has(command.name)) throw new Error(`Duplicate built-in plugin command: ${command.name}`)
      commandNames.add(command.name)
    }
  }

  const commands = modules.flatMap(module => (module.commands ?? []).map(command => ({ pluginId: module.descriptor.id, ...command })))
  const byCommand = new Map(commands.map(command => [command.name, command]))
  const toolModules = modules.map((module, index) => ({ module, index })).filter(({ module }) => module.tools)
    .sort((left, right) => (left.module.toolOrder ?? left.index) - (right.module.toolOrder ?? right.index))

  return {
    modules,
    descriptors: () => modules.map(module => module.descriptor),
    commands: () => [...commands],
    command: name => byCommand.get(name),
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
