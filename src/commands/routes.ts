import { BUILTIN_PLUGIN_REGISTRY } from '../plugins/builtin'

/** One observed registration, identified by its package or loose extension owner. */
export interface CommandRoute {
  prefix: string
  name: string
  owner: string
  path: string
}

/** Listing and dispatch reject the whole prefix when different owners claim it. */
export function commandRoutes<T extends CommandRoute>(commands: readonly T[]) {
  const routes = new Map<string, T[]>()
  const byName = new Map<string, T[]>()
  const ownersByPrefix = new Map<string, Map<string, Set<string>>>()
  const builtinPrefixes = new Map(BUILTIN_PLUGIN_REGISTRY.commands().map(command => [command.prefix, command.pluginId]))
  for (const command of commands) {
    const owners = ownersByPrefix.get(command.prefix) ?? new Map<string, Set<string>>()
    const paths = owners.get(command.owner) ?? new Set<string>()
    paths.add(command.path)
    owners.set(command.owner, paths)
    ownersByPrefix.set(command.prefix, owners)
    const route = `${command.prefix}:${command.name}`
    routes.set(route, [...(routes.get(route) ?? []), command])
    byName.set(command.name, [...(byName.get(command.name) ?? []), command])
  }
  const conflictingPrefixes = new Map<string, string[]>()
  for (const [prefix, owners] of ownersByPrefix) {
    const builtin = builtinPrefixes.get(prefix)
    if (owners.size > 1 || builtin || prefix === 'plugin' || prefix === 'skill') {
      conflictingPrefixes.set(prefix, [
        ...(builtin ? [`built-in plugin ${builtin}`] : []),
        ...[...owners.values()].flatMap(paths => [...paths])
      ])
    }
  }
  return { routes, byName, ownersByPrefix, conflictingPrefixes }
}

/** Namespace roots and reserved routes cannot be claimed by prompt templates. */
export function promptCommandAvailable(
  name: string,
  taken: ReadonlySet<string>,
  extensionCommands: ReadonlySet<string> = new Set()
): boolean {
  return !name.includes(':') && !taken.has(name) && !extensionCommands.has(name)
}
