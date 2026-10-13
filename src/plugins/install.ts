// Installing, updating and removing a package. Pi's own package manager does the work, against
// the settings every account shares, so the `pi` command and the harness agree on what is
// installed. Fetching runs none of a package's code, and what was installed is switched off and
// untrusted until a person has looked at it.
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { ensureSharedDir } from '../accounts/env'
import { invalid, notFound } from '../core/errors'
import { now } from '../core/fs'
import type { Harness } from '../harness'
import { ensureAdopted, list, type PluginScope } from './api'
import * as attachments from './attachments'
import { withoutInstallScripts } from './discover'
import type { Plugin } from './types'

/** A folder on this machine, or a package as Pi's settings name it. A bare name is an npm package. */
export function normalizeSource(input: string): string {
  const source = input.trim()
  if (!source) throw invalid('Name a package: a folder, an npm name, or a git address.')
  if (source.startsWith('~/')) return join(process.env.HOME || homedir(), source.slice(2))
  if (isAbsolute(source)) return resolve(source)
  if (source.startsWith('./') || source.startsWith('../')) throw invalid('Give the whole path of the folder.')
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(source) ? source : `npm:${source}`
}

async function manager(harness: Harness) {
  const pi = await import('@earendil-works/pi-coding-agent')
  // The shared folder is where `settings.json` really is; an account's own is a link to it.
  const agentDir = ensureSharedDir(harness.accounts.dir)
  const settings = pi.SettingsManager.create(harness.stateDir, agentDir)
  return { settings, packages: new pi.DefaultPackageManager({ cwd: harness.stateDir, agentDir, settingsManager: settings }) }
}

const changed = (harness: Harness): void => harness.bus.emit({ type: 'plugins.changed' })

/**
 * Installs a package for every account. It arrives switched off, and if it brings code, not
 * trusted: nothing of it reaches a session until a person switches it on and trusts it.
 */
export async function install(harness: Harness, params: PluginScope & { source: string }): Promise<Plugin[]> {
  const source = normalizeSource(params.source)
  if (isAbsolute(source) && !(existsSync(source) && statSync(source).isDirectory())) throw invalid('That folder does not exist.')
  // What was already there is taken over as trusted before anything new arrives, never after.
  await ensureAdopted(harness)
  const before = new Set((await list(harness, params)).map((plugin) => plugin.id))
  const { settings, packages } = await manager(harness)
  if (isAbsolute(source)) {
    // Pi would save a folder as a path relative to the settings file, and each account reads
    // that file through a link in its own folder, where a relative path points somewhere else.
    const named = settings.getGlobalSettings().packages ?? []
    if (!named.some((entry) => (typeof entry === 'string' ? entry : entry.source) === source)) settings.setPackages([...named, source])
    await settings.flush()
  } else {
    await withoutInstallScripts(() => packages.installAndPersist(source))
  }
  const after = await list(harness, params)
  const added = after.filter((plugin) => plugin.install && !before.has(plugin.id))
  if (added.length) {
    const choices = attachments.load(harness.env.root)
    for (const plugin of added) attachments.set(choices, [plugin.id], {}, false, true)
    attachments.save(harness.env.root, choices)
  }
  changed(harness)
  return added.length ? list(harness, params) : after
}

function installed(plugins: readonly Plugin[], pluginId: string): Plugin & { install: NonNullable<Plugin['install']> } {
  const plugin = plugins.find((candidate) => candidate.id === pluginId)
  if (!plugin) throw notFound('Plugin')
  if (!plugin.install) throw invalid(`${plugin.title} was not installed as a package, so it cannot be removed or updated here.`)
  return plugin as Plugin & { install: NonNullable<Plugin['install']> }
}

/** Removes an installed package. One kept as a folder beside a person's data is moved to the trash there. */
export async function remove(harness: Harness, params: PluginScope & { pluginId: string }): Promise<Plugin[]> {
  const plugin = installed(await list(harness, params), params.pluginId)
  if (plugin.install.kind === 'folder') {
    const trash = join(harness.env.root, 'trash', 'plugins')
    mkdirSync(trash, { recursive: true })
    renameSync(plugin.install.source, join(trash, `${basename(plugin.install.source)}-${now().replace(/[:.]/g, '-')}`))
  } else {
    await (await manager(harness)).packages.removeAndPersist(plugin.install.source)
  }
  const choices = attachments.load(harness.env.root)
  for (const scope of [choices.global, ...Object.values(choices.agents), ...Object.values(choices.projects)]) {
    scope.on = scope.on.filter((id) => id !== plugin.id && !id.startsWith(`${plugin.id}/`))
    scope.off = scope.off.filter((id) => id !== plugin.id && !id.startsWith(`${plugin.id}/`))
  }
  delete choices.settings[plugin.id]
  attachments.save(harness.env.root, choices)
  if (plugin.code) harness.plugins.trust.revoke(plugin.code.hash)
  changed(harness)
  return list(harness, params)
}

/** Fetches a newer version of one installed package, or of all of them. Changed code waits for trust again. */
export async function update(harness: Harness, params: PluginScope & { pluginId?: string | null }): Promise<Plugin[]> {
  const plugin = params.pluginId ? installed(await list(harness, params), params.pluginId) : null
  if (plugin?.install.kind === 'folder') throw invalid(`${plugin.title} is a folder on this machine. Change its files to update it.`)
  const { packages } = await manager(harness)
  await withoutInstallScripts(() => packages.update(plugin?.install.source))
  changed(harness)
  return list(harness, params)
}
