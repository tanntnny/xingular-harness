// What a subagent may use when it starts from a profile: always a subset of its parent (INV-RUN-2).
import type { CapabilitySet } from '../capabilities/types'
import type { PluginDescriptor } from '../plugins/types'
import type { AgentProfile } from './profiles'

export interface NarrowedCapabilities {
  capabilities: CapabilitySet
  /** Tools the profile names that the parent does not have here. */
  unavailable: string[]
}

function pluginOf(id: string): string {
  return id.split('/')[0] ?? ''
}

/**
 * The parent's set narrowed by the profile's tools and plugins and by the tools the spawn call
 * asked for. A required plugin always stays; a tool whose plugin was dropped goes with it.
 */
export function narrowForProfile(parent: CapabilitySet, profile: Pick<AgentProfile, 'tools' | 'plugins'> | null, requested: readonly string[] | undefined, descriptors: readonly PluginDescriptor[]): NarrowedCapabilities {
  let tools = parent.tools.filter((name) => !requested || requested.includes(name))
  let contributions = parent.contributions
  const unavailable = profile?.tools?.filter((name) => !parent.tools.includes(name)) ?? []
  if (profile?.tools) tools = tools.filter((name) => profile.tools!.includes(name))
  if (profile?.plugins) {
    const allowed = new Set([...profile.plugins, ...descriptors.filter((descriptor) => descriptor.required).map((descriptor) => descriptor.id)])
    contributions = contributions.filter((id) => allowed.has(pluginOf(id)))
    const owner = new Map<string, string>()
    for (const descriptor of descriptors) for (const tool of descriptor.tools ?? []) owner.set(tool.name, descriptor.id)
    for (const id of parent.contributions) {
      const [plugin, kind, name] = id.split('/')
      if (kind === 'tool' && plugin && name) owner.set(name, plugin)
    }
    tools = tools.filter((name) => !owner.has(name) || allowed.has(owner.get(name)!))
  }
  return { capabilities: { ...parent, tools, contributions }, unavailable }
}
