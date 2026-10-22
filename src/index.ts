// @xingular/harness: a Pi agent harness built on recursive harnessing (Harness², Apache-2.0,
// Google LLC). Each agent runs on a versioned variant of eight components (system prompt,
// guardrails, memory, tool guidance, subagents, skills, scripts, plugins); refinement improves a
// variant from evidence through Propose–Probe–Compose, blind selection and an experience library.
// Around it: multi-account Pi sessions, a compiled prompt with stable-prefix delivery, project
// notes (the Wiki), history, tools with a gate and standing approvals, and connected apps.
//
// An application embeds it with `createHarness` and extends it through prompt sections, tool
// providers, a tool policy, a secret store, a directory of its own names, a description of its
// own parts as plugins, and a refinement host. Everything else is reachable by path.
export { createHarness, Harness, type HarnessOptions, type Recovery } from './harness'
export { hubCatalogSchema, hubEntrySchema, hubOverviewSchema, hubReceiptSchema, type HubCatalog, type HubEntry, type HubOverview, type HubReceipt } from './hub/schema'

export { Bus, log, type Notice } from './core/bus'
export { EMPTY_DIRECTORY, type Directory, type HarnessEnv } from './core/env'
export { HarnessError, invalid, notFound, toErrorShape, type ErrorShape } from './core/errors'
export { findBinary, searchPath } from './core/path'

export { fileSecretStore, memorySecretStore, secretKey, type SecretStore } from './accounts/secrets'
export type { Account, AccountsOverview, Pool } from './accounts/store'
export type { AccountLoginSnapshot, ModelOption } from './accounts/accounts'
export type { ChoicePatch, ModeChoice } from './accounts/choices'
export type { Capability, CapabilityCatalogue, CapabilityKind, CapabilityScope, CapabilitySet } from './capabilities/types'
export type { RunCapabilitySnapshot } from './capabilities/runSnapshot'

export type { CallerContext } from './core/caller'
export { dispatch as harnessCall } from './tools/dispatch'

export {
  compile,
  render,
  SECTION_ORDER,
  CONTEXT_MESSAGE_TYPE,
  CONTEXT_SNAPSHOT_KEY,
  type ContextPack,
  type HostSection,
  type HostToolGroup,
  type Launch,
  type Reference,
  type Section
} from './prompt/compile'

export { runEventSchema, runRecordSchema, isActiveStatus, type ChecklistItem, type RunEvent, type RunEventType, type RunRecord } from './sessions/contracts'
export type { ApprovalFacts, ApprovalPolicy, AutomaticReason } from './sessions/approvals'
export type { ScopeDecision, ToolCall, ToolPolicy } from './sessions/policy'
export type { ActiveRun, ApprovalDecision, ApprovalInput, QuestionAnswer, QuestionInput } from './sessions/registry'
export type { RunFields, SessionRunInput } from './sessions/sessions'
export type { Effort } from './sessions/runner'

export { describeTool, HARNESS_TOOLS, DEFAULT_TOOL_NAMES, WIKI_WRITE, type HarnessCall, type HarnessToolDefinition } from './tools/definitions'
export type { ToolProvider, ToolResult, ToolSession, ToolSpec } from './tools/types'
export { SPAWN_SUBAGENT, SUBAGENT_RELATION } from './tools/spawnSubagent'
export { CHECKLIST_WRITE, checklistOf } from './tools/checklist'
export { continuationOf, type Continuation, type ContinuationBlock } from './sessions/continuation'
export { webTools, WEB_PLUGIN, WEB_SEARCH_KEY, type WebToolOptions } from './web/tools'
export { safeRequest, type WebRequest, type WebResponse } from './web/safeRequest'

export type { BrokeredTools, BrokerSession, BrokerTool } from './mcp/service'
export type { Connection, ConnectionInput, AppOAuthClients } from './mcp/types'

export { configureBuiltins, type ComponentItem, type SkillBundleInput } from './variant/components'

// The variant and refinement.
export { PI_SURFACE, componentOf, type ComponentGroup, type ComponentId, type ComponentInfo, type SurfaceSpec, type Variant } from './variant/surface'
export { validate as validateVariant, autotrigger, diffSummary, VariantError, type VariantCensus, type VariantDiff } from './variant/variant'
export { fingerprint, type Head, type VersionRecord, type VersionSource } from './variant/store'
export { materialise, type VariantChoice, type Materialised } from './variant/materialise'
export { seedVariant, type SeedInput } from './variant/seed'
export type { TrustedPlugin } from './variant/trust'
export { DEFAULT_REFINE_HOST, defaultDeliverable, type RefineHost, type RolloutSession, type RolloutWorkspace } from './refine/host'
export { PROBE_TRIGGER, IMPROVER_TRIGGER, type ImproverSettings } from './refine/pi'
export type { CandidateView, StartInput as RefineStartInput } from './refine/service'
export type { RefineEvent, RefineStatus, RefineSummary } from './refine/runner'
export type { Executor, Improver, RecursionMode, RefineTask, Rollout } from './refine/types'
export type { WorkPrompts } from './refine/prompts'
export type { Experience } from './refine/library'
export type { Note, NoteSummary } from './wiki/notes'

export type { TerminalAssets, TerminalLaunch, TerminalPrepareInput } from './terminal/terminals'

export { attach as attachPlugin, inventoryFor as pluginInventory, list as listPlugins, type AttachParams, type InventoryParams, type PluginScope } from './plugins/api'
export type { Attachment, AttachScope } from './plugins/attachments'
export { HARNESS_PLUGINS } from './plugins/builtin'
export { FIRST_PARTY_PLUGINS } from './plugins/firstParty'
export type { Found, Resolver } from './plugins/discover'
export type { Loading, Registered } from './plugins/plugins'
export { CONTRIBUTION_KINDS, PLUGIN_SOURCES, type ConnectorTemplate, type Contribution, type ContributionKind, type ContributionState, type Delivery, type Inventory, type InventoryItem, type Plugin, type PluginDescriptor, type PluginManage, type PluginSetting, type PluginSource } from './plugins/types'

export { methods } from './server/methods'
export { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './server/remote'
export { PROTOCOL_VERSION, RpcPeer, stdioTransport, type Handler, type Transport } from './server/rpc'
export { attach, serve, type Served } from './server/serve'

export { DEFAULT_SUBAGENT_DEPTH, MAX_SUBAGENT_DEPTH, type SubagentOptions, type SubagentInput } from './sessions/subagents'

export { Subagents } from './sessions/subagentService'
export { WAIT_SUBAGENTS, type SubagentResult, type SubagentSelection } from './sessions/subagents'
