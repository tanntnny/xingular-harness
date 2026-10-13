import type { AttachScope, Attachment } from '../plugins/attachments'
import type { ContributionKind, ContributionState, PluginSource } from '../plugins/types'

export type CapabilityKind = ContributionKind | 'plugin'

/** One item the caller can switch on or off, or that a plugin makes available. */
export interface Capability {
  id: string
  pluginId: string
  kind: CapabilityKind
  name: string
  description: string
  source: PluginSource
  state: ContributionState
  attachment: Attachment | null
}

export interface CapabilityCatalogue {
  plugins: import('../plugins/types').Plugin[]
  capabilities: Capability[]
}

/** The callable capabilities a run starts with. Permission to run still goes through the gate. */
export interface CapabilitySet {
  version: 1
  tools: string[]
  connectors: string[]
  contributions: string[]
}

export interface CapabilityScope extends AttachScope {
  cwd?: string | null
  accountId?: string | null
}
