import type { HubOverview } from '../hub/schema'
import type { Connection } from '../mcp/types'
import type { Plugin } from '../plugins/types'

export const BROWSER_SECTIONS = ['overview', 'foundation', 'variant', 'skills', 'plugins', 'connections', 'tools', 'library'] as const
export type BrowserSection = typeof BROWSER_SECTIONS[number]
export type BrowserSource = 'installed' | 'discover'
export type BrowserChannel = 'all' | 'community' | 'official'
export const BROWSER_COMMANDS = new Set(['harness', 'skills', 'plugins', 'connections', 'mcp', 'tools', 'hub', 'components'])

export interface BrowserItem {
  id: string
  section: BrowserSection
  name: string
  description: string
  owner: string
  origin: string
  status: string
  path?: string
  scope?: string | null
  pluginId?: string
  contributionId?: string
  componentId?: string
  connectionId?: string
  skillName?: string
  available?: boolean
  read?: boolean
  added?: boolean
  required?: string | null
  parameters?: unknown
}

export interface BrowserSnapshot {
  items: BrowserItem[]
  plugins: Plugin[]
  connections: Connection[]
  variant: { scope: string | null; pinned: string | null; latest: string | null; writable: boolean }
  hub: HubOverview | null
}

export interface BrowserRuntime {
  skills: { name: string; description: string; filePath: string }[]
  tools: { name: string; description: string; parameters?: unknown; sourceInfo?: { path: string; source: string } }[]
  activeTools: string[]
  skillCommands: boolean
}

/** Saved configuration never establishes what the current runtime has loaded. */
export function browserItems(snapshot: BrowserSnapshot, runtime: BrowserRuntime): BrowserItem[] {
  const items = snapshot.items.map(item => ({ ...item }))
  for (const skill of runtime.skills) {
    const existing = items.find(item => item.section === 'skills' && item.path === skill.filePath)
    if (existing) Object.assign(existing, { available: true, skillName: skill.name, status: 'Available now' })
    else items.push({ id: `runtime:skill:${skill.filePath}`, section: 'skills', name: skill.name, description: skill.description,
      owner: 'Session resource loader', origin: 'Loaded resource', status: 'Available now', available: true, skillName: skill.name, path: skill.filePath })
  }
  const active = new Set(runtime.activeTools)
  for (const tool of runtime.tools) {
    const candidates = items.filter(item => item.section === 'tools' && item.name === tool.name)
    const sourcePath = tool.sourceInfo?.path.replaceAll('\\', '/')
    const owner = sourcePath ? snapshot.plugins.filter(plugin => {
      const path = plugin.path?.replaceAll('\\', '/')
      return path && (sourcePath === path || sourcePath.startsWith(path + '/'))
    }).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0] : undefined
    const builtin = sourcePath?.startsWith('builtin:') ? candidates.filter(item => item.origin === 'builtin' || item.origin === 'pi') : []
    const existing = owner ? candidates.find(item => item.pluginId === owner.id) : builtin.length === 1 ? builtin[0] : candidates.length === 1 ? candidates[0] : undefined
    const state = { available: active.has(tool.name), status: active.has(tool.name) ? 'Available now' : 'Not active here', parameters: tool.parameters }
    if (existing) Object.assign(existing, state, { description: tool.description || existing.description })
    else items.push({ id: `runtime:tool:${tool.name}`, section: 'tools', name: tool.name, description: tool.description,
      owner: 'Runtime (unattributed)', origin: tool.sourceInfo?.source ?? 'Session', path: tool.sourceInfo?.path, ...state })
  }
  return items.sort((a, b) => Number(Boolean(b.available)) - Number(Boolean(a.available)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function catalogSection(entry: NonNullable<BrowserSnapshot['hub']>['entries'][number]): BrowserSection {
  if (entry.delivery.kind === 'registry') return entry.delivery.registryKind === 'skills' ? 'skills' : 'library'
  if (entry.category === 'connector') return 'connections'
  if (entry.delivery.kind === 'pi-package') return 'plugins'
  return 'library'
}
