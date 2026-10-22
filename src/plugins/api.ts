// The plugin calls a host makes: the list, what reaches one caller, switching something on or
// off for a scope, and the trust decision.
import { join } from 'node:path'

import { ensureSharedDir, sharedDir } from '../accounts/env'
import { invalid, notFound } from '../core/errors'
import { findProject } from '../core/projects'
import type { Harness } from '../harness'
import type { CallerContext } from '../core/caller'
import type { Launch } from '../prompt/compile'
import { materialise, type VariantChoice } from '../variant/materialise'
import * as attachments from './attachments'
import { catalogue } from './catalogue'
import { inventory } from './inventory'
import type { Loading } from './plugins'
import type { Inventory, Plugin } from './types'

export interface PluginScope {
  /** The working folder to list for. Without one, nothing a folder brings is listed. */
  cwd?: string | null
  /** The account whose Pi folder is searched. Defaults to the default account. */
  accountId?: string | null
  /** Whose list it is. With either, each state is what that agent or project gets. */
  agentId?: string | null
  projectId?: string | null
}

const callerOf = (scope: PluginScope): attachments.AttachScope => ({ agentId: scope.agentId ?? null, projectId: scope.projectId ?? null })

/**
 * What Pi would load for this account and folder. Before the first account exists, the folder
 * every account shares stands in: packages and shared files are the same for all of them.
 * `null` only when the account that was named cannot be found.
 */
export async function loadingFor(harness: Harness, scope: PluginScope): Promise<Loading | null> {
  let agentDir: string
  try {
    agentDir = harness.accounts.context(harness.accounts.resolve(scope.accountId ?? null, null)).configDir
  } catch {
    if (scope.accountId) return null
    agentDir = ensureSharedDir(harness.accounts.dir)
  }
  // Listing never installs anything. Without a working folder the state folder stands in, and
  // what it "brings" is dropped by the catalogue.
  return harness.plugins.loading({ cwd: scope.cwd || harness.stateDir, agentDir, caller: callerOf(scope) })
}

export async function list(harness: Harness, scope: PluginScope = {}): Promise<Plugin[]> {
  return catalogue({
    root: harness.env.root,
    descriptors: harness.descriptors,
    application: harness.applicationPlugins,
    connections: harness.apps.connections.list(),
    loading: await loadingFor(harness, scope),
    cwd: scope.cwd || null,
    sharedDir: sharedDir(harness.accounts.dir),
    packagesDir: join(harness.env.root, 'plugins'),
    registered: harness.plugins.registered(),
    hooks: harness.hooks.status(),
    attachments: attachments.load(harness.env.root),
    caller: callerOf(scope)
  })
}

export interface InventoryParams extends PluginScope {
  context?: CallerContext
  launch?: Launch
  tools?: string[]
  connections?: boolean
  /** The variant the caller runs, so what it adds is listed too. */
  variant?: VariantChoice | null
}

export async function inventoryFor(harness: Harness, params: InventoryParams): Promise<Inventory> {
  return inventory({
    env: harness.env,
    context: params.context ?? {},
    launch: params.launch ?? {},
    tools: Array.isArray(params.tools) ? params.tools : [],
    connections: params.connections !== false,
    // What is switched off for the caller is not in what reaches it.
    plugins: await list(harness, { ...params, agentId: params.agentId ?? params.context?.agentId ?? null, projectId: params.projectId ?? params.context?.projectId ?? null }),
    descriptors: harness.descriptors,
    saved: harness.apps.connections.list(),
    variant: params.variant ? materialise(harness.env.root, params.variant, { trust: harness.trust }) : null
  })
}

/**
 * Trusts code a person was shown, if it is still that code: a working folder's own, or an
 * installed package's. The hash names which; a folder is needed only for the working folder's.
 */
export async function trust(harness: Harness, scope: PluginScope & { hash: string }): Promise<Plugin[]> {
  const loading = await loadingFor(harness, scope)
  const project = scope.cwd && loading?.projectCode?.hash === scope.hash ? { code: loading.projectCode, folder: scope.cwd } : null
  const packaged = Object.entries(loading?.packageCode ?? {}).find(([, code]) => code.hash === scope.hash)
  const match = project ?? (packaged ? { code: packaged[1], folder: packaged[0] } : null)
  if (!match) throw invalid('This code changed since it was shown. Review it again before trusting it.')
  harness.plugins.trust.grant({ hash: match.code.hash, files: match.code.files }, match.folder)
  return list(harness, scope)
}

export async function untrust(harness: Harness, scope: PluginScope & { hash: string }): Promise<Plugin[]> {
  harness.plugins.trust.revoke(scope.hash)
  return list(harness, scope)
}

export interface AttachParams extends PluginScope {
  /** A plugin's id, or one contribution's. */
  id: string
  /** Who the switch is for. Neither id means everywhere. */
  scope?: attachments.AttachScope | null
}

/**
 * Switches a plugin, or one thing it brings, on or off: everywhere, for one agent, or for one
 * project. A required part refuses and says why. Nothing here grants a permission: a tool that
 * is switched on still passes the gate.
 */
export async function attach(harness: Harness, params: AttachParams, on: boolean): Promise<Plugin[]> {
  const { root } = harness.env
  const scope: attachments.AttachScope = { agentId: params.scope?.agentId || null, projectId: params.scope?.projectId || null }
  if (scope.projectId) findProject(root, scope.projectId)
  const plugins = await list(harness, params)
  const plugin = plugins.find((candidate) => candidate.id === params.id || candidate.contributions.some((entry) => entry.id === params.id))
  if (!plugin) throw notFound('Plugin')
  const contribution = plugin.id === params.id ? null : plugin.contributions.find((entry) => entry.id === params.id)!
  if (plugin.required && contribution?.kind !== 'connection') throw invalid(`${plugin.title} cannot be switched off. ${plugin.required}`)
  if (plugin.source === 'application') throw invalid(`${plugin.title} is switched by the application that provides it.`)
  if (!(contribution ?? plugin).attachment) throw invalid(contribution ? `${contribution.name} cannot be switched on its own.` : `${plugin.title} is switched one item at a time.`)

  if (contribution?.kind === 'connection') {
    harness.apps.attach(contribution.id.slice(`${plugin.id}/connection/`.length), scope, on)
  } else {
    // A choice is stored under the contribution's id and then its plugin's.
    const ids = contribution ? [contribution.id, plugin.id] : [plugin.id]
    // What it is until a person says otherwise: a part that ships switched off is off, and
    // anything found on disk is on.
    const shipped = harness.descriptors.find((descriptor) => descriptor.id === plugin.id)?.switchable
    const fallback = shipped ? shipped.on : true
    const choices = attachments.load(root)
    attachments.set(choices, ids, scope, on, fallback)
    attachments.save(root, choices)
  }
  harness.bus.emit({ type: 'plugins.changed' })
  return list(harness, params)
}

/** Saves the numbers a person set on a plugin. Each must be one of the plugin's settings and inside its range. */
export async function configure(harness: Harness, params: PluginScope & { pluginId: string; settings: Record<string, unknown> }): Promise<Plugin[]> {
  const descriptor = harness.descriptors.find((candidate) => candidate.id === params.pluginId)
  if (!descriptor?.settings?.length) throw invalid('This plugin has no settings.')
  const choices = attachments.load(harness.env.root)
  const saved: Record<string, unknown> = { ...choices.settings[descriptor.id] }
  for (const [key, value] of Object.entries(params.settings ?? {})) {
    const setting = descriptor.settings.find((candidate) => candidate.key === key)
    if (!setting) throw invalid(`${descriptor.title} has no setting called "${key}".`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < setting.min || value > setting.max) throw invalid(`${setting.label} must be a number from ${setting.min} to ${setting.max}.`)
    saved[key] = Math.floor(value)
  }
  choices.settings[descriptor.id] = saved
  attachments.save(harness.env.root, choices)
  harness.bus.emit({ type: 'plugins.changed' })
  return list(harness, params)
}

/**
 * Makes sure the packages that loaded before trust was asked per package were taken over, before
 * something new is written that must not be taken over with them.
 */
export async function ensureAdopted(harness: Harness): Promise<void> {
  if (harness.plugins.trust.adopted) return
  await loadingFor(harness, {})
  if (!harness.plugins.trust.adopted) harness.plugins.trust.adopt([])
}

/** Forgets what was switched for an agent that no longer exists. */
export function forgetAgent(harness: Harness, agentId: string): void {
  const choices = attachments.load(harness.env.root)
  if (!choices.agents[agentId]) return
  attachments.forget(choices, { agentId })
  attachments.save(harness.env.root, choices)
}
