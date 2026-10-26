// How a plugin that works better in a host is described to a person, in the terminal and in a
// host alike (PROP-0039, INV-PAR-3).
import type { Plugin, PluginSurfaces } from './types'

/** A short badge for a list row: `better in the app`, or nothing. */
export function surfaceBadge(surfaces: PluginSurfaces | null | undefined): string {
  if (!surfaces) return ''
  return surfaces.terminal === 'unavailable' ? 'app only' : 'better in the app'
}

/** The plugin's description, followed by what the host adds and what the terminal does instead. */
export function describePlugin(plugin: Pick<Plugin, 'description' | 'surfaces'>): string {
  const description = plugin.description || 'No description.'
  return plugin.surfaces ? `${description} ${plugin.surfaces.note}` : description
}
