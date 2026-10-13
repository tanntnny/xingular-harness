// What reaches one caller: every prompt section, tool, skill, connection and extension, each
// attributed to the plugin it comes from. Anything no plugin accounts for is reported, so a new
// source of model-visible text cannot appear without showing up here.
import { readFileSync } from 'node:fs'

import type { HarnessEnv } from '../core/env'
import { charCount } from '../core/text'
import { allowed } from '../mcp/connections'
import type { Connection } from '../mcp/types'
import type { CallerContext } from '../memory/caller'
import { BUILT_IN_DYNAMIC, compile, toolGroups, type Launch } from '../prompt/compile'
import * as registry from '../skills/registry'
import { ASK_USER } from '../tools/askUser'
import { PLUGIN_PROPOSE } from '../tools/pluginPropose'
import { WIKI_TOOL_NAMES } from '../tools/definitions'
import { INCLUDED_PLUGIN, YOURS_PLUGIN } from './builtin'
import type { Contribution, Inventory, InventoryItem, Plugin, PluginDescriptor } from './types'

export interface InventoryInput {
  env: HarnessEnv
  context: CallerContext
  /** What the application adds to the prompt for this caller, as it would for a session. */
  launch: Launch
  /** The tools the caller has switched on, as a session's `allow` list. */
  tools: readonly string[]
  /** Whether the caller gets the connected-apps tools. */
  connections: boolean
  plugins: readonly Plugin[]
  descriptors: readonly PluginDescriptor[]
  saved: readonly Connection[]
}

const size = (path: string | null): number | null => {
  if (!path) return null
  try {
    return charCount(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function inventory(input: InventoryInput): Inventory {
  const { env, context, launch, descriptors } = input
  const items: InventoryItem[] = []
  const unattributed: Inventory['unattributed'] = []
  const item = (pluginId: string, kind: InventoryItem['kind'], name: string, delivery: InventoryItem['delivery'], chars: number | null, rest: Partial<InventoryItem> = {}): void => {
    items.push({ pluginId, contributionId: null, kind, name, delivery, chars, cut: false, ...rest })
  }

  const pack = compile(env, context, launch)
  const dynamic = new Set([...BUILT_IN_DYNAMIC.map((entry) => entry.id), ...(launch.sections ?? []).filter((section) => section.dynamic).map((section) => section.id)])
  const active = registry.enabledFor(env.root, context.projectId ?? null, context.agentId ?? null)
  const owner = (entry: registry.RegistryItem): string => (entry.builtin ? INCLUDED_PLUGIN.id : YOURS_PLUGIN.id)
  let systemChars = 0
  let contextChars = 0

  for (const section of pack.sections) {
    const delivery = dynamic.has(section.id) ? 'context' : 'system'
    if (delivery === 'context') contextChars += section.size
    else systemChars += section.size
    if (section.id === 'tools') {
      // One paragraph per tool group; each belongs to the plugin that provides the group.
      for (const group of toolGroups(context, launch)) {
        if (!group.guidance) continue
        const plugin = descriptors.find((descriptor) => descriptor.toolGroups?.includes(group.group))
        if (!plugin) unattributed.push({ kind: 'toolGroup', id: group.group })
        item(plugin?.id ?? '', 'instruction', `Tool guidance: ${group.group}`, delivery, charCount(group.guidance), { cut: section.cut })
      }
      continue
    }
    if (section.id === 'rules') {
      for (const rule of active.filter((entry) => entry.kind === 'rules')) {
        item(owner(rule), 'instruction', rule.name, delivery, charCount(`### ${rule.name} (${rule.id})\n\n${registry.itemBody(rule).trim()}`), { contributionId: `${owner(rule)}/${rule.id}`, cut: section.cut })
      }
      continue
    }
    const plugin = descriptors.find((descriptor) => descriptor.sections?.some((declared) => declared.id === section.id))
    if (!plugin) unattributed.push({ kind: 'section', id: section.id })
    const name = plugin?.sections?.find((declared) => declared.id === section.id)?.name ?? section.title
    item(plugin?.id ?? '', 'instruction', name, delivery, section.size, { contributionId: plugin ? `${plugin.id}/instruction/${name}` : null, cut: section.cut })
  }

  // A skill's or a prompt's own text is loaded only when it is used.
  for (const entry of active.filter((candidate) => candidate.kind === 'skills' || candidate.kind === 'prompts')) {
    item(owner(entry), entry.kind === 'skills' ? 'skill' : 'command', entry.name, 'on-demand', size(entry.path), { contributionId: `${owner(entry)}/${entry.id}` })
  }

  const names = [...input.tools]
  const extensionToolNames = new Set(input.plugins.filter((plugin) => ['project', 'package', 'shared', 'home'].includes(plugin.source)).flatMap((plugin) => plugin.contributions.filter((entry) => entry.kind === 'tool' && entry.state === 'on').map((entry) => entry.name)))
  for (const name of [ASK_USER, PLUGIN_PROPOSE, ...WIKI_TOOL_NAMES, ...(input.connections ? ['mcp_list_tools', 'mcp_call_tool'] : [])]) if (!names.includes(name)) names.push(name)
  for (const name of names) {
    if (extensionToolNames.has(name)) continue
    const plugin = descriptors.find((descriptor) => descriptor.tools?.some((tool) => tool.name === name))
    if (!plugin) unattributed.push({ kind: 'tool', id: name })
    item(plugin?.id ?? '', 'tool', name, 'tool', null, { contributionId: plugin ? `${plugin.id}/tool/${name}` : null })
  }

  if (input.connections) {
    for (const connection of input.saved.filter((candidate) => allowed(candidate, { agentId: context.agentId ?? null, projectId: context.projectId ?? null }))) {
      item('connected-apps', 'connection', connection.name || connection.id, 'tool', null, { contributionId: `connected-apps/connection/${connection.id}` })
    }
  }

  // What the harness found on disk and lets load. Pi's command's own extensions exist only in a terminal.
  const delivered: Record<Contribution['kind'], InventoryItem['delivery']> = { code: 'code', skill: 'on-demand', command: 'on-demand', instruction: 'system', theme: 'code', tool: 'tool', connection: 'tool' }
  const terminal = context.surface === 'cli'
  for (const plugin of input.plugins) {
    if (!['project', 'package', 'shared', 'home', 'pi'].includes(plugin.source)) continue
    for (const found of plugin.contributions) {
      if (found.state !== 'on' || (plugin.source === 'pi' && (found.kind !== 'code' || !terminal)) || (found.kind === 'theme' && !terminal)) continue
      item(plugin.id, found.kind, found.name, found.background ? 'background' : delivered[found.kind], ['instruction', 'skill', 'command'].includes(found.kind) ? size(found.path) : null, { contributionId: found.id })
    }
  }
  // The harness's own switched-on extensions.
  for (const plugin of input.plugins) {
    if (plugin.source !== 'builtin') continue
    for (const own of plugin.contributions) if (own.kind === 'code' && own.state === 'on') item(plugin.id, 'code', own.name, 'code', null, { contributionId: own.id })
  }
  item('pi', 'instruction', 'Base prompt', 'system', null)

  const used = new Set(items.map((entry) => entry.pluginId))
  return { plugins: input.plugins.filter((plugin) => used.has(plugin.id)), others: input.plugins.filter((plugin) => !used.has(plugin.id)), items, unattributed, systemChars, contextChars }
}
