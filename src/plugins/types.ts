// What a person sees of everything that shapes a session. A plugin is a bundle with a title and
// a description; its contributions are the instructions, skills, commands, tools, connections,
// code and themes it brings.
import type { Attachment } from './attachments'
import type { Registered } from './plugins'
import type { ProjectCode } from './trust'

export const CONTRIBUTION_KINDS = ['instruction', 'skill', 'command', 'tool', 'connection', 'code', 'theme'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/**
 * Where a plugin comes from: the harness itself, the embedding application, Pi, a person's own
 * registry, the folder every account shares, an installed package, the working folder, or the
 * home folder.
 */
export const PLUGIN_SOURCES = ['builtin', 'application', 'pi', 'yours', 'shared', 'package', 'project', 'home'] as const
export type PluginSource = (typeof PLUGIN_SOURCES)[number]

/** `untrusted` is code that is found and does not load until a person trusts it. */
export type ContributionState = 'on' | 'off' | 'untrusted'

export interface Contribution {
  /** `<plugin id>/<kind>/<name>`. */
  id: string
  kind: ContributionKind
  name: string
  description: string
  path: string | null
  state: ContributionState
  /** Who it is switched on for, in words: "Everywhere", a project's name, "2 agents". */
  scope: string | null
  /** Where it is switched on and off, or `null` when it cannot be switched on its own. */
  attachment: Attachment | null
  /** What a code contribution registered the last time a session loaded it. */
  registered: Registered | null
  /** What went wrong the last time it ran, for code the harness runs itself. */
  problem: string | null
  /** Code the harness runs itself after a change, for everyone, outside any session. */
  background: boolean
}

/** Where a person changes a plugin today. */
export type PluginManage = 'registry' | 'tools' | 'connections' | 'files'

export interface Plugin {
  id: string
  title: string
  description: string
  version: string | null
  source: PluginSource
  path: string | null
  runsCode: boolean
  trust: 'none' | 'trusted' | 'untrusted'
  /** The code a person is asked to trust, for a working folder's own. */
  code: ProjectCode | null
  /**
   * How a person installed it, when it can be removed here: named in the settings every account
   * shares (`source` is the name there), or a folder kept with their data (`source` is its path).
   */
  install: { kind: 'settings' | 'folder'; source: string } | null
  /** The parts it adds to, by plugin id: a package that says it extends Memory, the Wiki or History. */
  extends: string[]
  /** Why it cannot be removed, or `null` when it can. */
  required: string | null
  manage: PluginManage | null
  /** Numbers a person can set on it, each with its current value. */
  settings: (PluginSetting & { value: number })[]
  /** Declarative connector setup templates; listing one never creates or enables a connection. */
  connectorTemplates: ConnectorTemplate[]
  /** Where the whole plugin is switched on and off, or `null` when only its parts are, or nothing is. */
  attachment: Attachment | null
  /** Where it works best, for a plugin that works better in a host. */
  surfaces?: PluginSurfaces | null
  contributions: Contribution[]
}

/** A number a person can set on a plugin, such as a limit. */
export interface PluginSetting {
  key: string
  label: string
  description: string
  default: number
  min: number
  max: number
}

/** A remote connector setup form. It contains no endpoint credentials or saved connection state. */
export interface ConnectorTemplate {
  id: string
  name: string
  description: string
  url: string
  auth: 'none' | 'headers' | 'oauth'
  oauthClient: 'dynamic' | 'user' | null
  oauthScopes: string[]
  docsUrl: string | null
  fields: { header: string; label: string; prefix: string; help: string }[]
  setup: string[]
  notice: string | null
}

/** What a part of the harness, or the embedding application, says about itself. Data only. */
export interface PluginDescriptor {
  id: string
  title: string
  description: string
  /** Why it cannot be removed. */
  required?: string
  manage?: PluginManage
  tools?: { name: string; description?: string }[]
  /** The prompt sections it writes. */
  sections?: { id: string; name: string; description?: string }[]
  /** The tool groups whose paragraph in the tools section it writes. */
  toolGroups?: string[]
  /** It ships with the harness and a person may switch it. `on` is its state until they do. */
  switchable?: { on: boolean }
  /** Numbers a person can set on it. */
  settings?: PluginSetting[]
  /** Remote connector setup templates; users must add, configure and enable each connection. */
  connectorTemplates?: ConnectorTemplate[]
  /** Code of its own that runs in a session. */
  code?: { name: string; description: string }[]
  /** Where it works best, when that is not everywhere alike (PROP-0039). Never a category. */
  surfaces?: PluginSurfaces
}

/**
 * A plugin that works better in a host such as a desktop application: an add-on there. The
 * capability is the same in both; the host adds presentation or a native backend the terminal
 * cannot have. `terminal` says what the terminal offers instead (INV-PAR-3).
 */
export interface PluginSurfaces {
  preferred: 'host'
  terminal: 'fallback' | 'unavailable'
  /** One sentence for a person: what the host adds, and what the terminal does instead. */
  note: string
}

export type Delivery = 'system' | 'context' | 'tool' | 'on-demand' | 'code' | 'background'

/** One thing that reaches a caller. */
export interface InventoryItem {
  pluginId: string
  contributionId: string | null
  kind: ContributionKind
  name: string
  /** `system` is the stable prefix, `context` an update sent with a request, `on-demand` text a tool loads, `background` code the harness runs after a change. */
  delivery: Delivery
  /** Characters it adds to what the model is told, when that is known. */
  chars: number | null
  /** Its text was cut to fit a budget. */
  cut: boolean
}

export interface Inventory {
  /** The plugins the items belong to. */
  plugins: Plugin[]
  /** Every other plugin, with nothing reaching this caller: what could still be switched on for it. */
  others: Plugin[]
  items: InventoryItem[]
  /** Prompt sections, tool groups and tools that no plugin accounts for. */
  unattributed: { kind: 'section' | 'toolGroup' | 'tool'; id: string }[]
  systemChars: number
  contextChars: number
}
