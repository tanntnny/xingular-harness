// Every plugin there is, from every source, as one list. Building it reads files and settings;
// it runs no plugin's code and changes nothing.
import { basename, dirname, join } from 'node:path'

import { projectsOrNone } from '../core/projects'
import { compareText } from '../core/text'
import type { Connection } from '../mcp/types'
import * as registry from '../skills/registry'
import { attached, describe, type Attachment, type Attachments, type AttachScope } from './attachments'
import { INCLUDED_PLUGIN, YOURS_PLUGIN } from './builtin'
import { settingValue } from './firstParty'
import { BUILTIN_PREFIX, type Found } from './discover'
import { registrationHash } from './runtime'
import { contributionId, describeFound, FOUND_KINDS, packageManifest, pluginIdOf } from './identity'
import type { HookStatus } from './hooks'
import { loads, switchable, trustedBy, type Loading, type Registered, type Trusted } from './plugins'
import type { Contribution, ContributionKind, Plugin, PluginDescriptor, PluginSource } from './types'

export interface CatalogueInput {
  root: string
  /** The harness's own parts, then the application's. */
  descriptors: readonly PluginDescriptor[]
  /** Ids of the descriptors the application supplied. */
  application: ReadonlySet<string>
  connections: readonly Connection[]
  /** What was found for one account and working folder, or `null` when there is no account yet. */
  loading: Loading | null
  /** The working folder the list is for. Without one, nothing a folder brings is listed. */
  cwd: string | null
  /** The folder every account shares. */
  sharedDir: string
  /** The folder of packages kept with a person's data. */
  packagesDir: string
  /** What each hooks file listens for and how its last run went, by its path. */
  hooks: Record<string, HookStatus>
  registered: Record<string, Registered>
  /** The choices a person made about what is switched on. */
  attachments: Attachments
  /** Whose list this is. With an agent or a project, each state is what that caller gets. */
  caller: AttachScope
}

const REGISTRY_KINDS: Record<string, ContributionKind> = { rules: 'instruction', skills: 'skill', prompts: 'command' }

const contribution = (plugin: string, kind: ContributionKind, name: string, rest: Partial<Contribution> = {}): Contribution => ({
  id: contributionId(plugin, kind, name),
  kind,
  name,
  description: '',
  path: null,
  state: 'on',
  scope: null,
  attachment: null,
  registered: null,
  problem: null,
  background: false,
  ...rest
})

function fromDescriptor(descriptor: PluginDescriptor, source: PluginSource, attachments: Attachments | null = null, caller: AttachScope = {}): Plugin {
  const switchable = descriptor.switchable && attachments ? descriptor.switchable : null
  const on = switchable ? attached(attachments!, [descriptor.id], caller, switchable.on) : true
  return {
    id: descriptor.id,
    title: descriptor.title,
    description: descriptor.description,
    version: null,
    source,
    path: null,
    runsCode: !!descriptor.code?.length,
    trust: 'none',
    code: null,
    install: null,
    extends: [],
    required: descriptor.required ?? null,
    manage: descriptor.manage ?? (descriptor.tools?.length ? 'tools' : null),
    settings: (descriptor.settings ?? []).map((setting) => ({ ...setting, value: settingValue(setting, attachments?.settings[descriptor.id]) })),
    connectorTemplates: descriptor.connectorTemplates ?? [],
    attachment: switchable ? describe(attachments!, descriptor.id, switchable.on) : null,
    contributions: [
      ...(descriptor.code ?? []).map((code) => contribution(descriptor.id, 'code', code.name, { description: code.description, state: on ? 'on' : 'off' })),
      ...(descriptor.sections ?? []).map((section) => contribution(descriptor.id, 'instruction', section.name, { description: section.description ?? '' })),
      ...(descriptor.tools ?? []).map((tool) => contribution(descriptor.id, 'tool', tool.name, { description: tool.description ?? '' }))
    ]
  }
}

const named = (ids: readonly string[], names: Map<string, string>): string[] => ids.flatMap((id) => (names.has(id) ? [names.get(id)!] : []))
const counted = (count: number, word: string): string => (count ? `${count} ${word}${count === 1 ? '' : 's'}` : '')

/** Who something is switched on for, in words; `null` when it is on for nobody. */
function scopeWords(attachment: Attachment, projects: Map<string, string>): string | null {
  if (attachment.global) {
    const except = [counted(attachment.off.agentIds.length, 'agent'), ...named(attachment.off.projectIds, projects)].filter(Boolean)
    return except.length ? `Everywhere except ${except.join(', ')}` : 'Everywhere'
  }
  const parts = [...named(attachment.on.projectIds, projects), counted(attachment.on.agentIds.length, 'agent')].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** A person's registry items, and the built-in ones, as contributions with who each is on for. */
function registryContributions(input: CatalogueInput, projects: Map<string, string>): { yours: Contribution[]; included: Contribution[] } {
  const yours: Contribution[] = []
  const included: Contribution[] = []
  const scoped = !!(input.caller.agentId || input.caller.projectId)
  for (const item of registry.list(input.root)) {
    const kind = REGISTRY_KINDS[item.kind]
    if (!kind) continue
    // A registry item's choices are stored under its own id, whichever plugin lists it.
    const attachment = describe(input.attachments, item.id, !!item.builtin)
    const scope = scopeWords(attachment, projects)
    const on = scoped ? attached(input.attachments, [item.id], input.caller, !!item.builtin) : scope !== null
    const plugin = item.builtin ? INCLUDED_PLUGIN.id : YOURS_PLUGIN.id
    ;(item.builtin ? included : yours).push({ ...contribution(plugin, kind, item.name, { description: item.description, path: item.path, state: on ? 'on' : 'off', scope, attachment }), id: `${plugin}/${item.id}` })
  }
  return { yours, included }
}

/** A connection keeps its own scope; this is the same shape for a screen. */
function connectionAttachment(connection: Connection): Attachment | null {
  if (!connection.enabled) return null
  return { global: connection.global, on: { agentIds: connection.agentIds, projectIds: connection.projectIds }, off: { agentIds: connection.excludedAgentIds, projectIds: connection.excludedProjectIds } }
}

function connectionScope(connection: Connection): string | null {
  if (!connection.enabled) return null
  if (connection.global) return 'Everywhere'
  const parts = [counted(connection.agentIds.length, 'agent'), counted(connection.projectIds.length, 'project')].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

const CONTEXT_NOTES: Record<string, string> = {
  'SYSTEM.md': "Replaces Pi's base prompt.",
  'APPEND_SYSTEM.md': "Added to the end of Pi's base prompt."
}

/** What an extension added, in a line; or that no session has loaded it yet. */
function registeredLine(entry: Registered | undefined): string {
  if (!entry) return 'Not loaded in a session yet, so what it adds is not known.'
  const parts = [
    entry.commands.length ? `commands ${entry.commands.map((name) => `/${name}`).join(', ')}` : '',
    entry.tools.length ? `tools ${entry.tools.join(', ')}` : '',
    entry.hooks.length ? `hooks ${entry.hooks.join(', ')}` : '',
    entry.flags.length ? `flags ${entry.flags.map((name) => `--${name}`).join(', ')}` : '',
    entry.shortcuts.length ? `shortcuts ${entry.shortcuts.join(', ')}` : ''
  ].filter(Boolean)
  return parts.length ? `Adds ${parts.join('; ')}.` : 'Registers nothing a session can see.'
}

function foundContribution(plugin: string, item: Found, trusted: Trusted, input: CatalogueInput, projects: Map<string, string>): Contribution {
  const kind = FOUND_KINDS[item.kind]
  const { name, description } = describeFound(item)
  const id = contributionId(plugin, kind, name)
  // A hook runs for everyone or not at all: it follows its plugin's switch for everyone and has none of its own.
  const attachment = switchable(item) && item.kind !== 'hook' ? describe(input.attachments, id, attached(input.attachments, [plugin], {}, true)) : null
  const on = item.kind === 'hook' ? attached(input.attachments, [plugin], {}, true) : !attachment || attached(input.attachments, [id, plugin], input.caller, true)
  const state = !item.enabled || !on ? 'off' : loads(item, trusted) ? 'on' : 'untrusted'
  const rest = { state, attachment, scope: attachment ? scopeWords(attachment, projects) : null } as const
  if (item.path.startsWith(BUILTIN_PREFIX)) return contribution(plugin, kind, name, { ...rest, description: 'Built into the pi command. A terminal session loads it; other sessions do not have it.' })
  if (item.kind === 'extension') {
    const observed = input.registered[item.path]
    const hash = input.loading ? registrationHash(input.loading, item.path) : null
    const current = observed && hash !== null && observed.hash === hash ? observed : undefined
    return contribution(plugin, kind, name, { ...rest, description: registeredLine(current), path: item.path, registered: current ?? null })
  }
  if (item.kind === 'hook') {
    const status = input.hooks[item.path]
    const events = status?.events ?? []
    const described = events.length ? `Runs in the background after: ${events.join(', ')}.` : state === 'on' ? 'Runs in the background. It has not said what it listens for yet.' : 'Runs in the background once it is switched on for everyone and trusted.'
    return contribution(plugin, kind, name, { ...rest, description: described, path: item.path, problem: status?.lastError ?? null, background: true })
  }
  if (item.kind === 'context') return contribution(plugin, kind, name, { ...rest, description: CONTEXT_NOTES[basename(item.path)] ?? 'Read by Pi at the start of every session in this folder.', path: item.path })
  return contribution(plugin, kind, name, { ...rest, description: description ?? '', path: item.path })
}

const empty = (id: string, title: string, description: string, source: PluginSource, path: string | null): Plugin => ({ id, title, description, version: null, source, path, runsCode: false, trust: 'none', code: null, install: null, extends: [], required: null, manage: 'files', settings: [], connectorTemplates: [], attachment: null, contributions: [] })

export function catalogue(input: CatalogueInput): Plugin[] {
  const plugins = new Map<string, Plugin>()
  for (const descriptor of input.descriptors) plugins.set(descriptor.id, fromDescriptor(descriptor, descriptor.id === 'pi' ? 'pi' : descriptor.id === YOURS_PLUGIN.id ? 'yours' : input.application.has(descriptor.id) ? 'application' : 'builtin', input.attachments, input.caller))

  const projects = new Map(projectsOrNone(input.root).map((project) => [project.id, project.name]))
  const items = registryContributions(input, projects)
  const yours = plugins.get(YOURS_PLUGIN.id)
  if (yours) {
    yours.path = join(input.root, 'registry')
    yours.contributions.push(...items.yours)
  }
  if (items.included.length) plugins.set(INCLUDED_PLUGIN.id, { ...fromDescriptor(INCLUDED_PLUGIN, 'builtin'), contributions: items.included })

  const apps = plugins.get('connected-apps')
  if (apps) {
    for (const connection of input.connections) {
      const scope = connectionScope(connection)
      apps.contributions.push({ ...contribution(apps.id, 'connection', connection.name || connection.id, { description: connection.serverName ?? connection.url ?? connection.command, state: scope ? 'on' : 'off', scope, attachment: connectionAttachment(connection) }), id: `${apps.id}/connection/${connection.id}` })
    }
  }

  const loading = input.loading
  const trusted = trustedBy(loading)
  for (const item of loading?.found ?? []) {
    if (item.project && !input.cwd) continue
    const id = pluginIdOf(item)
    let plugin = plugins.get(id)
    if (!plugin) {
      if (item.origin === 'builtin') continue
      if (item.packageRoot) {
        const manifest = packageManifest(item.packageRoot)
        // A package a working folder's settings name is that folder's to remove, not a person's install.
        const install = item.project ? null : item.packageRoot.startsWith(`${input.packagesDir}/`) ? ({ kind: 'folder', source: item.packageRoot } as const) : item.source ? ({ kind: 'settings', source: item.source } as const) : null
        // Only parts that exist can be extended; a made-up name is dropped.
        const extended = manifest.extends.filter((part) => input.descriptors.some((descriptor) => descriptor.id === part))
        plugin = { ...empty(id, manifest.name, manifest.description, item.project ? 'project' : 'package', item.packageRoot), version: manifest.version, install, extends: extended, connectorTemplates: manifest.connectorTemplates }
      } else if (item.origin === 'home') plugin = empty(id, 'Home folder skills', 'Skills in the .agents folder of your home folder. Pi reads them for every account.', 'home', dirname(dirname(item.path)))
      else if (item.origin === 'project') plugin = empty(id, 'Project folder', 'Found in the working folder: its .pi and .agents folders, and the instruction files Pi reads on the way up from it.', 'project', input.cwd)
      else plugin = empty(id, 'Shared Pi folder', 'Extensions, skills, prompts and instruction files in the folder every account shares.', 'shared', input.sharedDir)
      plugin.attachment = describe(input.attachments, id, true)
      plugins.set(id, plugin)
    }
    const added = foundContribution(plugin.id, item, trusted, input, projects)
    if (plugin.contributions.some((existing) => existing.id === added.id)) continue
    plugin.contributions.push(added)
    if (item.kind === 'extension' && added.registered) {
      const registered = added.registered
      const append = (kind: ContributionKind, name: string, rest: Partial<Contribution> = {}) => {
        const id = contributionId(plugin!.id, kind, name)
        if (!plugin!.contributions.some((existing) => existing.id === id)) plugin!.contributions.push(contribution(plugin!.id, kind, name, { state: added.state, description: `Registered by ${added.name}. Observed ${registered.seenAt ?? 'in a session'}.`, ...rest }))
      }
      for (const name of registered.tools) append('tool', name)
      for (const name of registered.commands) append('command', name)
      for (const resource of registered.resources ?? []) {
        const id = contributionId(plugin.id, resource.kind, resource.name)
        const on = attached(input.attachments, [id, plugin.id], input.caller, true)
        append(resource.kind, resource.name, { path: resource.path, state: on ? added.state : 'off', attachment: describe(input.attachments, id, attached(input.attachments, [plugin.id], {}, true)) })
      }
    }
    if (added.kind === 'code' && item.origin !== 'builtin') {
      plugin.runsCode = true
      // A working folder's code and an installed package's wait for trust; a loose file in the
      // shared folder was placed by the person.
      const code = item.project ? loading?.projectCode : item.packageRoot ? loading?.packageCode[item.packageRoot] : null
      if (code) {
        plugin.trust = code.trusted ? 'trusted' : 'untrusted'
        plugin.code = { hash: code.hash, files: code.files }
      }
    }
  }

  const order: PluginSource[] = ['project', 'package', 'shared', 'home', 'yours', 'application', 'builtin', 'pi']
  return [...plugins.values()].sort((left, right) => order.indexOf(left.source) - order.indexOf(right.source) || compareText(left.title, right.title))
}
