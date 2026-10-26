import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { describePlugin } from '../plugins/surfaces'
import * as path from 'node:path'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { invalid } from '../core/errors'
import type { Hub } from '../hub/hub'
import type { ConnectedApps } from '../mcp/service'
import { connectionInputSchema } from '../mcp/types'
import type { Plugin } from '../plugins/types'
import * as library from '../variant/components'
import type { Materialised } from '../variant/materialise'
import { PI_SURFACE, componentOf } from '../variant/surface'
import { headVariant } from '../variant/store'
import type { BrowserItem, BrowserSnapshot } from './browser'

const MAX_CONTENT = 256 * 1024

type PathApi = Pick<typeof path, 'relative' | 'sep' | 'isAbsolute'>

export function isWithinBoundary(boundary: string, file: string, pathApi: PathApi = path): boolean {
  const within = pathApi.relative(boundary, file)
  return within !== '..' && !within.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(within)
}

function readText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_CONTENT) throw invalid('Preview requires a regular text file smaller than 256 KiB.')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

export interface BrowserControlOptions {
  root: string
  cwd: string
  pinned: Materialised | null
  writable: boolean
  plugins(): Promise<Plugin[]>
  hub?: Hub
  apps: ConnectedApps
}

/** Only the protected terminal control route calls this adapter. It never loads discovered code. */
export class BrowserControl {
  constructor(private readonly options: BrowserControlOptions) {}

  async snapshot(refresh = false): Promise<BrowserSnapshot> {
    const { root, pinned, apps } = this.options
    const plugins = await this.options.plugins()
    const scope = pinned?.scope ?? null
    const latest = scope ? headVariant(root, scope) : null
    const items: BrowserItem[] = []
    const add = (item: BrowserItem) => items.push(item)
    for (const [id, name, description] of [
      ['runtime', 'Runtime and recording', 'The foundation runs sessions and records their events. Changes require a release.'],
      ['prompt', 'Prompt compiler', 'Assembles the stable prompt and context updates. Variant c1–c4 supply configurable instructions.'],
      ['loader', 'Resource loader', 'Selects plugins and their contributions. Discovered code waits for exact-code trust.'],
      ['gate', 'Tool approval gate', 'Checks capabilities, policy and approvals for every tool call. Availability never grants authorization.'],
      ['accounts', 'Accounts and secrets', 'Keeps account identities isolated and credentials in the secret store.'],
      ['surface', 'Variant surface', 'Defines c1–c8, validation and immutable versions. Only a validated variant version may change.']
    ]) add({ id: `foundation:${id}`, section: 'foundation', name: name!, description: description!, owner: 'Foundation', origin: 'Built-in', status: 'Read-only' })
    for (const plugin of plugins) {
      add({ id: `plugin:${plugin.id}`, section: 'plugins', name: plugin.title, description: describePlugin(plugin),
        owner: plugin.title, origin: plugin.source, status: plugin.required ? 'Required' : plugin.trust === 'untrusted' ? 'Needs trust' : 'Saved configuration',
        pluginId: plugin.id, path: plugin.path ?? undefined, required: plugin.required })
      for (const entry of plugin.contributions) {
        if (!['skill', 'tool', 'command', 'instruction'].includes(entry.kind)) continue
        if ((entry.kind === 'command' || entry.kind === 'instruction') && !entry.path) continue
        const section = entry.kind === 'skill' ? 'skills' : entry.kind === 'tool' ? 'tools' : 'library'
        add({ id: `contribution:${entry.id}`, section, name: entry.name, description: entry.description,
          owner: plugin.title, origin: plugin.source, pluginId: plugin.id, contributionId: entry.id,
          path: entry.path ?? undefined, scope: entry.scope, status: entry.state === 'off' ? 'Disabled' : entry.state === 'untrusted' ? 'Needs trust' : 'Enabled for future sessions',
          read: Boolean(entry.path && ['skill', 'command', 'instruction'].includes(entry.kind)) })
      }
    }
    for (const item of library.list(root)) {
      const added = Boolean(latest && library.isInVariant(root, latest.variant, item.id))
      const existing = items.find(existing => existing.path === item.path)
      if (existing) { existing.componentId = item.id; existing.added = added; continue }
      add({ id: `library:${item.id}`, section: item.kind === 'skills' ? 'skills' : 'library', name: item.name,
        description: item.description, owner: 'Reusable library', origin: item.builtin ? 'Built-in library' : 'Local library', path: item.path,
        componentId: item.id, added, status: added ? 'Saved in latest variant' : 'Library only', read: true })
    }
    const paths = new Set([...Object.keys(pinned?.files ?? {}), ...Object.keys(latest?.variant ?? {})])
    for (const path of [...paths].sort()) {
      const component = PI_SURFACE.components.find(entry => entry.id === componentOf(PI_SURFACE, path))
      if (!component) continue
      const current = pinned?.files[path]
      const future = latest?.variant[path]
      const status = !latest || current === future ? 'Pinned version' : current === undefined ? 'Added in latest' : future === undefined ? 'Removed in latest' : 'Changed in latest'
      add({ id: `variant:${path}`, section: 'variant', name: path, description: `c${component.index} · ${component.title}: ${component.description}`,
        owner: 'Variant', origin: 'Variant', status, read: true })
      if (/^skills\/[^/]+\/SKILL\.md$/.test(path) && current !== undefined) {
        const name = path.split('/')[1]!
        const fullPath = join(pinned!.dir, path)
        if (!items.some(item => item.section === 'skills' && item.path === fullPath)) add({ id: `variant-skill:${path}`, section: 'skills', name,
          description: /^description:\s*(.+)$/m.exec(current)?.[1] ?? '', owner: 'Variant', origin: 'Variant', status: 'Prepared for this session',
          path: fullPath, read: true })
      }
    }
    const connections = apps.connections.list().map(connection => ({ ...connection,
      error: connection.error ? String(apps.connections.scrub(connection.error, connection.id)) : null,
      tools: apps.connections.scrub(connection.tools, connection.id) as unknown[] }))
    for (const connection of connections) add({ id: `connection:${connection.id}`, section: 'connections', name: connection.name || connection.id,
      description: `${connection.kind === 'remote' ? 'Remote HTTP' : 'Local stdio'} MCP · ${connection.tools.length} tools${connection.checkedAt ? ` · last checked ${connection.checkedAt}` : ' · never tested'}`,
      owner: 'Connected apps', origin: connection.kind === 'remote' ? 'Remote' : 'Local', connectionId: connection.id,
      scope: connection.global ? 'Everywhere' : connection.projectIds.join(', ') || 'No project scope',
      status: !connection.enabled ? 'Disabled' : connection.auth === 'oauth' && connection.authState !== 'signed_in' ? 'Sign in required' : connection.error ? 'Last check failed' : connection.checkedAt ? 'Last check passed' : 'Not tested' })
    return { items, plugins, connections, variant: { scope, pinned: pinned?.fingerprint ?? null, latest: latest?.fingerprint ?? null,
      writable: this.options.writable && Boolean(scope && latest) }, hub: this.options.hub ? await this.options.hub.list(refresh) : null }
  }

  async read(id: string, latestVersion = false): Promise<{ content: string }> {
    const { root, pinned } = this.options
    const snapshot = await this.snapshot()
    const item = snapshot.items.find(entry => entry.id === id)
    if (!item?.read) throw invalid('This resource has no inspectable content.')
    if (id.startsWith('variant:') || id.startsWith('variant-skill:')) {
      const path = id.slice(id.indexOf(':') + 1)
      const files = latestVersion && pinned?.scope ? headVariant(root, pinned.scope)?.variant : pinned?.files
      const content = files?.[path] ?? '(File absent in this version.)'
      return { content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) + '\n[Preview truncated.]' : content }
    }
    if (!item.path) throw invalid('This resource has no file.')
    const plugin = snapshot.plugins.find(plugin => plugin.id === item.pluginId)
    const registryItem = item.componentId ? library.list(root).find(entry => entry.id === item.componentId) : undefined
    const boundary = realpathSync(registryItem && !registryItem.builtin ? join(root, 'registry') : plugin?.path ?? dirname(item.path))
    const file = realpathSync(item.path)
    if (!isWithinBoundary(boundary, file)) throw invalid('Resource is outside its owner folder.')
    return { content: readText(file) }
  }

  importSkill(input: string): void {
    const start = resolve(this.options.cwd, input)
    const folder = lstatSync(start).isDirectory() ? start : dirname(start)
    if (start !== folder && basename(start) !== 'SKILL.md') throw invalid('Choose a skill folder or its SKILL.md.')
    const files: library.SkillBundleInput['files'] = []
    let bytes = 0
    let directories = 0
    const visit = (directory: string, depth = 0) => {
      if (++directories > 100 || depth > 16) throw invalid('Skill import exceeds its directory limit.')
      for (const name of readdirSync(directory)) {
        if (name.startsWith('.')) continue
        const path = join(directory, name)
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) throw invalid('Skill imports cannot contain symbolic links.')
        if (stat.isDirectory()) { visit(path, depth + 1); continue }
        if (!stat.isFile() || files.length >= 100 || stat.size > 10 * 1024 * 1024) throw invalid('Skill import exceeds its file limit.')
        bytes += stat.size
        if (bytes > 10 * 1024 * 1024) throw invalid('Skill import exceeds 10 MiB.')
        files.push({ path: relative(folder, path), content: readFileSync(path).toString('base64'), encoding: 'base64' })
      }
    }
    if (lstatSync(folder).isSymbolicLink()) throw invalid('Choose a regular skill folder.')
    visit(folder)
    library.importItems(this.options.root, 'skills', [{ name: basename(folder), files }])
  }

  async connection(action: string, params: Record<string, unknown>): Promise<unknown> {
    const apps = this.options.apps
    if (action === 'appClients') return apps.appClients()
    if (action === 'save') return apps.save(connectionInputSchema.parse(params.input))
    const id = typeof params.id === 'string' ? params.id : ''
    if (!apps.connections.list().some(connection => connection.id === id)) throw invalid('Unknown connection.')
    if (action === 'test') {
      const result = await apps.test(id)
      return { ...result, error: result.error ? String(apps.connections.scrub(result.error, id)) : null,
        tools: apps.connections.scrub(result.tools, id) }
    }
    if (action === 'signIn') return apps.signIn(id)
    if (action === 'signOut') return apps.signOut(id)
    if (action === 'remove') return apps.remove(id)
    throw invalid('Unknown connection action.')
  }
}
