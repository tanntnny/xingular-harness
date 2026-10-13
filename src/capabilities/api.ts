// A generic view of what is available to a caller. The existing plugin, registry, and connector
// stores remain the source of truth; this module gives hosts one capability-shaped contract.
import { invalid } from '../core/errors'
import type { Harness } from '../harness'
import type { CallerContext } from '../memory/caller'
import type { Launch } from '../prompt/compile'
import * as pluginApi from '../plugins/api'
import type { Plugin } from '../plugins/types'
import type { Capability, CapabilityCatalogue, CapabilityScope, CapabilitySet } from './types'

export interface ListParams extends CapabilityScope {}

export interface InventoryParams extends CapabilityScope {
  context?: CallerContext
  launch?: Launch
  tools?: string[]
  connections?: boolean
}

const unique = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value.length > 0))]

function contributions(plugins: readonly Plugin[]): Capability[] {
  return plugins.flatMap((plugin) => plugin.contributions.map((item) => ({
    id: item.id,
    pluginId: plugin.id,
    kind: item.kind,
    name: item.name,
    description: item.description,
    source: plugin.source,
    state: item.state,
    attachment: item.attachment
  })))
}

export async function list(harness: Harness, params: ListParams = {}): Promise<CapabilityCatalogue> {
  const plugins = await pluginApi.list(harness, params)
  return { plugins, capabilities: contributions(plugins) }
}

/** The resolved callable set for one caller, based on the stores and caller-supplied tool list. */
export async function resolve(harness: Harness, params: ListParams & { tools?: readonly string[] }): Promise<CapabilitySet> {
  const caller = { agentId: params.agentId ?? null, projectId: params.projectId ?? null }
  const catalogue = await list(harness, params)
  const connectors = harness.apps.connections.forScope(caller).map((connection) => connection.id)
  return {
    version: 1,
    tools: unique(params.tools ?? []),
    connectors: unique(connectors),
    contributions: catalogue.capabilities.filter((item) => item.state === 'on').map((item) => item.id)
  }
}

export function toolIntersection(parent: CapabilitySet, assignee: CapabilitySet, taskTools: readonly string[] = []): CapabilitySet {
  const permitted = new Set(taskTools.length ? taskTools : assignee.tools)
  return {
    version: 1,
    tools: parent.tools.filter((tool) => assignee.tools.includes(tool) && permitted.has(tool)),
    connectors: parent.connectors.filter((id) => assignee.connectors.includes(id)),
    contributions: parent.contributions.filter((id) => assignee.contributions.includes(id))
  }
}

export function inventory(harness: Harness, params: InventoryParams = {}) {
  return pluginApi.inventoryFor(harness, params)
}

export async function attach(harness: Harness, params: pluginApi.AttachParams, on: boolean): Promise<CapabilityCatalogue> {
  const plugins = await pluginApi.attach(harness, params, on)
  return { plugins, capabilities: contributions(plugins) }
}

export async function switchCapability(harness: Harness, params: pluginApi.AttachParams, on: boolean): Promise<CapabilityCatalogue> {
  if (!params.id.trim()) throw invalid('A capability id is required.')
  return attach(harness, params, on)
}
