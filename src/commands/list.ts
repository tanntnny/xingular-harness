// `commands.list`: every slash command a front end offers for one scope, from one source. The
// terminal palette and a host's menu both read it, so they never keep their own lists.
import { BUILTIN_PLUGIN_REGISTRY } from '../plugins/builtin'
import { pluginCommandPrefix } from '../plugins/commandPrefix'
import type { Plugin } from '../plugins/types'
import { CORE_COMMANDS, type ListedCommand } from './registry'
import { commandRoutes, promptCommandAvailable, type CommandRoute } from './routes'

export function listCommands(plugins: readonly Plugin[]): ListedCommand[] {
  const out = new Map<string, ListedCommand>()
  const taken = new Set<string>()
  for (const command of CORE_COMMANDS) {
    const aliases = 'aliases' in command ? [...command.aliases] : []
    out.set(command.name, {
      name: command.name,
      ...(aliases.length ? { aliases } : {}),
      ...('args' in command ? { args: command.args } : {}),
      description: command.description,
      group: command.group,
      source: 'core',
      kind: command.kind
    })
    taken.add(command.name)
    aliases.forEach((alias) => taken.add(alias))
  }

  for (const command of BUILTIN_PLUGIN_REGISTRY.commands()) {
    const name = `${command.prefix}:${command.name}`
    out.set(name, { name, description: command.description, group: 'Plugins', source: 'plugin', owner: command.pluginId })
  }
  for (const module of BUILTIN_PLUGIN_REGISTRY.modules) {
    const prefix = module.commandPrefix ?? module.descriptor.id
    const fallback = BUILTIN_PLUGIN_REGISTRY.defaultCommand(prefix)
    if (fallback) out.set(`${prefix}:`, { name: `${prefix}:`, description: fallback.description, group: 'Plugins', source: 'plugin', owner: module.descriptor.id })
  }

  const extensions: (CommandRoute & { listed: ListedCommand })[] = []
  const extensionCommandNames = new Set<string>()
  for (const plugin of plugins) {
    for (const contribution of plugin.contributions) {
      if (contribution.kind !== 'code' || contribution.state !== 'on' || !contribution.path || !contribution.registered) continue
      contribution.registered.commands.forEach(name => extensionCommandNames.add(name))
    }
  }
  for (const plugin of plugins) {
    for (const contribution of plugin.contributions) {
      if (contribution.state !== 'on') continue
      if (contribution.kind === 'code' && contribution.registered && contribution.path) {
        const packageRoot = (plugin.source === 'package' || plugin.id.startsWith('package:')) ? plugin.path : null
        const prefix = pluginCommandPrefix(packageRoot
          ? { path: contribution.path, origin: 'package', baseDir: packageRoot }
          : { path: contribution.path })
        for (const command of contribution.registered.commands) {
          const name = `${prefix}:${command}`
          extensions.push({ prefix, name: command, owner: packageRoot ? `package:${packageRoot}` : `extension:${contribution.path}`, path: contribution.path,
            listed: { name, group: 'Plugins', source: 'extension', owner: plugin.id } })
        }
      }
      // Catalogue entries without a path are observed extension commands, not templates.
      if (contribution.kind === 'command' && contribution.path && promptCommandAvailable(contribution.name, taken, extensionCommandNames) && !out.has(contribution.name)) {
        out.set(contribution.name, { name: contribution.name, description: contribution.description, group: 'Prompts', source: 'prompt', owner: plugin.id })
      }
      if (contribution.kind === 'skill') {
        const name = `skill:${contribution.name}`
        if (!out.has(name)) out.set(name, { name, description: contribution.description, group: 'Skills', source: 'skill', owner: plugin.id })
      }
    }
  }
  const indexed = commandRoutes(extensions)
  for (const [name, routes] of indexed.routes) {
    if (routes.length === 1 && !indexed.conflictingPrefixes.has(routes[0]!.prefix) && !out.has(name)) out.set(name, routes[0]!.listed)
  }
  return [...out.values()]
}
